import { Logger } from "@nestjs/common";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import Anthropic from "@anthropic-ai/sdk";
import { Job, RateLimitError, UnrecoverableError } from "bullmq";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "../ingestion/embedding.service";
import { embeddingColumnSql } from "../ingestion/embedding-storage";
import { CacheService } from "../cache/cache.service";
import { forgetMarkerKey } from "../memory/user-memory.service";
import { BatchLlmService, BlockSummary } from "./batch-llm.service";
import { splitIntoBlocks } from "./block-splitter";
import { berlinDayEnd } from "./berlin-day";
import {
  NIGHTLY_BATCH_QUEUE,
  NightlyBatchPayload,
} from "./batch.types";

const WING = "user_chat";
const ROOM = "diary";

// Cosine similarity at or above which a freshly extracted fact is treated as
// a duplicate of something already in UserMemory and dropped silently.
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

// Lower bound of the conflict band. Below this, the fact is net-new; between
// this and DEDUP_SIMILARITY_THRESHOLD the fact is filed as a pending
// conflict for the user to resolve.
const CONFLICT_SIMILARITY_THRESHOLD = 0.55;

// Transient Anthropic 429s pause the whole worker (both slots) and redeliver
// the job without consuming an attempt — same pattern as DocumentProcessor.
const NIGHTLY_RATE_LIMIT_BACKOFF_MS = 90_000;

// Upper bound on Haiku summarize calls per run. Session blocks are split on
// 15-minute gaps, so a marathon chat day could otherwise mean hundreds of
// serial LLM calls (and a multi-hour job). The most recent blocks win —
// recency bias is the standard choice for a memory-consolidation pass.
const MAX_BLOCKS_PER_RUN = 48;

// Retry checkpoint: block summaries are cached per (user, day) so a retry
// after a partial failure (or a nightly re-enqueue of a failed day) skips
// re-paying every Haiku summarize call. 36h covers the 3-attempt window plus
// a next-night re-enqueue; ConversationLog rows for a fixed past day are
// append-only, so cached summaries stay valid.
const SUMMARIES_CACHE_TTL_SECONDS = 36 * 60 * 60;

// Upper bound on the <already_known> context for fact extraction (matches
// BatchLlmService's per-call cap).
const MAX_EXISTING_FACTS = 50;

// How long a "running" row may sit untouched before a retry may take it.
// Two lock durations (the @Processor lockDuration below): the lock auto-renews
// while the worker lives, so a row older than that has no live owner.
const STALE_RUN_MS = 2 * 180_000;

interface CachedBlockSummary {
  summary: string;
  startedAtIso: string;
}

function isCachedBlockSummary(value: unknown): value is CachedBlockSummary {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.summary === "string" &&
    typeof candidate.startedAtIso === "string" &&
    !Number.isNaN(Date.parse(candidate.startedAtIso))
  );
}

@Processor(NIGHTLY_BATCH_QUEUE, {
  concurrency: 2,
  // Serial Haiku summarize loops on marathon days run for minutes; 30s
  // default lock TTL risks false-stall redelivery alongside the live run
  // (same rationale as the document queue — see document.processor.ts).
  lockDuration: 180_000,
  stalledInterval: 60_000,
})
export class NightlyBatchProcessor extends WorkerHost {
  private readonly logger = new Logger(NightlyBatchProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly llm: BatchLlmService,
    private readonly cache: CacheService,
  ) {
    super();
  }

