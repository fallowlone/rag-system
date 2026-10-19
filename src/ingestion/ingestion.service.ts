import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import pLimit from "p-limit";
import { PrismaService } from "../prisma/prisma.service";
import { LawFetcherService } from "./law-fetcher.service";
import { EmbeddingService } from "./embedding.service";
import { IngestionAllResult, IngestionResult } from "./ingestion.types";
import { resolveRoomForLaw } from "./law-room-map";

// Per-law concurrency. Each in-flight law runs its own XML parse/chunking on
// the event loop plus a few concurrent /embed batches (see
// LocalEmbeddingProvider), so 8 keeps the pipeline network-bound without
// starving the bot process. Together with batch concurrency 6 this lifts the
// old effective parallelism of 3 laws × 1 in-flight batch to ~48 batches.
const MAX_CONCURRENT_LAWS = 8;

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  // Overlap guards: POST /admin/ingest[/:lawId] returns 202 and runs in the
  // background, so a double POST (retry, two admins) would otherwise run two
  // full reindexes concurrently — double embedding cost plus two writers
  // racing on the same lawId's chunks. Flags are set synchronously on entry
  // (before the first await), so same-process check-then-act is race-free.
  private ingestAllRunning = false;
  private readonly lawsInProgress = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcher: LawFetcherService,
    private readonly embedding: EmbeddingService,
  ) {}

  /** Sync pre-check for the 202 controller: honest 409 instead of a run that instantly fails. */
  get ingestAllInProgress(): boolean {
    return this.ingestAllRunning;
  }

  /** Sync pre-check for the 202 controller (per-law). */
  isLawInProgress(lawId: string): boolean {
    return this.lawsInProgress.has(lawId);
  }

  async ingestLaw(lawId: string): Promise<IngestionResult> {
    if (this.lawsInProgress.has(lawId)) {
      throw new ConflictException(`Ingestion of '${lawId}' already running`);
    }
    this.lawsInProgress.add(lawId);
    try {
      return await this.runIngestLaw(lawId);
    } finally {
      this.lawsInProgress.delete(lawId);
    }
  }

  private async runIngestLaw(lawId: string): Promise<IngestionResult> {
    const law = await this.prisma.law.findUniqueOrThrow({
      where: { id: lawId },
    });

    this.logger.log(`[${lawId}] Starting ingestion…`);

    const result = await this.fetcher.fetchLaw(law);

    if (result.skipped) {
      this.logger.log(`[${lawId}] Checksum unchanged, skipping`);
      return { lawId, chunksInserted: 0, skipped: true };
    }

    const { chunks, checksum, etag } = result;

    if (chunks.length === 0) {
      this.logger.warn(`[${lawId}] No chunks extracted, skipping`);
      return { lawId, chunksInserted: 0, skipped: false };
    }

    // chunk.text already contains lawTitle + normKey + heading as context prefix
    const texts = chunks.map((c) => c.text);
    const roomId = resolveRoomForLaw(lawId);

    this.logger.log(`[${lawId}] Embedding ${chunks.length} chunks…`);
    const embeddings = await this.embedding.embed(texts);

    // Atomic replace: delete old chunks and insert new ones in one transaction,
    // batched to cut per-row round trips. A failure anywhere rolls back the
    // delete too, so the law never ends up with 0/partial chunks.
    const INSERT_BATCH = 500;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.lawChunk.deleteMany({ where: { lawId } });

        for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
          const slice = chunks.slice(i, i + INSERT_BATCH);
          const rows = slice.map((chunk, j) => {
            const embedding = embeddings[i + j];
            if (!embedding) {
              throw new Error(
                `[${lawId}] Missing embedding for chunk index ${i + j}`,
              );
            }
            const id = randomUUID();
            const vectorStr = `[${embedding.join(",")}]`;
            return Prisma.sql`(${id}, ${lawId}, ${chunk.normKey}, ${chunk.heading}, ${chunk.text}, ${vectorStr}::vector, NOW(), ${roomId})`;
          });

          await tx.$executeRaw(
            Prisma.sql`INSERT INTO "LawChunk" (id, "lawId", "normKey", heading, text, "embeddingBge", "createdAt", "roomId") VALUES ${Prisma.join(rows)}`,
          );
        }

        await tx.law.update({
          where: { id: lawId },
          data: { checksum, etag, lastFetched: new Date() },
        });
      },
      { timeout: 120_000 },
    );

    this.logger.log(`[${lawId}] Ingested ${chunks.length} chunks`);
    return { lawId, chunksInserted: chunks.length, skipped: false };
  }

  async ingestAll(): Promise<IngestionAllResult> {
    if (this.ingestAllRunning) {
      throw new ConflictException("Full ingestion already running");
    }
    this.ingestAllRunning = true;
    try {
      return await this.runIngestAll();
    } finally {
      this.ingestAllRunning = false;
    }
  }

  private async runIngestAll(): Promise<IngestionAllResult> {
    const laws = await this.prisma.law.findMany({ select: { id: true } });
    this.logger.log(`Starting full ingestion of ${laws.length} laws…`);

    const limit = pLimit(MAX_CONCURRENT_LAWS);

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let totalChunks = 0;
    let empty = 0;

    await Promise.all(
      laws.map(({ id }) =>
        limit(async () => {
          try {
            const result = await this.ingestLaw(id);
            if (result.skipped) {
              skipped++;
            } else if (result.chunksInserted === 0) {
              empty++;
            } else {
              processed++;
              totalChunks += result.chunksInserted;
            }
          } catch (err) {
            failed++;
            this.logger.error(
              `[${id}] Ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
              err instanceof Error ? err.stack : undefined,
            );
          }
        }),
      ),
    );

    this.logger.log(
      `Ingestion complete — processed: ${processed}, skipped: ${skipped}, failed: ${failed}, chunks: ${totalChunks}`,
    );

    return { processed, skipped, failed, totalChunks, empty };
  }
}
