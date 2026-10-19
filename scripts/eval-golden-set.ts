/**
 * Golden-set retrieval eval harness.
 *
 * Runs every question in eval/golden-set.json through the real
 * RetrievalService.searchUnified() (BGE-M3 embed + pgvector + BGE rerank +
 * lawId/room filters, exactly as used in production) against a live DB, and
 * reports recall@k / precision@k / MRR, broken down overall and by
 * lang / type / category.
 *
 * This script only reads eval/golden-set.json and calls the existing public
 * RetrievalService API — no production code is modified. It deliberately
 * avoids importing RagModule (which also wires up AnswerService) so it does
 * not depend on files owned by other in-flight work.
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/lawrag \
 *   REDIS_URL=redis://:redis@localhost:6380 \
 *   npx ts-node scripts/eval-golden-set.ts [--topk 5,10] [--filter q01,q02] [--out eval/results/run.json]
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaModule } from "../src/prisma/prisma.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { CacheModule } from "../src/cache/cache.module";
import { EmbeddingService } from "../src/ingestion/embedding.service";
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
} from "../src/ingestion/ingestion.types";
import { embeddingColumnSql } from "../src/ingestion/embedding-storage";
import { LocalEmbeddingProvider } from "../src/ingestion/local-embedding.provider";
import { RetrievalService } from "../src/rag/retrieval.service";
import { PalaceNavigationService } from "../src/rag/palace-navigation.service";
import { DocumentCategory } from "../src/memory/memory.types";
import {
  ChunkSearchResult,
  RERANKING_PROVIDER,
  RerankingProvider,
} from "../src/rag/rag.types";
import { LocalRerankingProvider } from "../src/rag/local-reranking.provider";
import { QueryPreprocessorService } from "../src/rag/query-preprocessor.service";
import { Prisma } from "@prisma/client";
import {
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  summarizeLatency,
} from "../src/rag/eval-metrics";

// Keep this eval context intentionally narrower than IngestionModule. The
// production module has a fail-closed startup coverage guard; importing it here
// would prevent --allow-partial-index from doing its diagnostic-only job.
@Module({
  imports: [PrismaModule, CacheModule],
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useClass: LocalEmbeddingProvider,
    },
    EmbeddingService,
    {
      provide: RERANKING_PROVIDER,
      useClass: LocalRerankingProvider,
    },
    RetrievalService,
    PalaceNavigationService,
    QueryPreprocessorService,
  ],
})
class EvalModule {}

interface RelevantChunk {
  lawId: string;
  normKey: string;
}

type QuestionType = "explicit_law" | "category_only" | "conversational";
type Lang = "ru" | "de";

interface GoldenQuestion {
  id: string;
  lang: Lang;
  type: QuestionType;
  query: string;
  category?: DocumentCategory;
  relevant: RelevantChunk[];
  note?: string;
}

interface GoldenSetFile {
  version: number;
  description: string;
  questions: GoldenQuestion[];
}

interface QuestionResult {
  id: string;
  lang: Lang;
  type: QuestionType;
  category?: DocumentCategory;
  query: string;
  relevant: RelevantChunk[];
  returned: { lawId: string; normKey: string; similarity: number }[];
  hitRank: number | null; // 1-based rank of first relevant chunk in `returned`, null if not found
  latencyMs: number;
  note?: string;
  /** German search query produced by QueryPreprocessorService (--via-preprocessor). */
  searchQueryUsed?: string;
  error?: string;
}

const TOP_KS = [5, 10];

/** Strips only the trailing chunk-split suffix ("_c0", "_c1", ...) so that any
 * sub-chunk of the same paragraph counts as a hit on that paragraph. */
function normalizeNormKey(normKey: string): string {
  return normKey.replace(/_c\d+$/, "");
}

function isHit(chunk: ChunkSearchResult, relevant: RelevantChunk[]): boolean {
  return relevant.some(
    (r) =>
      r.lawId === chunk.lawId &&
      normalizeNormKey(r.normKey) === normalizeNormKey(chunk.normKey),
  );
}

