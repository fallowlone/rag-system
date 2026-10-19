import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "../ingestion/embedding.service";
import { CacheService } from "../cache/cache.service";
import {
  ChunkSearchResult,
  DebugSearchResult,
  RERANKING_PROVIDER,
  RerankingProvider,
} from "./rag.types";
import { DocumentCategory } from "../memory/memory.types";
import { PalaceNavigationService } from "./palace-navigation.service";
import { baseNormKey } from "./norm-key";
import { docvaultNormKeyFilter } from "./docvault-scope";
import { embeddingColumnSql } from "../ingestion/embedding-storage";
import { RetrievalHttpError } from "./local-reranking.provider";

const DEFAULT_TOP_K = 5;
const SQL_FETCH_COUNT = 20; // candidates fetched from pgvector before reranking
const MIN_SIMILARITY = 0.35;

export const UNIFIED_LAW_CANDIDATES = 20; // law chunks fetched before rerank (raised post-reindex, +42% smaller chunks)
// Docvault candidates are drawn from EVERY document the user owns, so this is
// the whole library's share of one answer — 13 out of a 100-document vault
// (~150-250 chunks) was a 5-8% sample. Raised to 24; the ceiling is the
// reranker's own request cap, see RERANK_MAX_DOCUMENTS.
export const UNIFIED_DOC_CANDIDATES = 24;
const UNIFIED_TOP_K = 10; // total chunks after rerank (raised post-reindex, +42% smaller chunks)
// Floor on how many of UNIFIED_TOP_K are the user's own documents. Law and
// document chunks used to compete for all ten slots with a guarantee of
// exactly one document chunk, so a question about the user's own paperwork
// could be answered from nine statute excerpts and a single fragment.
const UNIFIED_MIN_DOC_CHUNKS = 4;
// The reranker accepts at most this many documents (and topK) per request —
// services/retrieval-models/app/main.py caps both at 48. The candidate sum is
// asserted against it in the spec so raising either constant cannot silently
// start producing 422s.
export const RERANK_MAX_DOCUMENTS = 48;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const RERANK_CACHE_TTL_SECONDS = 3_600;

/**
 * Default law filter(s) applied when no explicit abbreviation pattern
 * matched but a document category is known. Most categories map to a single
 * law; `visa` maps to two (Task 15): AufenthG covers residence-permit
 * questions, AsylbLG covers asylum-seeker benefits questions — both are
 * routed to category=visa and neither should hard-exclude the other.
 */
const CATEGORY_LAW_DEFAULTS: Partial<Record<DocumentCategory, string[]>> = {
  mietvertrag: ["bgb"],
  jobcenter: ["sgb_2"],
  visa: ["aufenthg_2004", "asylblg"],
};

// Maps query abbreviation patterns to their DB lawId.
// Order matters: more specific patterns (SGB XII) must come before shorter ones (SGB II).
// Exported for reuse by citation-verifier.ts (Task 16) — single source of truth
// for abbreviation → lawId normalization; do not duplicate this map.
export const LAW_ABBREVIATIONS: Array<{ pattern: RegExp; lawId: string }> = [
  { pattern: /\bSGB\s+XII\b/i, lawId: "sgb_12" },
  { pattern: /\bSGB\s+II\b/i, lawId: "sgb_2" },
  { pattern: /bürgergeld|бюргергельд/i, lawId: "sgb_2" },
  { pattern: /\bAufenthG\b/i, lawId: "aufenthg_2004" },
  { pattern: /\bAsylbLG\b/i, lawId: "asylblg" },
  { pattern: /\bAsylG\b/i, lawId: "asylvfg_1992" },
  { pattern: /\bKSchG\b|Kündigungsschutzgesetz/i, lawId: "kschg" },
  { pattern: /\bStGB\b/i, lawId: "stgb" },
  { pattern: /\bBGB\b/i, lawId: "bgb" },
];

