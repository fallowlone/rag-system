/**
 * Live e2e: owner isolation on POST /admin/docvault/query.
 *
 * Boots a minimal Nest HTTP app with the real AdminController, DocvaultAuthGuard,
 * Zod validation, DocvaultService, RetrievalService, local BGE embedding/reranking
 * and the real Postgres/pgvector + retrieval-models service — but stubs the
 * AnswerService (echoes retrieved chunk normKeys instead of calling Anthropic)
 * and the injection classifier (SAFE). Telegram is not involved, so this can run
 * alongside any deployment without polling conflicts.
 *
 * Cases:
 *  1. ingest for owner A succeeds (guard + zod + raw SQL upsert)
 *  2. query as owner A (with docvaultId) returns A's chunks
 *  3. query as owner B (same docvaultId) returns none of A's chunks
 *  4. query without ownerUserId → 400 (fail-closed)
 *  5. query without docvaultId → generic law search fallback, still no docvault chunks
 *  6. cleanup deletes only owner A's chunks
 *
 * Run: npx ts-node -T scripts/docvault-query-owner-e2e.ts
 */
import "reflect-metadata";
import "dotenv/config";
import * as process from "process";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { CacheService } from "../src/cache/cache.service";
import { EmbeddingService } from "../src/ingestion/embedding.service";
import { EMBEDDING_PROVIDER } from "../src/ingestion/ingestion.types";
import { LocalEmbeddingProvider } from "../src/ingestion/local-embedding.provider";
import { RERANKING_PROVIDER } from "../src/rag/rag.types";
import { LocalRerankingProvider } from "../src/rag/local-reranking.provider";
import { RetrievalService } from "../src/rag/retrieval.service";
import { PalaceNavigationService } from "../src/rag/palace-navigation.service";
import { DocvaultService } from "../src/rag/docvault.service";
import { AnswerService } from "../src/rag/answer.service";
import { InjectionClassifierService } from "../src/rag/injection-classifier.service";
import { AdminController } from "../src/admin/admin.controller";
import { IngestionService } from "../src/ingestion/ingestion.service";
import { MemoryTranslationService } from "../src/memory/memory-translation.service";
import * as crypto from "crypto";

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
// The DocvaultAuthGuard requires a shared secret; the harness is both ends.
process.env.RAG_BOT_SECRET ??= "e2e-harness-secret";

const MarkerChunk = `E2E-OWNER-ISOLATION-MARKER-${crypto.randomUUID().slice(0, 8)}: Dieses Mietvertrag-Dokument gehört ausschließlich Besitzer A und enthält eine sehr spezifische Klausel zur Staffelmiete ab dem dritten Mietjahr.`;
const runId = crypto.randomUUID().slice(0, 8);
const docvaultId = `e2e-owner-${runId}`;
const ownerA = `user-A-${runId}`;
const ownerB = `user-B-${runId}`;

// Echo service: instead of an LLM answer, return the identity of every chunk
// retrieval produced, so assertions are deterministic.

@Module({
  controllers: [AdminController],
  providers: [
    PrismaService,
    CacheService,
    { provide: EMBEDDING_PROVIDER, useClass: LocalEmbeddingProvider },
    EmbeddingService,
    { provide: RERANKING_PROVIDER, useClass: LocalRerankingProvider },
    PalaceNavigationService,
    RetrievalService,
    {
      provide: AnswerService,
      useValue: {
        answerDirect: async (_q: string, chunks: Array<{ normKey: string }>) =>
          JSON.stringify({ retrievedNormKeys: chunks.map((c) => c.normKey) }),
      },
    },
    {
      provide: InjectionClassifierService,
      useValue: { classify: async () => "SAFE" },
    },
    DocvaultService,
    { provide: IngestionService, useValue: {} },
    { provide: MemoryTranslationService, useValue: {} },
  ],
})
class HarnessModule {}

interface HttpResult {
  status: number;
  body: unknown;
}