function parseArgs(argv: string[]): {
  topKs: number[];
  filterIds: Set<string> | null;
  outPath: string;
  allowPartialIndex: boolean;
  viaPreprocessor: boolean;
} {
  let topKs = TOP_KS;
  let filterIds: Set<string> | null = null;
  let allowPartialIndex = false;
  let viaPreprocessor = false;
  let outPath = path.join(
    "eval",
    "results",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--topk" && argv[i + 1]) {
      topKs = argv[i + 1]!.split(",").map((n) => parseInt(n, 10));
      i++;
    } else if (argv[i] === "--filter" && argv[i + 1]) {
      filterIds = new Set(argv[i + 1]!.split(","));
      i++;
    } else if (argv[i] === "--out" && argv[i + 1]) {
      outPath = argv[i + 1]!;
      i++;
    } else if (argv[i] === "--allow-partial-index") {
      allowPartialIndex = true;
    } else if (argv[i] === "--via-preprocessor") {
      viaPreprocessor = true;
    }
  }

  return { topKs, filterIds, outPath, allowPartialIndex, viaPreprocessor };
}

interface Bucket {
  key: string;
  n: number;
  recallAtK: Map<number, number>; // count of hits within top-k
  precisionSumAtK: Map<number, number>;
  ndcgSumAtK: Map<number, number>;
  reciprocalRankSum: number;
  latenciesMs: number[];
}

function newBucket(key: string, topKs: number[]): Bucket {
  const recallAtK = new Map<number, number>();
  const precisionSumAtK = new Map<number, number>();
  const ndcgSumAtK = new Map<number, number>();
  for (const k of topKs) {
    recallAtK.set(k, 0);
    precisionSumAtK.set(k, 0);
    ndcgSumAtK.set(k, 0);
  }
  return {
    key,
    n: 0,
    recallAtK,
    precisionSumAtK,
    ndcgSumAtK,
    reciprocalRankSum: 0,
    latenciesMs: [],
  };
}

function accumulate(bucket: Bucket, result: QuestionResult, topKs: number[]): void {
  bucket.n++;
  const ranked = rankedRelevance(result);
  for (const k of topKs) {
    const hit = recallAtK(ranked, k) === 1;
    if (hit) {
      bucket.recallAtK.set(k, (bucket.recallAtK.get(k) ?? 0) + 1);
      // Single relevant chunk per question in this golden set → precision@k = 1/k on hit.
      bucket.precisionSumAtK.set(
        k,
        (bucket.precisionSumAtK.get(k) ?? 0) + 1 / k,
      );
    }
    bucket.ndcgSumAtK.set(
      k,
      (bucket.ndcgSumAtK.get(k) ?? 0) + ndcgAtK(ranked, result.relevant.length, k),
    );
  }
  bucket.reciprocalRankSum += reciprocalRank(ranked);
  if (!result.error) {
    bucket.latenciesMs.push(result.latencyMs);
  }
}

function summarize(bucket: Bucket, topKs: number[]): Record<string, number> {
  const out: Record<string, number> = { n: bucket.n };
  for (const k of topKs) {
    out[`recall@${k}`] = bucket.n ? (bucket.recallAtK.get(k) ?? 0) / bucket.n : 0;
    out[`precision@${k}`] = bucket.n
      ? (bucket.precisionSumAtK.get(k) ?? 0) / bucket.n
      : 0;
    out[`ndcg@${k}`] = bucket.n ? (bucket.ndcgSumAtK.get(k) ?? 0) / bucket.n : 0;
  }
  out.mrr = bucket.n ? bucket.reciprocalRankSum / bucket.n : 0;
  const latency = summarizeLatency(bucket.latenciesMs);
  out.latencyMeanMs = latency.meanMs;
  out.latencyP50Ms = latency.p50Ms;
  out.latencyP95Ms = latency.p95Ms;
  out.latencyMaxMs = latency.maxMs;
  return out;
}

function rankedRelevance(result: QuestionResult): Array<{ relevant: boolean }> {
  const matchedRelevant = new Set<string>();
  return result.returned.map((chunk) => {
    const relevant = result.relevant.find((candidate) => {
      const key = `${candidate.lawId}\0${normalizeNormKey(candidate.normKey)}`;
      return (
        !matchedRelevant.has(key) &&
        candidate.lawId === chunk.lawId &&
        normalizeNormKey(candidate.normKey) === normalizeNormKey(chunk.normKey)
      );
    });
    if (!relevant) return { relevant: false };
    matchedRelevant.add(`${relevant.lawId}\0${normalizeNormKey(relevant.normKey)}`);
    return { relevant: true };
  });
}

