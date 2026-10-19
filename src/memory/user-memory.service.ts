import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "../ingestion/embedding.service";
import { DeadlineService } from "../deadlines/deadline.service";
import { ConversationService } from "../conversation/conversation.service";
import { HAIKU_MODEL, SONNET_MODEL } from "../llm-models";
import { CacheService } from "../cache/cache.service";
import {
  DOCUMENT_JOB_QUEUE,
  DocumentJobPayload,
} from "../documents/queue/document-job.types";
import { NIGHTLY_BATCH_QUEUE, NightlyBatchPayload } from "../batch/batch.types";
import { logLlmUsage } from "../llm-usage";
import { fingerprint } from "../common/log-fingerprint";
import {
  DocumentCategory,
  ForgetAllResult,
  MemoryType,
  RecalledDiary,
  RecalledMemory,
  StoredMemory,
  UserDocumentRecord,
  UserLang,
  DocumentListItem,
} from "./memory.types";
import { Prisma } from "@prisma/client";
import { embeddingColumnSql } from "../ingestion/embedding-storage";
import { recordTombstones } from "../app-api/deletion-tombstones";

const MIN_MEMORY_SIMILARITY = 0.2;
const DEFAULT_RECALL_TOP_K = 5;
const FULL_RECALL_THRESHOLD = 30;
// ≤ this many diary entries → newest-first full recall instead of a vector
// search (same 7-entry cutoff the count()-based branch used).
const DIARY_FULL_RECALL_THRESHOLD = 7;

// getUserLanguage runs on every incoming message — cache it instead of a
// Postgres round trip each time. Long TTL is safe: setUserLanguage always
// overwrites the cache immediately, so staleness is bounded by the TTL only
// when the underlying row changes through some other path (it doesn't today).
const LANG_CACHE_TTL_SECONDS = 86_400;
// Redis can't distinguish "no cached value" from "cached: no preference set"
// with a plain string cache — this sentinel marks the latter explicitly so a
// user with no language preference doesn't hit Postgres on every message.
const LANG_CACHE_NONE = "__none__";

// Set by forgetAll BEFORE the erase transaction: queued jobs are removed,
// but an already-active (in-flight) BullMQ job cannot be yanked — it checks
// this marker right before writing and skips, so it cannot resurrect erased
// facts. 1h covers the longest document/nightly attempt chains; a legitimate
// re-upload inside the window gets a "cancelled, retry" message instead of
// silent resurrection.
export const FORGET_MARKER_TTL_SECONDS = 3_600;

export function forgetMarkerKey(userId: string): string {
  return `forget:${userId}`;
}

const CLASSIFIER_MODEL = HAIKU_MODEL;
const EXTRACTOR_MODEL = SONNET_MODEL;
const TRANSLATOR_MODEL = HAIKU_MODEL;

const TRANSLATOR_SYSTEM =
  "Translate each item to German. " +
  "Return ONLY a valid JSON array of strings. Same order, same count. No explanation.";

const CLASSIFIER_SYSTEM =
  "Does this message contain personal facts, events, or situations worth remembering for future legal consultations? " +
  "Include: personal events, problems, accidents, legal situations, relationships with landlord/authorities, " +
  "appointments and dates (Termin, Gespräch, Frist, Deadline), " +
  "official letters or notices addressed to the user, " +
  "any message mentioning a specific date combined with a location or person. " +
  "Exclude: pure questions without any personal context, general legal questions. " +
  "Reply with only: YES or NO";

const EXTRACTOR_SYSTEM =
  "You are extracting personal facts from a user message to personalise future legal advice. " +
  "Extract only factual statements about the user's personal situation. " +
  "Return a JSON array of strings — each string is one clear, self-contained fact. " +
  "Focus on: visa types, permit numbers, dates, addresses, amounts, deadlines, family situation, employment status. " +
  "If no personal facts are present, return []. " +
  "Return ONLY a valid JSON array, no explanation, no markdown.";

/**
 * Hard cap on the /documents listing. Far above any realistic personal
 * archive, but an unbounded findMany on a batch-ingested account is one
 * query away from an over-long reply and a large response payload.
 */
const LIST_DOCUMENTS_MAX = 500;