/** What the rerank cache stores: an ordering over a pinned candidate set. */
type RerankOrdering = Array<{ id: string; score: number }>;

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);
  // Single-flight dedup for /rerank (mirrors EmbeddingService.inFlight):
  // N concurrent chat turns with the same query + candidate set share one
  // provider round trip instead of issuing N and last-writer-winning the
  // cache. Per-process only — a second replica can still stampede, same as
  // the embedding path.
  private readonly rerankInFlight = new Map<
    string,
    Promise<ChunkSearchResult[]>
  >();
  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly palace: PalaceNavigationService,
    private readonly cache: CacheService,
    @Inject(RERANKING_PROVIDER)
    private readonly reranking: RerankingProvider,
  ) {}

  async search(
    query: string,
    topK: number = DEFAULT_TOP_K,
    category?: DocumentCategory,
  ): Promise<ChunkSearchResult[]> {
    const { lawIds: matchedLawIds, matchedIds } = extractLawId(query, category);
    const paragraph = extractParagraph(query);

    this.logger.debug(
      `extractLawId matched=${JSON.stringify([...matchedIds])} → lawFilter=${matchedLawIds.length ? matchedLawIds.join(",") : "none"}, §=${paragraph ?? "none"}`,
    );
    this.logger.debug(
      `Searching for: "${query}" (topK=${topK}${matchedLawIds.length ? `, lawFilter=${matchedLawIds.join(",")}` : ""})`,
    );

    const [queryVector] = await this.embedding.embed([query]);
    const vectorStr = `[${queryVector.join(",")}]`;

    const lawFilter = lawIdFilter(matchedLawIds);

    let rows = await this.fetchLawRows(
      vectorStr,
      lawFilter,
      paragraphFilter(paragraph),
      paragraph !== null,
      SQL_FETCH_COUNT,
    );
    // Fallback: the cited § may not exist in the filtered law (or normKey
    // format mismatch) — retry as a plain vector search instead of
    // returning nothing.
    if (rows.length === 0 && paragraph) {
      this.logger.debug(
        `§ ${paragraph} filter returned 0 rows, retrying without it`,
      );
      rows = await this.fetchLawRows(
        vectorStr,
        lawFilter,
        Prisma.sql``,
        false,
        SQL_FETCH_COUNT,
      );
    }

    if (rows.length === 0) return [];

    const candidates = rows.map((row) => ({
      ...row,
      similarity: Number(row.similarity),
    }));

    const reranked = await this.rankOrFallback(query, candidates, topK);
    return this.expandParentNorm(reranked);
  }

  /**
   * Vector search over LawChunk with optional lawId / § normKey filters.
   * When `skipMinSimilarity` is set (explicit § reference in the query) the
   * similarity floor is dropped: the normKey filter is already precise, and
   * the floor was cutting off correct §§ phrased differently from the
   * user's wording (golden-set q44).
   */
  private fetchLawRows(
    vectorStr: string,
    lawFilter: Prisma.Sql,
    paraFilter: Prisma.Sql,
    skipMinSimilarity: boolean,
    limit: number,
    // Docvault chunks are personal (ownerUserId-scoped); only owner-scoped
    // docvault paths (searchAllDocvault) may read them, so every generic law
    // search excludes them by default.
    excludeDocvault = true,
  ): Promise<ChunkSearchResult[]> {
    const embeddingColumn = embeddingColumnSql();
    const simFilter = skipMinSimilarity
      ? Prisma.empty
      : Prisma.sql`AND 1 - (${embeddingColumn} <=> ${vectorStr}::vector) >= ${MIN_SIMILARITY}`;
    const docvaultFilter = excludeDocvault
      ? Prisma.sql`AND "lawId" != 'docvault'`
      : Prisma.empty;
    return this.prisma.$queryRaw<ChunkSearchResult[]>(Prisma.sql`
      SELECT
        id,
        "lawId",
        "normKey",
        heading,
        text,
        1 - (${embeddingColumn} <=> ${vectorStr}::vector) AS similarity
      FROM "LawChunk"
      WHERE TRUE
        AND ${embeddingColumn} IS NOT NULL
        ${docvaultFilter}
        ${simFilter}
        ${lawFilter}
        ${paraFilter}
      ORDER BY ${embeddingColumn} <=> ${vectorStr}::vector
      LIMIT ${limit}
    `);
  }

  async searchDocvault(
    query: string,
    docvaultId: string,
    topK = 5,
    ownerUserId?: string,
  ): Promise<ChunkSearchResult[]> {
    // Fail-closed: docvault chunks are personal documents. Without a known
    // owner there is no safe filter to apply, so return nothing rather than
    // risk leaking another user's documents.
    if (!ownerUserId) return [];
    const [queryVector] = await this.embedding.embed([query]);
    const vectorStr = `[${queryVector.join(",")}]`;
    const embeddingColumn = embeddingColumnSql();

    const rows = await this.prisma.$queryRaw<ChunkSearchResult[]>(Prisma.sql`
      SELECT
        id,
        "lawId",
        "normKey",
        heading,
        text,
        1 - (${embeddingColumn} <=> ${vectorStr}::vector) AS similarity
      FROM "LawChunk"
      WHERE "lawId" = 'docvault'
        AND "ownerUserId" = ${ownerUserId}
        AND ${embeddingColumn} IS NOT NULL
        AND ${docvaultNormKeyFilter(docvaultId)}
      ORDER BY ${embeddingColumn} <=> ${vectorStr}::vector
      LIMIT ${topK}
    `);

    return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
  }

  private async searchAllDocvault(
    vectorStr: string,
    userRoomId: string | null,
    topK: number,
    userId?: string,
    // Single-document scope for per-document Q&A: only chunks whose normKey
    // belongs to this docvaultId (UserDocument.id). Same LIKE shape as
    // searchDocvault — one document's chunks, still owner-scoped.
    docvaultId?: string,
  ): Promise<ChunkSearchResult[]> {
    // Fail-closed: docvault chunks are personal documents. Without a known
    // owner there is no safe filter to apply, so skip the docvault search
    // entirely rather than risk leaking another user's documents.
    if (!userId) return [];
    const embeddingColumn = embeddingColumnSql();

    const roomFilter =
      userRoomId !== null
        ? Prisma.sql`AND "roomId" = ${userRoomId}`
        : Prisma.sql``;

    const docFilter = docvaultId
      ? Prisma.sql`AND ${docvaultNormKeyFilter(docvaultId)}`
      : Prisma.sql``;

    const rows = await this.prisma.$queryRaw<ChunkSearchResult[]>(Prisma.sql`
      SELECT
        id,
        "lawId",
        "normKey",
        heading,
        text,
        1 - (${embeddingColumn} <=> ${vectorStr}::vector) AS similarity
      FROM "LawChunk"
      WHERE "lawId" = 'docvault'
        AND "ownerUserId" = ${userId}
        AND ${embeddingColumn} IS NOT NULL
        AND 1 - (${embeddingColumn} <=> ${vectorStr}::vector) >= ${MIN_SIMILARITY}
        ${roomFilter}
        ${docFilter}
      ORDER BY ${embeddingColumn} <=> ${vectorStr}::vector
      LIMIT ${topK}
    `);

    return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
  }

  async searchUnified(
    query: string,
    category?: DocumentCategory,
    userId?: string,
    // Single-document scope for per-document Q&A (UserDocument.id). Narrows
    // only the docvault leg — the law-corpus leg is unchanged.
    docvaultId?: string,
  ): Promise<ChunkSearchResult[]> {
    const { lawRoomId, userRoomId } = await this.palace.resolveRooms(category);

    this.logger.debug(
      `searchUnified: category=${category ?? "none"} lawRoom=${lawRoomId ?? "all"} userRoom=${userRoomId ?? "all"}`,
    );

    const [queryVector] = await this.embedding.embed([query]);
    const vectorStr = `[${queryVector.join(",")}]`;

    const { lawIds: abbreviationLawIds } = extractLawId(query, category);
    const paragraph = extractParagraph(query);
    const lawFilter =
      abbreviationLawIds.length > 0
        ? lawIdFilter(abbreviationLawIds)
        : lawRoomId !== null
          ? Prisma.sql`AND "roomId" = ${lawRoomId}`
          : Prisma.sql``;

    let lawRows: ChunkSearchResult[];
    let docCandidates: ChunkSearchResult[];
    try {
      [lawRows, docCandidates] = await Promise.all([
        this.fetchLawRows(
          vectorStr,
          lawFilter,
          paragraphFilter(paragraph),
          paragraph !== null,
          UNIFIED_LAW_CANDIDATES,
          true,
        ),
        this.searchAllDocvault(
          vectorStr,
          userRoomId,
          UNIFIED_DOC_CANDIDATES,
          userId,
          docvaultId,
        ),
      ]);
      // Fallback: the room filter is a hard exclusion, and the category that
      // chose it comes from a keyword match on the raw question
      // (matchCategoryByKeyword wins over the model's guess), so one stray
      // word — "bank" in a question about a Jobcenter letter — hid every
      // document of every other category with no way to notice. Retry once
      // across all rooms. The OWNER scope is never relaxed, only the room.
      if (docCandidates.length === 0 && userRoomId !== null && userId) {
        this.logger.debug(
          `searchUnified: user room ${userRoomId} returned 0 doc rows, retrying across all rooms`,
        );
        docCandidates = await this.searchAllDocvault(
          vectorStr,
          null,
          UNIFIED_DOC_CANDIDATES,
          userId,
          docvaultId,
        );
      }
      // Fallback: cited § missing under the current law/room filter —
      // retry the law leg without the § constraint.
      if (lawRows.length === 0 && paragraph) {
        this.logger.debug(
          `searchUnified: § ${paragraph} filter returned 0 rows, retrying without it`,
        );
        lawRows = await this.fetchLawRows(
          vectorStr,
          lawFilter,
          Prisma.sql``,
          false,
          UNIFIED_LAW_CANDIDATES,
          true,
        );
      }
    } catch (err) {
      this.logger.error(
        "searchUnified: DB query failed",
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }

    const lawCandidates = lawRows.map((r) => ({
      ...r,
      similarity: Number(r.similarity),
    }));

    if (lawCandidates.length === 0 && docCandidates.length === 0) return [];

    // Hard cap so an over-cap request can never 422 the whole search. The
    // spec asserts the constants cannot reach it, so this is unreachable
    // today — and if it ever did fire it would drop document candidates
    // first, which is why the assertion, not this slice, is the real guard.
    const allCandidates = [...lawCandidates, ...docCandidates].slice(
      0,
      RERANK_MAX_DOCUMENTS,
    );
    // Rank the WHOLE candidate set instead of asking the reranker for the
    // final ten: the floor below has to choose between chunks, and it can
    // only do that if every chunk carries a rerank score. The previous shape
    // (topK = UNIFIED_TOP_K) returned ten scored chunks and left the rest
    // with raw cosine similarity, which is a different scale — the old
    // one-chunk guarantee spliced such a chunk into the list and had to
    // document that `.similarity` was no longer comparable across it. Both
    // the mismatch and the caveat are gone.
    const ranked = await this.rankOrFallback(
      query,
      allCandidates,
      allCandidates.length,
    );

    const reranked = composeUnifiedChunks(
      ranked,
      UNIFIED_TOP_K,
      UNIFIED_MIN_DOC_CHUNKS,
    );

    return this.expandParentNorm(reranked);
  }

  /**
   * Enriches each returned law chunk (not docvault) with its sibling
   * paragraphs of the same § — e.g. a short §'s general clause (Abs.1) and
   * its exceptions (Abs.2) were packed into separate embeddings before
   * ingest-time greedy packing existed, and even packed norms can still
   * split across a CHUNK_SIZE boundary. Runs after rerank so it never
   * changes which chunks are selected or their order — only their `.text`.
   * `LawChunk_lawId_normKey_idx` (text_pattern_ops) backs the LIKE lookup.
   */
  private async expandParentNorm(
    chunks: ChunkSearchResult[],
  ): Promise<ChunkSearchResult[]> {
    const groupKeys = new Map<string, { lawId: string; base: string }>();
    for (const chunk of chunks) {
      if (chunk.lawId === "docvault") continue;
      const base = baseNormKey(chunk.normKey);
      groupKeys.set(`${chunk.lawId}\0${base}`, { lawId: chunk.lawId, base });
    }
    if (groupKeys.size === 0) return chunks;

    // One joined query for all § groups (up to UNIFIED_TOP_K per message) —
    // the per-group version used to issue up to 10 separate SQL round trips
    // via Promise.all on every message. The (lawId, normKey) text_pattern_ops
    // index backs the LIKE lookup for each VALUES row.
    const pairs = [...groupKeys.entries()].map(([key, { lawId, base }]) => ({
      key,
      lawId,
      base,
    }));
    const rows = await this.prisma.$queryRaw<
      Array<{ lawId: string; base: string; normKey: string; text: string }>
    >(Prisma.sql`
      SELECT g."lawId", g."base", c."normKey", c.text
      FROM (VALUES ${Prisma.join(
        pairs.map((p) => Prisma.sql`(${p.lawId}::text, ${p.base}::text)`),
      )}) AS g("lawId", "base")
      JOIN "LawChunk" c
        ON c."lawId" = g."lawId"
       AND (c."normKey" = g."base" OR c."normKey" LIKE g."base" || '\_%')
    `);

    const siblingsByGroup = new Map<string, Array<{ normKey: string; text: string }>>();
    for (const row of rows) {
      const key = `${row.lawId}\0${row.base}`;
      const siblings = siblingsByGroup.get(key) ?? [];
      siblings.push({ normKey: row.normKey, text: row.text });
      siblingsByGroup.set(key, siblings);
    }

    const expandedTextByGroup = new Map<string, string>();
    for (const [key, siblings] of siblingsByGroup) {
      if (siblings.length <= 1) continue;

      const ordered = siblings
        .map((s) => ({ ...s, order: paragraphOrder(s.normKey) }))
        .sort(
          (a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1],
        );
      expandedTextByGroup.set(key, mergeSiblingTexts(ordered.map((s) => s.text)));
    }

    if (expandedTextByGroup.size === 0) return chunks;

    return chunks.map((chunk) => {
      if (chunk.lawId === "docvault") return chunk;
      const key = `${chunk.lawId}\0${baseNormKey(chunk.normKey)}`;
      const expandedText = expandedTextByGroup.get(key);
      return expandedText ? { ...chunk, text: expandedText } : chunk;
    });
  }

  async debugSearch(query: string, topK: number): Promise<DebugSearchResult[]> {
    const [queryVector] = await this.embedding.embed([query]);
    const vectorStr = `[${queryVector.join(",")}]`;
    const embeddingColumn = embeddingColumnSql();

    const rows = await this.prisma.$queryRaw<DebugSearchResult[]>(Prisma.sql`
      SELECT
        "lawId",
        "normKey",
        1 - (${embeddingColumn} <=> ${vectorStr}::vector) AS similarity
      FROM "LawChunk"
      WHERE ${embeddingColumn} IS NOT NULL
      ORDER BY ${embeddingColumn} <=> ${vectorStr}::vector
      LIMIT ${topK}
    `);

    return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
  }

  /**
   * `query` + candidate identity (order-independent — the same candidate set
   * can arrive in a different order across calls) + `topK`, since a shorter
   * topK is not simply a prefix of a longer one once the reranker's relevance
   * scoring is involved.
   */
  private rerankCacheKey(
    query: string,
    candidates: ChunkSearchResult[],
    topK: number,
  ): string {
    const idsKey = candidates
      .map((c) => c.id)
      .sort()
      .join(",");
    // "rerank2:" — the cached payload is now an ordering (id + score), not
    // whole chunks; an entry written in the old shape must never be read back
    // as the new one. Same rule as the query preprocessor's "qpp2:".
    return (
      "rerank2:" +
      createHash("sha256")
        .update(`${this.reranking.id}\0${query}\0${topK}\0${idsKey}`)
        .digest("hex")
    );
  }

  /**
   * Ranks candidates, degrading to vector order instead of failing.
   *
   * A reranker outage used to throw out of `searchUnified`, through the
   * uncaught `Promise.all` in `buildAnswerContext`, and out of the whole
   * answer — so the user got "Fehler bei der Verarbeitung" even though the
   * candidates had already been retrieved and ordered. Backpressure made that
   * likelier, not rarer: the retrieval service answers saturation with an
   * immediate 503, and three of those in a row is an outage as far as this
   * code can tell.
   *
   * The fallback is a worse ranking, not a wrong one — every candidate
   * carries a cosine distance from the same embedding model, so the order is
   * meaningful across the law and document legs alike. It is deliberately NOT
   * cached: caching a degraded order would keep serving it for the full TTL
   * after the reranker recovered.
   */
  private async rankOrFallback(
    query: string,
    candidates: ChunkSearchResult[],
    topK: number,
  ): Promise<ChunkSearchResult[]> {
    try {
      return await this.rerankWithRetry(query, candidates, topK);
    } catch (err) {
      this.logger.error(
        `Rerank unavailable after ${MAX_RETRIES} attempts — falling back to vector order: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [...candidates]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK);
    }
  }

  private async rerankWithRetry(
    query: string,
    candidates: ChunkSearchResult[],
    topK: number,
  ): Promise<ChunkSearchResult[]> {
    const cacheKey = this.rerankCacheKey(query, candidates, topK);
    const inFlight = this.rerankInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = this.rerankUncached(query, candidates, topK, cacheKey).finally(
      () => {
        this.rerankInFlight.delete(cacheKey);
      },
    );
    this.rerankInFlight.set(cacheKey, promise);
    return promise;
  }

  private async rerankUncached(
    query: string,
    candidates: ChunkSearchResult[],
    topK: number,
    cacheKey: string,
  ): Promise<ChunkSearchResult[]> {
    // Cache the ORDERING, not the chunks. searchUnified now ranks the whole
    // candidate set (up to RERANK_MAX_DOCUMENTS) instead of asking for the
    // final ten, so caching whole chunks would have grown every entry from
    // ~10 to ~44 rows of chunk text — on a Redis that is deliberately
    // `noeviction`, silently multiplying cache pressure. The candidate set is
    // already pinned by the cache key, so the ids are enough to rebuild it.
    const cached = await this.cache.getJson<RerankOrdering>(cacheKey);
    if (cached) {
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const restored = cached
        .map(({ id, score }) => {
          const candidate = byId.get(id);
          return candidate ? { ...candidate, similarity: score } : null;
        })
        .filter((c): c is ChunkSearchResult => c !== null);
      // A partial restore means the cached ordering no longer describes this
      // candidate set (an id disappeared between runs). Re-rank rather than
      // answer from a silently shortened list.
      if (restored.length === cached.length) return restored;
      this.logger.debug(
        `Rerank cache entry no longer matches the candidate set — re-ranking`,
      );
    }

    const documents = candidates.map((c) => c.text);
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const items = await this.reranking.rerank(query, documents, topK);

        const reranked = items
          .map((item) => {
            const candidate = candidates[item.index];
            if (!candidate) {
              this.logger.warn(
                `Rerank provider ${this.reranking.id} returned invalid index ${item.index}, skipping`,
              );
              return null;
            }
            return {
              ...candidate,
              similarity: item.score,
            };
          })
          .filter((c): c is ChunkSearchResult => c !== null);

        await this.cache.setJson(
          cacheKey,
          reranked.map((c) => ({ id: c.id, score: c.similarity })),
          RERANK_CACHE_TTL_SECONDS,
        );
        return reranked;
      } catch (err) {
        lastError = err;
        if (attempt === MAX_RETRIES) break;
        // Saturation (503) carries the service's own hint; the fixed ladder is
        // too eager against a queue whose inference takes seconds.
        const delay =
          err instanceof RetrievalHttpError && err.retryAfterMs !== null
            ? Math.max(err.retryAfterMs, BASE_DELAY_MS)
            : BASE_DELAY_MS * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Rerank attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms`,
          err instanceof Error ? err.message : String(err),
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }
}

/**
 * Picks the final chunk list out of a fully ranked candidate set, reserving a
 * floor for the user's own documents.
 *
 * `ranked` must be ordered best-first and every entry must carry a score from
 * the SAME ranker — the caller ranks all candidates in one pass precisely so
 * that holds. Rank order is preserved in the output: the floor decides WHICH
 * chunks survive, never in what order the model reads them.
 *
 * The floor is a minimum, not a quota — a question with no relevant document
 * chunk still gets ten law chunks, because only the document chunks that are
 * actually present can be reserved.
 */
export function composeUnifiedChunks(
  ranked: ChunkSearchResult[],
  topK: number,
  minDocChunks: number,
): ChunkSearchResult[] {
  if (topK <= 0) return [];
  if (ranked.length <= topK) return ranked;

  // Clamp: a floor wider than the budget would starve the law leg entirely.
  const floor = Math.min(minDocChunks, topK);
  const picked = new Set<number>();

  for (let i = 0; i < ranked.length && picked.size < floor; i++) {
    if (ranked[i]!.lawId === "docvault") picked.add(i);
  }
  for (let i = 0; i < ranked.length && picked.size < topK; i++) {
    picked.add(i);
  }

  return [...picked].sort((a, b) => a - b).map((i) => ranked[i]!);
}

/** Numeric (paragraphIndex, chunkIndex) from a "..._pN_cM" normKey, for sort order. */
function paragraphOrder(normKey: string): [number, number] {
  const m = /_p(\d+)_c(\d+)$/.exec(normKey);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0]!;
  for (const s of strings.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}

/**
 * Every sibling chunk of the same norm carries the identical
 * `${lawTitle}\n${normLine}\n\n` prefix (chunkNormText runs once per norm,
 * over its whole text, so the same `prefix` argument is baked into every
 * resulting chunk) — so the longest common prefix across sibling texts is
 * that shared prefix, and stripping it from every sibling but the first
 * reconstructs the norm without repeating it.
 */
function mergeSiblingTexts(texts: string[]): string {
  if (texts.length <= 1) return texts[0] ?? "";
  const lcp = longestCommonPrefix(texts);
  const [first, ...rest] = texts;
  return [first, ...rest.map((t) => t.slice(lcp.length))].join("\n\n");
}

/**
 * Extracts an explicit paragraph citation ("§ 573", "§573a", "параграф 24")
 * from the query. Returns the bare number+suffix ("573a") or null.
 */
export function extractParagraph(query: string): string | null {
  const m =
    /§\s*(\d+[a-z]{0,2})\b/i.exec(query) ??
    /параграф[аеу]?\s+(\d+[a-z]{0,2})\b/i.exec(query);
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Hard filter on LawChunk.normKey for an explicit § citation. normKey format
 * in the DB is `§ 573_p1_c0` (space after §, `_pN_cN` chunk suffix), so we
 * match `§ 573` exactly or `§ 573\_...` — the backslash escapes LIKE's `_`
 * wildcard so `§ 5731…` does not match.
 */
export function paragraphFilter(paragraph: string | null): Prisma.Sql {
  if (!paragraph) return Prisma.empty;
  const key = `§ ${paragraph}`;
  return Prisma.sql`AND ("normKey" = ${key} OR "normKey" LIKE ${key + "\\_%"})`;
}

/**
 * Hard filter on LawChunk.lawId for one or more resolved law ids (an exact
 * abbreviation match, or a category default — Task 15 made the latter
 * support >1 id so `visa` can cover both AufenthG and AsylbLG without
 * excluding either).
 */
function lawIdFilter(lawIds: string[]): Prisma.Sql {
  if (lawIds.length === 0) return Prisma.sql``;
  if (lawIds.length === 1) return Prisma.sql`AND "lawId" = ${lawIds[0]}`;
  return Prisma.sql`AND "lawId" IN (${Prisma.join(lawIds)})`;
}

/**
 * Heuristic shared by extractLawId and isExplicitLawQuery: a bare "§ 24" /
 * "параграф 24" without an explicit law name most likely refers to AufenthG
 * (the visa / § 24 flow — one of the most common query shapes).
 */
function hasBareParagraph24(query: string): boolean {
  return /§\s*24\b/.test(query) || /параграф\s+24\b/i.test(query);
}

/**
 * True when the query already carries an explicit legal citation — a §
 * number plus a known law abbreviation (e.g. "§ 573 BGB"). Such queries
 * skip the Haiku rewrite (Task 12): the wording is already an optimal
 * retrieval key, and rewriting risks paraphrasing away the citation the
 * normKey filter keys on.
 *
 * A bare "§ 24" (no law name) also counts: per the hasBareParagraph24
 * heuristic it implies AufenthG, mirroring extractLawId (Task 12b). Other
 * bare § numbers do NOT count — they carry no law filter.
 */
export function isExplicitLawQuery(query: string): boolean {
  return (
    extractParagraph(query) !== null &&
    (LAW_ABBREVIATIONS.some(({ pattern }) => pattern.test(query)) ||
      hasBareParagraph24(query))
  );
}

export function extractLawId(
  query: string,
  category?: DocumentCategory,
): { lawIds: string[]; matchedIds: Set<string> } {
  const matchedIds = new Set<string>();

  // Heuristic: bare §24 or "параграф 24" without an explicit law name most likely refers to AufenthG.
  if (hasBareParagraph24(query)) {
    matchedIds.add("aufenthg_2004");
  }

  for (const { pattern, lawId } of LAW_ABBREVIATIONS) {
    if (pattern.test(query)) matchedIds.add(lawId);
  }

  // Exactly one explicit pattern matched — use it.
  if (matchedIds.size === 1) {
    const [onlyMatch] = matchedIds;
    return { lawIds: onlyMatch ? [onlyMatch] : [], matchedIds };
  }

  // No pattern matched and a document category is known — apply category default(s).
  if (matchedIds.size === 0 && category) {
    const defaultLawIds = CATEGORY_LAW_DEFAULTS[category];
    if (defaultLawIds && defaultLawIds.length > 0) {
      for (const id of defaultLawIds) matchedIds.add(id);
      return { lawIds: defaultLawIds, matchedIds };
    }
  }

  // Multiple patterns matched or no category hint — run unfiltered search.
  return { lawIds: [], matchedIds };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