function fmt(n: number): string {
  return n.toFixed(3);
}

async function main(): Promise<void> {
  const { topKs, filterIds, outPath, allowPartialIndex, viaPreprocessor } =
    parseArgs(process.argv.slice(2));

  const goldenPath = path.join(process.cwd(), "eval", "golden-set.json");
  const golden: GoldenSetFile = JSON.parse(fs.readFileSync(goldenPath, "utf8"));

  let questions = golden.questions;
  if (filterIds) {
    questions = questions.filter((q) => filterIds.has(q.id));
  }

  process.stderr.write(
    `Loaded ${questions.length}/${golden.questions.length} questions from ${goldenPath}\n`,
  );

  const app = await NestFactory.createApplicationContext(EvalModule, {
    logger: ["error", "warn"],
  });
  const retrieval = app.get(RetrievalService);
  const prisma = app.get(PrismaService);
  const embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
  const rerankingProvider = app.get<RerankingProvider>(RERANKING_PROVIDER);
  // Only resolved when --via-preprocessor is set; requires ANTHROPIC_API_KEY.
  const queryPreprocessor = viaPreprocessor
    ? app.get(QueryPreprocessorService)
    : null;

  const embeddingColumn = embeddingColumnSql();
  const [coverage] = await prisma.$queryRaw<
    Array<{ total: number; embedded: number }>
  >(Prisma.sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(${embeddingColumn})::int AS embedded
    FROM "LawChunk"
    WHERE "lawId" != 'docvault'
  `);
  const totalRows = coverage?.total ?? 0;
  const embeddedRows = coverage?.embedded ?? 0;
  if (totalRows === 0) {
    await app.close();
    throw new Error("LawChunk corpus is empty; retrieval benchmark cannot run.");
  }
  if (!allowPartialIndex && totalRows !== embeddedRows) {
    await app.close();
    throw new Error(
      `BGE-M3 embedding index is incomplete: ${embeddedRows}/${totalRows} rows. ` +
        "Run the matching backfill/reindex first, or pass --allow-partial-index for diagnostics only.",
    );
  }

  const results: QuestionResult[] = [];

  for (const q of questions) {
    process.stderr.write(`[${q.id}] ${q.query.slice(0, 60)}...`);
    try {
      const t0 = Date.now();
      // No userId: mirrors an anonymous/first-turn query. searchUnified()
      // fail-closes docvault search when userId is absent (see 8b70d1e), so
      // this only ever exercises the law-corpus retrieval path.
      // --via-preprocessor routes the raw query through the production
      // QueryPreprocessorService (formatting + German translation) first,
      // mirroring the chat flow. The golden category filter is kept to
      // isolate the translation effect from category effects.
      let searchQuery = q.query;
      let preprocessorNote: string | undefined;
      if (queryPreprocessor) {
        const preprocessed = await queryPreprocessor.preprocess(q.query);
        searchQuery = preprocessed.rewrittenQuery;
        preprocessorNote = searchQuery;
        process.stderr.write(`\n      de: "${searchQuery.slice(0, 70)}"`);
      }
      const chunks = await retrieval.searchUnified(searchQuery, q.category);
      const ms = Date.now() - t0;

      const returned = chunks.map((c) => ({
        lawId: c.lawId,
        normKey: c.normKey,
        similarity: c.similarity,
      }));

      let hitRank: number | null = null;
      for (let i = 0; i < chunks.length; i++) {
        if (isHit(chunks[i]!, q.relevant)) {
          hitRank = i + 1;
          break;
        }
      }

      results.push({
        id: q.id,
        lang: q.lang,
        type: q.type,
        category: q.category,
        query: q.query,
        relevant: q.relevant,
        returned,
        hitRank,
        latencyMs: ms,
        note: q.note,
        searchQueryUsed: preprocessorNote,
      });

      process.stderr.write(
        ` ${hitRank !== null ? `hit@${hitRank}` : "MISS"} (${ms}ms)\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(` ERROR: ${message}\n`);
      results.push({
        id: q.id,
        lang: q.lang,
        type: q.type,
        category: q.category,
        query: q.query,
        relevant: q.relevant,
        returned: [],
        hitRank: null,
        latencyMs: 0,
        note: q.note,
        error: message,
      });
    }
  }

  await app.close();

  // --- Aggregate ---
  const overall = newBucket("overall", topKs);
  const byLang = new Map<string, Bucket>();
  const byType = new Map<string, Bucket>();
  const byCategory = new Map<string, Bucket>();

  for (const r of results) {
    accumulate(overall, r, topKs);

    if (!byLang.has(r.lang)) byLang.set(r.lang, newBucket(r.lang, topKs));
    accumulate(byLang.get(r.lang)!, r, topKs);

    if (!byType.has(r.type)) byType.set(r.type, newBucket(r.type, topKs));
    accumulate(byType.get(r.type)!, r, topKs);

    const catKey = r.category ?? "(none)";
    if (!byCategory.has(catKey)) byCategory.set(catKey, newBucket(catKey, topKs));
    accumulate(byCategory.get(catKey)!, r, topKs);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    providers: {
      embedding: embeddingProvider.id,
      reranking: rerankingProvider.id,
    },
    indexCoverage: {
      embedded: embeddedRows,
      total: totalRows,
      ratio: totalRows === 0 ? 0 : embeddedRows / totalRows,
    },
    topKs,
    overall: summarize(overall, topKs),
    byLang: Object.fromEntries(
      [...byLang.entries()].map(([k, b]) => [k, summarize(b, topKs)]),
    ),
    byType: Object.fromEntries(
      [...byType.entries()].map(([k, b]) => [k, summarize(b, topKs)]),
    ),
    byCategory: Object.fromEntries(
      [...byCategory.entries()].map(([k, b]) => [k, summarize(b, topKs)]),
    ),
    misses: results
      .filter((r) => r.hitRank === null)
      .map((r) => ({ id: r.id, lang: r.lang, type: r.type, query: r.query, note: r.note, error: r.error })),
  };

  // --- Print report ---
  process.stdout.write("\n=== Golden-set eval summary ===\n");
  process.stdout.write(
    `providers=${embeddingProvider.id} + ${rerankingProvider.id}\n` +
      `index=${embeddedRows}/${totalRows}  n=${overall.n}  ${topKs
        .map(
          (k) =>
            `recall@${k}=${fmt(summary.overall[`recall@${k}`]!)} ndcg@${k}=${fmt(summary.overall[`ndcg@${k}`]!)}`,
        )
        .join("  ")}  mrr=${fmt(summary.overall.mrr!)}  p50=${summary.overall.latencyP50Ms!.toFixed(0)}ms p95=${summary.overall.latencyP95Ms!.toFixed(0)}ms\n`,
  );

  process.stdout.write("\n-- by lang --\n");
  for (const [key, s] of Object.entries(summary.byLang)) {
    process.stdout.write(
      `${key.padEnd(8)} n=${s.n}  ${topKs.map((k) => `recall@${k}=${fmt(s[`recall@${k}`]!)}`).join("  ")}  mrr=${fmt(s.mrr!)}\n`,
    );
  }

  process.stdout.write("\n-- by type --\n");
  for (const [key, s] of Object.entries(summary.byType)) {
    process.stdout.write(
      `${key.padEnd(16)} n=${s.n}  ${topKs.map((k) => `recall@${k}=${fmt(s[`recall@${k}`]!)}`).join("  ")}  mrr=${fmt(s.mrr!)}\n`,
    );
  }

  process.stdout.write("\n-- by category --\n");
  for (const [key, s] of Object.entries(summary.byCategory)) {
    process.stdout.write(
      `${key.padEnd(14)} n=${s.n}  ${topKs.map((k) => `recall@${k}=${fmt(s[`recall@${k}`]!)}`).join("  ")}  mrr=${fmt(s.mrr!)}\n`,
    );
  }

  if (summary.misses.length > 0) {
    process.stdout.write(`\n-- misses (${summary.misses.length}) --\n`);
    for (const m of summary.misses) {
      process.stdout.write(`  [${m.id}] (${m.lang}/${m.type}) ${m.query}\n`);
      if (m.note) process.stdout.write(`    note: ${m.note}\n`);
      if (m.error) process.stdout.write(`    error: ${m.error}\n`);
    }
  }

  // --- Write full results to disk ---
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));
  process.stdout.write(`\nFull results written to ${outPath}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    "FAILED: " + (err instanceof Error ? (err.stack ?? err.message) : String(err)) + "\n",
  );
  process.exit(1);
});