@Injectable()
export class UserMemoryService {
  private readonly logger = new Logger(UserMemoryService.name);
  private readonly anthropic: Anthropic;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly deadlines: DeadlineService,
    private readonly conversation: ConversationService,
    private readonly cache: CacheService,
    @InjectQueue(DOCUMENT_JOB_QUEUE)
    private readonly documentQueue: Queue<DocumentJobPayload>,
    @InjectQueue(NIGHTLY_BATCH_QUEUE)
    private readonly nightlyBatchQueue: Queue<NightlyBatchPayload>,
  ) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.anthropic = new Anthropic({ apiKey });
  }

  async remember(
    userId: string,
    content: string,
    type: MemoryType = "fact",
    sourceHash?: string,
    documentId?: string,
  ): Promise<StoredMemory> {
    const [vector] = await this.embedding.embed([content]);
    const vectorStr = `[${vector.join(",")}]`;
    const id = randomUUID();
    const hash = sourceHash ?? null;
    const docId = documentId ?? null;
    const embeddingColumn = embeddingColumnSql();
    // Single timestamp for the row AND the returned object — NOW() in SQL
    // plus new Date() in JS disagree by milliseconds (the audit's
    // "createdAt that isn't the row's" skew).
    const createdAt = new Date();

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "UserMemory" (id, "userId", type, content, "contentOriginal", ${embeddingColumn}, "sourceHash", "documentId", "createdAt")
      VALUES (
        ${id},
        ${userId},
        ${type},
        ${content},
        ${null},
        ${vectorStr}::vector,
        ${hash},
        ${docId},
        ${createdAt}
      )
    `);

    this.logger.debug(
      `Stored memory [${type}] for user ${userId}: ${fingerprint(content)}`,
    );

    if (type === "fact" || type === "document") {
      void this.deadlines
        .saveDeadlinesFromMemory(userId, id, content)
        .catch((err) =>
          this.logger.warn(
            `saveDeadlinesFromMemory failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    return {
      id,
      userId,
      type,
      content,
      contentOriginal: null,
      createdAt,
    };
  }

  async rememberBatch(
    userId: string,
    contents: string[],
    type: MemoryType = "fact",
    sourceHash?: string,
    documentId?: string,
    storeOriginal?: string[],
  ): Promise<StoredMemory[]> {
    if (contents.length === 0) return [];

    const vectors = await this.embedding.embed(contents);
    const hash = sourceHash ?? null;
    const docId = documentId ?? null;
    const results: StoredMemory[] = [];
    const embeddingColumn = embeddingColumnSql();

    // Build the full result list before the transaction so UUIDs and timestamps
    // are deterministic regardless of transaction outcome.
    const rows = contents.map((content, i) => ({
      id: randomUUID(),
      content,
      original: storeOriginal?.[i] ?? null,
      vectorStr: `[${vectors[i]!.join(",")}]`,
      createdAt: new Date(),
    }));

    // All inserts in a single transaction — partial failure must not leave orphaned facts.
    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "UserMemory" (id, "userId", type, content, "contentOriginal", ${embeddingColumn}, "sourceHash", "documentId", "createdAt")
          VALUES (
            ${row.id},
            ${userId},
            ${type},
            ${row.content},
            ${row.original},
            ${row.vectorStr}::vector,
            ${hash},
            ${docId},
            ${row.createdAt}
          )
        `);
      }
    });

    for (const row of rows) {
      results.push({
        id: row.id,
        userId,
        type,
        content: row.content,
        contentOriginal: row.original,
        createdAt: row.createdAt,
      });
    }

    this.logger.debug(
      `Stored ${results.length} memories [${type}] for user ${userId} (batch)`,
    );

    if (type === "fact" || type === "document") {
      for (const row of rows) {
        void this.deadlines
          .saveDeadlinesFromMemory(userId, row.id, row.content, docId ?? undefined)
          .catch((err) =>
            this.logger.warn(
              `saveDeadlinesFromMemory failed (batch): ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    }

    return results;
  }

  async isDuplicate(userId: string, sourceHash: string): Promise<boolean> {
    const count = await this.prisma.userMemory.count({
      where: { userId, sourceHash },
    });
    return count > 0;
  }

  async createDocument(
    userId: string,
    sourceHash: string,
    category: DocumentCategory,
    factsCount: number,
    fileName?: string,
    fullText?: string,
    summary?: string,
    isActive?: boolean,
    expiryDate?: Date | null,
    /**
     * macOS-companion-app columns (appSource path). Kept optional so the
     * Telegram PDF pipeline's call sites stay unchanged.
     */
    extra?: {
      title?: string;
      docDate?: Date | null;
      status?: string;
      appSource?: boolean;
      /** sha256 of the extraction payload — see extraction-hash.ts. */
      extractionHash?: string;
    },
  ): Promise<{ doc: UserDocumentRecord; created: boolean }> {
    let doc;
    let created: boolean;
    try {
      doc = await this.prisma.userDocument.create({
        data: {
          userId,
          sourceHash,
          category,
          factsCount,
          fileName: fileName ?? null,
          fullText: fullText ?? null,
          summary: summary ?? null,
          isActive: isActive ?? true,
          expiryDate: expiryDate ?? null,
          title: extra?.title ?? null,
          docDate: extra?.docDate ?? null,
          status: extra?.status ?? null,
          appSource: extra?.appSource ?? false,
          extractionHash: extra?.extractionHash ?? null,
        },
      });
      created = true;
    } catch (err) {
      // Concurrent uploads of the same (userId, sourceHash) lose the unique race.
      // Treat the loser as a no-op and return the winner's record so the caller can skip re-extraction.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const existing = await this.prisma.userDocument.findFirst({
          where: { userId, sourceHash },
        });
        if (!existing) {
          throw err;
        }
        return {
          doc: this.toDocumentRecord(existing),
          created: false,
        };
      }
      throw err;
    }
    if (doc.expiryDate) {
      void this.deadlines
        .saveDeadlinesFromDocument(
          doc.userId,
          doc.id,
          doc.expiryDate,
          doc.fileName,
        )
        .catch((err) =>
          this.logger.warn(
            `saveDeadlinesFromDocument failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    return {
      doc: this.toDocumentRecord(doc),
      created,
    };
  }

  private toDocumentRecord(doc: {
    id: string;
    userId: string;
    fileName: string | null;
    category: string;
    sourceHash: string;
    factsCount: number;
    fullText: string | null;
    summary: string | null;
    isActive: boolean;
    expiryDate: Date | null;
    createdAt: Date;
    extractionHash?: string | null;
  }): UserDocumentRecord {
    return {
      id: doc.id,
      userId: doc.userId,
      fileName: doc.fileName,
      category: doc.category as DocumentCategory,
      sourceHash: doc.sourceHash,
      factsCount: doc.factsCount,
      fullText: doc.fullText,
      summary: doc.summary,
      isActive: doc.isActive,
      expiryDate: doc.expiryDate,
      createdAt: doc.createdAt,
      extractionHash: doc.extractionHash ?? null,
    };
  }

  /**
   * Document list for the /documents view. Deliberately does NOT select
   * `fullText` (up to DOC_FULLTEXT_MAX_CHARS per row): pulling every
   * document's complete extracted text to render names and counts is tens of
   * megabytes on an account that batch-ingested a folder. Callers that need
   * the text read one document via `findDocumentByHash`/`getDocument`.
   */
  async listDocuments(userId: string): Promise<DocumentListItem[]> {
    const docs = await this.prisma.userDocument.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: LIST_DOCUMENTS_MAX,
      select: {
        id: true,
        userId: true,
        fileName: true,
        category: true,
        sourceHash: true,
        factsCount: true,
        summary: true,
        isActive: true,
        expiryDate: true,
        createdAt: true,
      },
    });
    return docs.map((d) => ({
      id: d.id,
      userId: d.userId,
      fileName: d.fileName,
      category: d.category as DocumentCategory,
      sourceHash: d.sourceHash,
      factsCount: d.factsCount,
      summary: d.summary,
      isActive: d.isActive,
      expiryDate: d.expiryDate,
      createdAt: d.createdAt,
    }));
  }

  async findDocumentByHash(
    userId: string,
    sourceHash: string,
  ): Promise<UserDocumentRecord | null> {
    const doc = await this.prisma.userDocument.findFirst({
      where: { userId, sourceHash },
    });
    if (!doc) return null;
    return {
      id: doc.id,
      userId: doc.userId,
      fileName: doc.fileName,
      category: doc.category as DocumentCategory,
      sourceHash: doc.sourceHash,
      factsCount: doc.factsCount,
      fullText: doc.fullText,
      summary: doc.summary,
      isActive: doc.isActive,
      expiryDate: doc.expiryDate,
      createdAt: doc.createdAt,
    };
  }

  async deleteDocument(userId: string, documentId: string): Promise<boolean> {
    // Deadline ids first: the cleanup below deletes them, and the sync
    // tombstones (written after a successful delete) need the list.
    const deadlineRows = await this.prisma.userDeadline.findMany({
      where: { userId, sourceId: documentId },
      select: { id: true },
    });
    // Cleanup first: the deadline cleanup is idempotent, so a failed
    // document delete below can be retried cleanly. Deleting the document
    // first would orphan UserDeadline rows on cleanup failure.
    await this.deadlines.deleteDeadlinesBySource(documentId, userId);
    // Cascade delete removes linked UserMemory rows via FK ON DELETE CASCADE
    const deleted = await this.prisma.userDocument.deleteMany({
      where: { id: documentId, userId },
    });
    if (deleted.count > 0) {
      // Sync tombstones so Mac clients drop the document and its deadlines
      // instead of displaying deleted rows forever.
      await recordTombstones(this.prisma, userId, [
        { collection: "document", objectId: documentId },
        ...deadlineRows.map((row) => ({
          collection: "deadline" as const,
          objectId: row.id,
        })),
      ]);
    }
    return deleted.count > 0;
  }

  /**
   * Two-step fact extraction from a conversational message.
   * Step 1 (Haiku, max 10 tokens): classify whether the message contains personal facts.
   * Step 2 (Sonnet, only if YES): extract structured facts and persist each one.
   * Returns the number of facts saved (0 if classifier returned NO).
   */
  async extractAndSave(userId: string, message: string): Promise<number> {
    // Step 2a — cheap classifier
    const classifyResponse = await this.anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 10,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: "user", content: message }],
    });
    logLlmUsage(
      this.logger,
      "memory_classify",
      CLASSIFIER_MODEL,
      classifyResponse.usage,
    );

    const classifierText =
      classifyResponse.content[0]?.type === "text"
        ? classifyResponse.content[0].text.trim().toUpperCase()
        : "NO";

    if (!classifierText.startsWith("YES")) {
      this.logger.debug(
        `extractAndSave: classifier NO for user ${userId}, skipping Sonnet`,
      );
      return 0;
    }

    // Step 2b — Sonnet extraction
    const extractResponse = await this.anthropic.messages.create({
      model: EXTRACTOR_MODEL,
      max_tokens: 512,
      system: EXTRACTOR_SYSTEM,
      messages: [{ role: "user", content: message }],
    });
    logLlmUsage(
      this.logger,
      "memory_extract",
      EXTRACTOR_MODEL,
      extractResponse.usage,
    );

    const rawText =
      extractResponse.content[0]?.type === "text"
        ? extractResponse.content[0].text.trim()
        : "[]";

    const cleaned = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let facts: string[];
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((f) => typeof f === "string")
      ) {
        throw new Error("not a string[]");
      }
      facts = parsed;
    } catch (err) {
      this.logger.warn(
        `extractAndSave: failed to parse Sonnet response for user ${userId}: ${String(err)}`,
      );
      return 0;
    }

    // Step 2c — translate facts to German for better embedding quality
    const germanFacts = await this.translateToGerman(facts);

    // germanFacts go to content (embedding), original facts go to contentOriginal (display)
    await this.rememberBatch(
      userId,
      germanFacts,
      "fact",
      undefined,
      undefined,
      facts,
    );

    this.logger.debug(
      `extractAndSave: saved ${facts.length} facts for user ${userId}`,
    );

    return facts.length;
  }

  private async translateToGerman(facts: string[]): Promise<string[]> {
    if (facts.length === 0) return [];

    try {
      const response = await this.anthropic.messages.create({
        model: TRANSLATOR_MODEL,
        max_tokens: 1024,
        system: TRANSLATOR_SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(facts) }],
      });
      logLlmUsage(
        this.logger,
        "memory_translate",
        TRANSLATOR_MODEL,
        response.usage,
      );

      const rawText =
        response.content[0]?.type === "text"
          ? response.content[0].text.trim()
          : "[]";

      const cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();

      const parsed: unknown = JSON.parse(cleaned);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((f) => typeof f === "string") ||
        parsed.length !== facts.length
      ) {
        throw new Error(
          `unexpected shape: expected string[${facts.length}], got ${JSON.stringify(parsed).slice(0, 80)}`,
        );
      }

      return parsed as string[];
    } catch (err) {
      this.logger.warn(
        `translateToGerman failed, using originals: ${err instanceof Error ? err.message : String(err)}`,
      );
      return facts; // fallback: store originals in both fields
    }
  }

  async recall(
    userId: string,
    query: string,
    topK: number = DEFAULT_RECALL_TOP_K,
    category?: DocumentCategory,
  ): Promise<RecalledMemory[]> {
    const categoryFilter: Prisma.UserMemoryWhereInput | undefined = category
      ? { OR: [{ documentId: null }, { document: { category } }] }
      : undefined;

    // One round trip instead of count() + findMany(): fetch up to
    // FULL_RECALL_THRESHOLD + 1 newest facts; if we got fewer, the small-set
    // branch is implied (no embedding needed). On the large-set path the
    // extra fetched rows are simply discarded — cheaper than a separate
    // COUNT on the per-message hot path.
    // `preference` rows (e.g. `language:ru`, the deadline-backfill marker)
    // are machine state, not memories: they must never surface in answers
    // or the /memories list, and must not consume embedding/recall budget.
    // Readers that need them query by type directly (getUserLanguage,
    // deadline-backfill check).
    const newestRows = await this.prisma.userMemory.findMany({
      where: {
        userId,
        status: "active",
        type: { not: "preference" },
        ...categoryFilter,
      },
      orderBy: { createdAt: "desc" },
      take: FULL_RECALL_THRESHOLD + 1,
    });

    if (newestRows.length <= FULL_RECALL_THRESHOLD) {
      const results = newestRows.slice(0, topK).map((r) => ({
        id: r.id,
        type: r.type as MemoryType,
        content: r.content,
        similarity: 1 as number,
        createdAt: r.createdAt,
      }));
      this.logger.debug(
        `Recalled all ${results.length} memories for user ${userId} (full recall${category ? `, category=${category}` : ""})`,
      );
      return results;
    }

    // Large memory set — similarity search
    const [queryVector] = await this.embedding.embed([query]);
    const vectorStr = `[${queryVector.join(",")}]`;
    const embeddingColumn = embeddingColumnSql();
    const aliasedEmbeddingColumn = embeddingColumnSql("m");

    const rows = category
      ? await this.prisma.$queryRaw<
          Array<{
            id: string;
            type: string;
            content: string;
            similarity: number;
            createdAt: Date;
          }>
        >(Prisma.sql`
          SELECT m.id, m.type, m.content,
            1 - (${aliasedEmbeddingColumn} <=> ${vectorStr}::vector) AS similarity,
            m."createdAt"
          FROM "UserMemory" m
          LEFT JOIN "UserDocument" d ON m."documentId" = d.id
          WHERE m."userId" = ${userId}
            AND m.status = 'active'
            AND m.type != 'preference'
            AND (m."documentId" IS NULL OR d.category = ${category})
            AND ${aliasedEmbeddingColumn} IS NOT NULL
            AND 1 - (${aliasedEmbeddingColumn} <=> ${vectorStr}::vector) >= ${MIN_MEMORY_SIMILARITY}
          ORDER BY ${aliasedEmbeddingColumn} <=> ${vectorStr}::vector
          LIMIT ${topK}
        `)
      : await this.prisma.$queryRaw<
          Array<{
            id: string;
            type: string;
            content: string;
            similarity: number;
            createdAt: Date;
          }>
        >(Prisma.sql`
          SELECT id, type, content,
            1 - (${embeddingColumn} <=> ${vectorStr}::vector) AS similarity,
            "createdAt"
          FROM "UserMemory"
          WHERE "userId" = ${userId}
            AND status = 'active'
            AND type != 'preference'
            AND ${embeddingColumn} IS NOT NULL
            AND 1 - (${embeddingColumn} <=> ${vectorStr}::vector) >= ${MIN_MEMORY_SIMILARITY}
          ORDER BY ${embeddingColumn} <=> ${vectorStr}::vector
          LIMIT ${topK}
        `);

    const results = rows.map((row) => ({
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      similarity: Number(row.similarity),
      createdAt: row.createdAt,
    }));

    this.logger.debug(
      `Recalled ${results.length} memories for user ${userId} via similarity${category ? ` (category=${category})` : ""} (query: "${query.slice(0, 60)}…")`,
    );

    return results;
  }

  /**
   * Cosine-similarity search over the user's nightly diary entries. Falls
   * back to recent-by-date if the user has fewer than DIARY_FULL_THRESHOLD
   * entries so a small population is not penalised by a strict similarity
   * floor.
   */
  async recallDiary(
    userId: string,
    query: string,
    topK: number = 3,
  ): Promise<RecalledDiary[]> {
    // Same count()-free shape as recall(): fetch up to DIARY_FULL_RECALL + 1
    // newest entries; row count decides the branch in one round trip.
    const newestRows = await this.prisma.userDiary.findMany({
      where: { userId },
      orderBy: { date: "desc" },
      take: DIARY_FULL_RECALL_THRESHOLD + 1,
      select: { id: true, date: true, entry: true },
    });
    if (newestRows.length === 0) return [];

    if (newestRows.length <= DIARY_FULL_RECALL_THRESHOLD) {
      return newestRows.slice(0, topK).map((r) => ({
        id: r.id,
        date: r.date,
        entry: r.entry,
        similarity: 1,
      }));
    }

    const [queryVector] = await this.embedding.embed([query]);
    const vectorStr = `[${queryVector.join(",")}]`;
    const embeddingColumn = embeddingColumnSql();

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        date: Date;
        entry: string;
        similarity: number;
      }>
    >(Prisma.sql`
      SELECT id, date, entry,
        1 - (${embeddingColumn} <=> ${vectorStr}::vector) AS similarity
      FROM "UserDiary"
      WHERE "userId" = ${userId}
        AND ${embeddingColumn} IS NOT NULL
        AND 1 - (${embeddingColumn} <=> ${vectorStr}::vector) >= 0.30
      ORDER BY ${embeddingColumn} <=> ${vectorStr}::vector
      LIMIT ${topK}
    `);

    return rows.map((r) => ({
      id: r.id,
      date: r.date,
      entry: r.entry,
      similarity: Number(r.similarity),
    }));
  }

  async forget(userId: string, memoryId: string): Promise<boolean> {
    // Same cleanup-first ordering as deleteDocument (see above).
    // Deadline ids up front: the cleanup deletes them, tombstones need the list.
    const deadlineRows = await this.prisma.userDeadline.findMany({
      where: { userId, sourceId: memoryId },
      select: { id: true },
    });
    await this.deadlines.deleteDeadlinesBySource(memoryId, userId);
    const row = await this.prisma.userMemory.findFirst({
      where: { id: memoryId, userId },
      select: { type: true, content: true },
    });
    const deleted = await this.prisma.userMemory.deleteMany({
      where: { id: memoryId, userId },
    });
    if (deleted.count > 0 && deadlineRows.length > 0) {
      // Deadlines sourced from this memory vanish with it — tombstone them
      // so synced clients drop them too.
      await recordTombstones(
        this.prisma,
        userId,
        deadlineRows.map((row) => ({
          collection: "deadline" as const,
          objectId: row.id,
        })),
      );
    }
    // Forgetting the language preference must not leave the 24h lang: cache
    // behind — the user would keep getting answers in the old language.
    if (
      deleted.count > 0 &&
      row?.type === "preference" &&
      row.content.startsWith("language:")
    ) {
      try {
        await this.cache.del(`lang:${userId}`);
      } catch (err) {
        this.logger.warn(
          `lang cache clear failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return deleted.count > 0;
  }

  async list(userId: string): Promise<StoredMemory[]> {
    // Machine-state `preference` rows are not memories — getUserLanguage and
    // the backfill check read them by type directly.
    const rows = await this.prisma.userMemory.findMany({
      where: { userId, type: { not: "preference" } },
      orderBy: { createdAt: "desc" },
    });

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      type: row.type as MemoryType,
      content: row.content,
      contentOriginal: row.contentOriginal ?? null,
      createdAt: row.createdAt,
    }));
  }

  async getUserLanguage(userId: string): Promise<UserLang | null> {
    const cacheKey = `lang:${userId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached !== null) {
      return cached === LANG_CACHE_NONE ? null : (cached as UserLang);
    }

    const row = await this.prisma.userMemory.findFirst({
      where: {
        userId,
        type: "preference",
        content: { startsWith: "language:" },
      },
      // Deterministic latest-wins: a concurrent setUserLanguage race can
      // briefly leave two rows (converged by the post-insert cleanup).
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });
    const rawLang = row ? (row.content.slice("language:".length) as UserLang) : null;
    const lang = rawLang && ["ru", "de", "en", "uk"].includes(rawLang) ? rawLang : null;

    await this.cache.set(cacheKey, lang ?? LANG_CACHE_NONE, LANG_CACHE_TTL_SECONDS);
    return lang;
  }

  async setUserLanguage(userId: string, lang: UserLang): Promise<void> {
    // Remove any existing language preference then insert fresh
    await this.prisma.userMemory.deleteMany({
      where: {
        userId,
        type: "preference",
        content: { startsWith: "language:" },
      },
    });
    const stored = await this.remember(userId, `language:${lang}`, "preference");
    // Cleanup, not just pre-delete: two concurrent calls can both pass the
    // delete above and insert. Deleting strictly-older rows after the insert
    // converges to exactly one row (the latest) — unlike a second
    // delete-others pass, it can never wipe to zero.
    await this.prisma.userMemory.deleteMany({
      where: {
        userId,
        type: "preference",
        content: { startsWith: "language:" },
        createdAt: { lt: stored.createdAt },
      },
    });
    await this.cache.set(`lang:${userId}`, lang, LANG_CACHE_TTL_SECONDS);
  }

  /**
   * GDPR right-to-erasure sweep. Postgres deletion (eleven typed tables plus
   * the LawChunk docvault vectors, see below) is atomic via a single
   * transaction — if it fails, the whole call rejects and nothing is
   * considered deleted. The remaining stores are outside Postgres and
   * cannot join that transaction, so they are cleaned independently on a
   * best-effort basis: each step is isolated, failures are logged and
   * reported via `failures` rather than aborting the sweep.
   */
  async forgetAll(userId: string): Promise<ForgetAllResult> {
    // Synced-row ids up front: the sweep below deletes them, and the Mac
    // client must drop its local copies via tombstones (a device offline
    // during the sweep would otherwise display GDPR-erased rows forever).
    const [syncedDocs, syncedDeadlines, syncedTasks] = await Promise.all([
      this.prisma.userDocument.findMany({
        where: { userId },
        select: { id: true },
      }),
      this.prisma.userDeadline.findMany({
        where: { userId },
        select: { id: true },
      }),
      this.prisma.userTask.findMany({
        where: { userId },
        select: { id: true },
      }),
    ]);
    const [
      memories,
      documents,
      deadlines,
      conversations,
      diaries,
      conflicts,
      batchJobs,
      // macOS companion app tables (see 20260821120000 migration): tasks,
      // device sessions and document tags. Tag LINK rows cascade via FK when
      // their document/tag is deleted.
      tasks,
      deviceSessions,
      documentTags,
      // Document insights (see 20260905120000 migration). Rows also cascade
      // via FK when their parent UserDocument is deleted above — the
      // explicit delete keeps the GDPR sweep complete and counted even if
      // the FK ever changes.
      documentInsights,
      // Personal docvault vectors live in LawChunk (lawId = 'docvault',
      // owner-scoped) — outside the typed deleteMany models because of the
      // pgvector column, so a raw parameterized delete joins the same
      // transaction. Without this, an "erased" user's documents stay
      // searchable via retrieval.
      docvaultChunks,
      // Tombstones join the same atomic transaction: either everything
      // (rows + their sync markers) is gone, or nothing is.
    ] = await this.prisma.$transaction([
      this.prisma.userMemory.deleteMany({ where: { userId } }),
      // Also delete documents (including fullText) to satisfy GDPR right-to-erasure
      this.prisma.userDocument.deleteMany({ where: { userId } }),
      this.prisma.userDeadline.deleteMany({ where: { userId } }),
      this.prisma.conversationLog.deleteMany({ where: { userId } }),
      this.prisma.userDiary.deleteMany({ where: { userId } }),
      this.prisma.conflictPushState.deleteMany({ where: { userId } }),
      this.prisma.batchJobState.deleteMany({ where: { userId } }),
      this.prisma.userTask.deleteMany({ where: { userId } }),
      // Revoking (not just deleting) would also work, but full erasure is the
      // point here — revocation is redundant once the row is gone.
      this.prisma.deviceSession.deleteMany({ where: { userId } }),
      this.prisma.documentTag.deleteMany({ where: { userId } }),
      this.prisma.documentInsight.deleteMany({ where: { userId } }),
      this.prisma.$executeRaw`DELETE FROM "LawChunk" WHERE "lawId" = 'docvault' AND "ownerUserId" = ${userId}`,
      this.prisma.syncTombstone.createMany({
        data: [
          ...syncedDocs.map((row) => ({
            userId,
            collection: "document",
            objectId: row.id,
          })),
          ...syncedDeadlines.map((row) => ({
            userId,
            collection: "deadline",
            objectId: row.id,
          })),
          ...syncedTasks.map((row) => ({
            userId,
            collection: "task",
            objectId: row.id,
          })),
        ],
        skipDuplicates: true,
      }),
    ]);
    const deletedCount =
      memories.count +
      documents.count +
      deadlines.count +
      conversations.count +
      diaries.count +
      conflicts.count +
      batchJobs.count +
      tasks.count +
      deviceSessions.count +
      documentTags.count +
      documentInsights.count +
      Number(docvaultChunks);

    const [
      conversationHistoryOk,
      documentQueueResult,
      nightlyBatchQueueResult,
      letterStylePendingOk,
      letterPdfPendingOk,
      langCacheOk,
      batchSummariesOk,
      summarizeLockOk,
      forgetMarkerOk,
    ] = await Promise.all([
      this.safeClearConversationHistory(userId),
      this.removeQueueJobsForUser(
        this.documentQueue,
        userId,
        "document-queue",
      ),
      this.removeQueueJobsForUser(
        this.nightlyBatchQueue,
        userId,
        "nightly-batch-queue",
      ),
      this.safeDeleteCacheKey(
        `letter_style_pending:${userId}`,
        "letter_style_pending",
        userId,
      ),
      this.safeDeleteCacheKey(
        `letter_pdf_pending:${userId}`,
        "letter_pdf_pending",
        userId,
      ),
      this.safeDeleteCacheKey(`lang:${userId}`, "lang-cache", userId),
      // Nightly block summaries (batchsum:{userId}:{date}) are LLM-written
      // summaries of the user's own conversations, cached for 36 h. They are
      // dated, so there is no single key to delete — SCAN the prefix.
      // Erasure that leaves these behind leaves the erased content readable.
      this.safeDeleteCachePrefix(
        `batchsum:${userId}:`,
        "batch-summaries",
        userId,
      ),
      this.safeDeleteCacheKey(`sumlock:${userId}`, "summarize-lock", userId),
      this.safeSetForgetMarker(userId),
    ]);

    const failures: string[] = [];
    if (!conversationHistoryOk) failures.push("conversation-history");
    if (!documentQueueResult.ok) failures.push("document-queue");
    if (!nightlyBatchQueueResult.ok) failures.push("nightly-batch-queue");
    if (!letterStylePendingOk) failures.push("letter_style_pending");
    if (!letterPdfPendingOk) failures.push("letter_pdf_pending");
    if (!langCacheOk) failures.push("lang-cache");
    if (!batchSummariesOk) failures.push("batch-summaries");
    if (!summarizeLockOk) failures.push("summarize-lock");
    if (!forgetMarkerOk) failures.push("forget-marker");

    if (failures.length > 0) {
      this.logger.warn(
        `forgetAll: completed with partial failures for user ${userId}: ${failures.join(", ")}`,
      );
    } else {
      this.logger.log(`forgetAll: fully erased data for user ${userId}`);
    }

    return {
      deletedCount,
      documentJobsRemoved: documentQueueResult.removed,
      nightlyJobsRemoved: nightlyBatchQueueResult.removed,
      failures,
    };
  }

  private async safeClearConversationHistory(userId: string): Promise<boolean> {
    try {
      await this.conversation.clearHistory(userId);
      return true;
    } catch (err) {
      this.logger.error(
        `forgetAll: failed to clear conversation history for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Prefix variant of safeDeleteCacheKey, for user-scoped key families whose
   * suffix is not knowable here (dated keys). Same failure contract: a throw
   * is an erasure failure, not a warning to swallow.
   */
  private async safeDeleteCachePrefix(
    prefix: string,
    label: string,
    userId: string,
  ): Promise<boolean> {
    try {
      const removed = await this.cache.delByPrefix(prefix);
      if (removed > 0) {
        this.logger.log(
          `forgetAll: removed ${removed} ${label} key(s) for user ${userId}`,
        );
      }
      return true;
    } catch (err) {
      this.logger.error(
        `forgetAll: failed to delete ${label} for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async safeDeleteCacheKey(
    key: string,
    label: string,
    userId: string,
  ): Promise<boolean> {
    try {
      await this.cache.del(key);
      return true;
    } catch (err) {
      this.logger.error(
        `forgetAll: failed to delete ${label} for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Plants the in-flight write guard for forgetAll (see FORGET_MARKER_TTL_SECONDS).
   */
  private async safeSetForgetMarker(userId: string): Promise<boolean> {
    try {
      await this.cache.setJson(
        forgetMarkerKey(userId),
        { at: new Date().toISOString() },
        FORGET_MARKER_TTL_SECONDS,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `forgetAll: failed to set forget-marker for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Removes every waiting/delayed/completed/failed BullMQ job whose payload
   * belongs to `userId`. Active (in-flight) jobs are intentionally left
   * alone — yanking a job mid-processing could corrupt worker state, and it
   * will finish shortly with no further trace once its own retention window
   * (removeOnComplete/removeOnFail) expires.
   */
  private async removeQueueJobsForUser<T extends { userId: string }>(
    queue: Queue<T>,
    userId: string,
    label: string,
  ): Promise<{ removed: number; ok: boolean }> {
    try {
      const jobs = await queue.getJobs([
        "waiting",
        "delayed",
        "completed",
        "failed",
      ]);
      const matching = jobs.filter((job) => job.data.userId === userId);

      let removed = 0;
      for (const job of matching) {
        try {
          await job.remove();
          removed += 1;
        } catch (err) {
          this.logger.warn(
            `forgetAll: failed to remove ${label} job ${String(job.id)} for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Partial removal is still an erasure failure — any job left behind
      // keeps the user's payload (fileName/caption/userId) in Redis, so it
      // must surface in `failures` instead of claiming full success.
      return { removed, ok: removed === matching.length };
    } catch (err) {
      this.logger.error(
        `forgetAll: failed to enumerate ${label} jobs for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { removed: 0, ok: false };
    }
  }
}