  async process(job: Job<NightlyBatchPayload>): Promise<void> {
    const { userId, processedDateIso } = job.data;
    const processedDate = new Date(processedDateIso);

    if (Number.isNaN(processedDate.getTime())) {
      throw new UnrecoverableError(
        `Invalid processedDateIso: ${processedDateIso}`,
      );
    }

    // Atomic claim: at most one run per (user, day) proceeds. A second
    // delivery (re-dispatch after a Redis flush, which wipes the stable BullMQ
    // jobId records, or two workers) skips quietly instead of double-paying
    // the LLM calls and fabricating conflicts from paraphrase drift between
    // the two runs. Skipping returns normally so no retry is burned.
    const claimed = await this.claimRun(userId, processedDate, job);
    if (!claimed) {
      this.logger.log(
        `Skipping ${userId}@${processedDateIso} — already completed or claimed by a concurrent run`,
      );
      return;
    }

    try {
      const stats = await this.runBatch(userId, processedDate);
      await this.prisma.batchJobState.update({
        where: { userId_processedDate: { userId, processedDate } },
        data: {
          status: "completed",
          factsExtracted: stats.factsExtracted,
          factsConflicts: stats.conflicts,
          completedAt: new Date(),
          errorMessage: null,
        },
      });
      this.logger.log(
        `Batch for ${userId}@${processedDateIso} done: ${stats.factsExtracted} facts, ${stats.conflicts} conflicts, diary ${stats.diaryWritten ? "written" : "skipped"}`,
      );
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        // Transient: pause the worker and let BullMQ redeliver the same job
        // after the cooldown WITHOUT consuming an attempt. The day is marked
        // failed (not left running) so the retry — or the nightly
        // failed-day scan if the job record is ever lost — can reclaim it.
        await this.prisma.batchJobState.update({
          where: { userId_processedDate: { userId, processedDate } },
          data: {
            status: "failed",
            errorMessage:
              "anthropic rate limit — retrying without consuming an attempt",
          },
        });
        this.logger.warn(
          `Rate limit hit on nightly batch for ${userId}@${processedDateIso}; rate-limiting worker for ${NIGHTLY_RATE_LIMIT_BACKOFF_MS}ms`,
        );
        await this.worker.rateLimit(NIGHTLY_RATE_LIMIT_BACKOFF_MS);
        // RateLimitError is the documented signal that re-queues the job
        // without incrementing attemptsMade.
        throw new RateLimitError();
      }
      await this.prisma.batchJobState.update({
        where: { userId_processedDate: { userId, processedDate } },
        data: {
          status: "failed",
          errorMessage:
            err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
      });
      throw err;
    }
  }

  /**
   * Single atomic transition into "running". Returns true exactly once per
   * (user, day) execution — concurrent deliveries lose and skip.
   */
  private async claimRun(
    userId: string,
    processedDate: Date,
    job: Job<NightlyBatchPayload>,
  ): Promise<boolean> {
    // GDPR race (mirrors the document pipeline's forget-marker check): an
    // active nightly job outliving the user's erasure must not rewrite
    // facts for a wiped user. A Redis error throws (fail-closed toward a
    // retry, which re-checks) rather than writing blind.
    if (await this.cache.getJson(forgetMarkerKey(userId))) {
      this.logger.warn(
        `Nightly batch for ${userId}: forget-marker present (erased) — skipping`,
      );
      return false;
    }

    const existing = await this.prisma.batchJobState.findUnique({
      where: { userId_processedDate: { userId, processedDate } },
    });
    if (existing?.status === "completed") return false;

    if (!existing) {
      try {
        await this.prisma.batchJobState.create({
          data: {
            userId,
            processedDate,
            status: "running",
            startedAt: new Date(),
            factsExtracted: 0,
            factsConflicts: 0,
          },
        });
        return true;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          this.logger.warn(
            `Nightly batch overlap for ${userId}: concurrent run created the state row — skipping`,
          );
          return false;
        }
        throw err;
      }
    }

    if (existing.status === "running") {
      // A retry of the SAME job (attemptsMade > 0) suggests its previous
      // attempt died without finalizing — but that is only a suggestion.
      // Worker concurrency is 2 and BullMQ redelivers on a stalled lock, so
      // the original attempt can still be alive; stealing then gives two runs
      // the same day, double LLM spend, and conflicts fabricated from
      // paraphrase drift between them. Require the run to be older than the
      // worker's own lock duration before taking it, and make the steal
      // itself conditional on that so a run that finalizes between the read
      // and the write cannot be overwritten.
      if (job.attemptsMade > 0) {
        const staleBefore = new Date(Date.now() - STALE_RUN_MS);
        const stolen = await this.prisma.batchJobState.updateMany({
          where: {
            userId,
            processedDate,
            status: "running",
            // NULL covers rows written before startedAt existed: they stay
            // stealable, exactly as they were.
            OR: [{ startedAt: null }, { startedAt: { lt: staleBefore } }],
          },
          data: { errorMessage: null, startedAt: new Date() },
        });
        if (stolen.count === 1) {
          this.logger.warn(
            `Nightly batch for ${userId}: reclaiming stale running state on retry ${job.attemptsMade}`,
          );
          return true;
        }
        this.logger.log(
          `Nightly batch for ${userId}: a run started less than ${STALE_RUN_MS}ms ago still owns this day — not stealing`,
        );
      }
      return false;
    }