async function call(
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RAG_BOT_SECRET}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body: parsed };
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ok: ${label}`);
}

async function main(): Promise<void> {
  const logger = new Logger("DocvaultOwnerE2E");
  const app = await NestFactory.create(HarnessModule, { logger: false });
  await app.listen(PORT, "127.0.0.1");
  logger.log(`harness listening on ${BASE}`);

  try {
    // 1. Ingest a document for owner A.
    const ingest = await call("POST", "/admin/docvault/ingest", {
      text: MarkerChunk.repeat(3),
      title: `Owner isolation e2e ${runId}`,
      source: "docvault",
      docvaultId,
      ownerUserId: ownerA,
    });
    assert(ingest.status === 200, `ingest owner A → 200 (${JSON.stringify(ingest.body)})`);
    assert(
      typeof (ingest.body as { chunkCount: number }).chunkCount === "number" &&
        (ingest.body as { chunkCount: number }).chunkCount >= 1,
      "ingest produced >= 1 chunk",
    );

    // Give pgvector rows a moment — ingest is synchronous, so this is only
    // defensive.
    await new Promise((r) => setTimeout(r, 300));

    // 2. Owner A query finds the marker chunks.
    const qA = await call("POST", "/admin/docvault/query", {
      question: "Was regelt die Staffelmiete ab dem dritten Mietjahr?",
      ownerUserId: ownerA,
      docvaultId,
    });
    assert(qA.status === 200, `query owner A → 200 (${JSON.stringify(qA.body)})`);
    const keysA = JSON.parse((qA.body as { answer: string }).answer);
    assert(
      keysA.retrievedNormKeys.length >= 1 &&
        keysA.retrievedNormKeys.every((k: string) => k.startsWith(docvaultId)),
      `owner A sees own chunks (${keysA.retrievedNormKeys.length})`,
    );

    // 3. Owner B query on the same docvaultId must get nothing.
    const qB = await call("POST", "/admin/docvault/query", {
      question: "Was regelt die Staffelmiete ab dem dritten Mietjahr?",
      ownerUserId: ownerB,
      docvaultId,
    });
    assert(qB.status === 200, `query owner B → 200 (${JSON.stringify(qB.body)})`);
    const keysB = JSON.parse((qB.body as { answer: string }).answer);
    assert(
      keysB.retrievedNormKeys.length === 0,
      "owner B sees none of owner A's chunks (cross-owner isolation)",
    );

    // 4. Missing ownerUserId → 400 fail-closed.
    const qNoOwner = await call("POST", "/admin/docvault/query", {
      question: "Was regelt die Staffelmiete?",
      docvaultId,
    });
    assert(qNoOwner.status === 400, `query without ownerUserId → 400, got ${qNoOwner.status}`);

    // 5. Fallback without docvaultId: law-only search — must not surface
    //    docvault chunks of anyone.
    const qFallback = await call("POST", "/admin/docvault/query", {
      question: "Was ist Bürgergeld und wer hat darauf Anspruch?",
      ownerUserId: ownerA,
    });
    assert(qFallback.status === 200, `fallback law search → 200 (${JSON.stringify(qFallback.body)})`);
    const keysFallback = JSON.parse((qFallback.body as { answer: string }).answer);
    assert(
      keysFallback.retrievedNormKeys.every((k: string) => !k.startsWith(docvaultId)),
      "fallback search returned no docvault chunks",
    );

    // 6. Cleanup scoped to owner A only.
    const del = await call(
      "DELETE",
      `/admin/docvault/${docvaultId}?ownerUserId=${ownerA}`,
    );
    assert(del.status === 200 && (del.body as { deleted: number }).deleted >= 1, "delete removed owner A's chunks");

    const prisma = app.get(PrismaService);
    const left = await prisma.lawChunk.count({ where: { lawId: "docvault", normKey: { startsWith: docvaultId } } });
    assert(left === 0, "no orphaned docvault chunks left in DB");
  } finally {
    await app.close();
  }

  console.log("\nALL DOCVAULT OWNER-ISOLATION E2E CASES PASSED");
}

main().catch((err: unknown) => {
  console.error(
    "E2E FAILED:",
    err instanceof Error ? err.stack : String(err),
  );
  process.exit(1);
});