    // "failed" (or any other non-terminal state): one atomic transition wins.
    const claimed = await this.prisma.batchJobState.updateMany({
      where: {
        userId,
        processedDate,
        status: { notIn: ["running", "completed"] },
      },
      data: { status: "running", errorMessage: null, startedAt: new Date() },
    });
    return claimed.count === 1;
  }

  private async runBatch(
    userId: string,
    processedDate: Date,
  ): Promise<{
    factsExtracted: number;
    diaryWritten: boolean;
    conflicts: number;
  }> {
    const dayEnd = berlinDayEnd(processedDate);

    const messages = await this.prisma.conversationLog.findMany({
      where: { userId, createdAt: { gte: processedDate, lt: dayEnd } },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true, createdAt: true },
    });

    if (messages.length === 0) {
      this.logger.log(
        `No messages for ${userId}@${processedDate.toISOString()} — skipping`,
      );
      return { factsExtracted: 0, diaryWritten: false, conflicts: 0 };
    }

    const blocks = splitIntoBlocks(messages);
    // Most recent blocks win (see MAX_BLOCKS_PER_RUN).
    const cappedBlocks = blocks.slice(-MAX_BLOCKS_PER_RUN);
    if (cappedBlocks.length < blocks.length) {
      this.logger.warn(
        `User ${userId}: ${messages.length} messages → ${blocks.length} block(s), truncated to ${cappedBlocks.length}`,
      );
    } else {
      this.logger.debug(
        `User ${userId}: ${messages.length} messages → ${blocks.length} block(s)`,
      );
    }

    const summaries = await this.loadOrSummarizeBlocks(
      userId,
      processedDate,
      cappedBlocks,
    );

    // Facts the real-time path (UserMemoryService.extractAndSave) already
    // saved for this user today — passed to extractFacts so it narrows to
    // genuinely new (mostly cross-message) facts instead of re-extracting
    // ones already covered. See BatchLlmService.extractFacts for why.
    const existingFactRows = await this.prisma.userMemory.findMany({
      where: {
        userId,
        type: "fact",
        status: "active",
        createdAt: { gte: processedDate, lt: dayEnd },
      },
      select: { content: true },
      take: MAX_EXISTING_FACTS,
    });
    const existingFacts = existingFactRows.map((r) => r.content);

    const [diary, facts] = await Promise.all([
      this.llm.writeDiary(summaries),
      this.llm.extractFacts(summaries, existingFacts),
    ]);

    const diaryWritten = await this.upsertDiary(userId, processedDate, diary);

    let inserted = 0;
    let conflicts = 0;
    if (facts.length > 0) {
      const result = await this.insertFactMemories(userId, facts);
      inserted = result.inserted;
      conflicts = result.conflicts;
    }

    return {
      factsExtracted: inserted,
      diaryWritten,
      conflicts,
    };
  }

  /**
   * Retry checkpoint for the serial Haiku summarize loop. Summaries are
   * cached per (user, day); a retry reuses them instead of re-paying every
   * call. The cache is best-effort — any shape mismatch or Redis error falls
   * back to a full summarize pass.
   */
  private async loadOrSummarizeBlocks(
    userId: string,
    processedDate: Date,
    blocks: ReturnType<typeof splitIntoBlocks>,
  ): Promise<BlockSummary[]> {
    const key = `batchsum:${userId}:${processedDate.toISOString()}`;

    try {
      const cached: unknown = await this.cache.getJson(key);
      if (Array.isArray(cached) && cached.every(isCachedBlockSummary)) {
        this.logger.log(
          `User ${userId}: reusing ${cached.length} cached block summaries for ${processedDate.toISOString()}`,
        );
        return cached.map((c) => ({
          summary: c.summary,
          startedAt: new Date(c.startedAtIso),
          endedAt: new Date(c.startedAtIso),
          messageCount: 0,
        }));
      }
    } catch (err) {
      this.logger.warn(
        `Summaries cache read failed, re-summarizing: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const summaries: BlockSummary[] = [];
    for (const block of blocks) {
      summaries.push(await this.llm.summarizeBlock(block));
    }

    try {
      await this.cache.setJson(
        key,
        summaries.map((s) => ({
          summary: s.summary,
          startedAtIso: s.startedAt.toISOString(),
        })),
        SUMMARIES_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `Summaries cache write failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return summaries;
  }

  private async upsertDiary(
    userId: string,
    date: Date,
    entry: string,
  ): Promise<boolean> {
    if (!entry || entry.length === 0) return false;

    const [vector] = await this.embedding.embed([entry]);
    if (!vector) {
      this.logger.warn(
        `Embedding failed for diary ${userId}@${date.toISOString()} — skipping insert`,
      );
      return false;
    }
    const vectorStr = `[${vector.join(",")}]`;
    const embeddingColumn = embeddingColumnSql();

    // pgvector + Prisma's relational API don't compose; fall back to raw SQL
    // with a parametrised UPSERT keyed on (userId, date).
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "UserDiary" (id, "userId", date, entry, ${embeddingColumn}, "createdAt")
      VALUES (${randomUUID()}, ${userId}, ${date}, ${entry}, ${vectorStr}::vector, NOW())
      ON CONFLICT ("userId", date) DO UPDATE
        SET entry = EXCLUDED.entry,
            ${embeddingColumn} = EXCLUDED.${embeddingColumn},
            embedding = NULL
    `);
    return true;
  }

  private async insertFactMemories(
    userId: string,
    facts: string[],
  ): Promise<{ inserted: number; skipped: number; conflicts: number }> {
    const vectors = await this.embedding.embed(facts);
    const embeddingColumn = embeddingColumnSql();

    let inserted = 0;
    let skipped = 0;
    let conflicts = 0;

    await this.prisma.$transaction(async (tx) => {
      // Phase 1: run all per-fact ANN lookups in parallel (read-only, no
      // writes yet) instead of one-at-a-time — was N sequential round trips
      // per batch. Every lookup sees the same pre-batch DB snapshot, so two
      // near-duplicate facts extracted together in the same nightly run are
      // no longer cross-checked against each other (only against what was
      // already active before this run) — an accepted trade-off: the LLM's
      // single JSON-array response for the day rarely contains true
      // duplicates, unlike genuinely separate facts across different days.
      const lookups = await Promise.all(
        facts.map(async (content, i) => {
          const vector = vectors[i];
          if (!vector) return { content, vectorStr: null, top: undefined };
          const vectorStr = `[${vector.join(",")}]`;

          // Cosine match against active memories only — we do not want a
          // half-resolved conflict to keep firing fresh conflict groups.
          const matches = await tx.$queryRaw<
            Array<{ id: string; similarity: number }>
          >(Prisma.sql`
            SELECT id, 1 - (${embeddingColumn} <=> ${vectorStr}::vector) AS similarity
            FROM "UserMemory"
            WHERE "userId" = ${userId}
              AND ${embeddingColumn} IS NOT NULL
              AND status = 'active'
            ORDER BY ${embeddingColumn} <=> ${vectorStr}::vector
            LIMIT 1
          `);

          return { content, vectorStr, top: matches[0] };
        }),
      );

      // Phase 2: sequential writes based on each lookup's decision.
      for (const { content, vectorStr, top } of lookups) {
        if (!vectorStr) {
          skipped += 1;
          continue;
        }

        const topSim = top ? Number(top.similarity) : 0;

        if (topSim >= DEDUP_SIMILARITY_THRESHOLD) {
          skipped += 1;
          continue;
        }

        if (top && topSim >= CONFLICT_SIMILARITY_THRESHOLD) {
          // Grey band — file both rows under a fresh conflict group and let
          // the morning push job ask the user which one is right.
          const groupId = randomUUID();

          await tx.$executeRaw`
            UPDATE "UserMemory"
            SET status = 'pending', "conflictGroupId" = ${groupId}
            WHERE id = ${top.id} AND "userId" = ${userId}
          `;

          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "UserMemory"
              (id, "userId", type, content, "contentOriginal", ${embeddingColumn},
               "sourceHash", "documentId", wing, room, status,
               "conflictGroupId", "createdAt")
            VALUES (
              ${randomUUID()},
              ${userId},
              ${"fact"},
              ${content},
              ${null},
              ${vectorStr}::vector,
              ${null},
              ${null},
              ${WING},
              ${ROOM},
              ${"pending"},
              ${groupId},
              NOW()
            )
          `);

          await tx.$executeRaw`
            INSERT INTO "ConflictPushState"
              ("conflictGroupId", "userId", "lastPushedAt", "pushCount")
            VALUES (${groupId}, ${userId}, NOW(), ${0})
            ON CONFLICT ("conflictGroupId") DO NOTHING
          `;

          conflicts += 1;
          continue;
        }

        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "UserMemory"
            (id, "userId", type, content, "contentOriginal", ${embeddingColumn},
             "sourceHash", "documentId", wing, room, status, "createdAt")
          VALUES (
            ${randomUUID()},
            ${userId},
            ${"fact"},
            ${content},
            ${null},
            ${vectorStr}::vector,
            ${null},
            ${null},
            ${WING},
            ${ROOM},
            ${"active"},
            NOW()
          )
        `);
        inserted += 1;
      }
    });

    if (skipped > 0 || conflicts > 0) {
      this.logger.debug(
        `User ${userId}: ${inserted} inserted, ${skipped} dedup-skipped, ${conflicts} conflict group(s) opened`,
      );
    }
    return { inserted, skipped, conflicts };
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<NightlyBatchPayload> | undefined, err: Error): void {
    if (!job) return;
    this.logger.error(
      `Nightly batch ${job.id} attempt ${job.attemptsMade} failed: ${err.message.slice(0, 200)}`,
    );
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<NightlyBatchPayload>): void {
    this.logger.debug(`Nightly batch ${job.id} completed`);
  }
}
