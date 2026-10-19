import { ConflictException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { GiiCrawlerService } from "./gii-crawler.service";
import { IngestionService } from "./ingestion.service";

@Injectable()
export class SyncSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SyncSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crawler: GiiCrawlerService,
    private readonly ingestion: IngestionService,
  ) {}

  async onModuleInit(): Promise<void> {
    const chunkCount = await this.prisma.lawChunk.count();

    if (chunkCount === 0) {
      this.logger.log(
        "Empty database detected. Starting initial full ingestion in the background. " +
          "This may take 10–30 minutes depending on network speed.",
      );
      // Fire and forget — the app finishes booting and accepts bot messages
      // while ingestion runs. Users will get "no results" until it completes.
      void this.fullSync().catch((err: unknown) => {
        this.logger.error(
          "Initial ingestion failed",
          err instanceof Error ? err.stack : String(err),
        );
      });
    }
  }

  /**
   * Full sync: every Sunday at 02:00 UTC.
   * Discovers new laws via the GII index, upserts them, then ingests all.
   */
  @Cron("0 2 * * 0")
  async fullSync(): Promise<void> {
    const startedAt = new Date();
    this.logger.log(`Full sync started at ${startedAt.toISOString()}`);

    const laws = await this.crawlIndex("Full sync");
    if (!laws) return;
    this.logger.log(`Discovered ${laws.length} laws. Beginning ingestion…`);

    const result = await this.runIngestAll("Full sync");
    if (!result) return;

    const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
    this.logger.log(
      `Full sync finished at ${new Date().toISOString()} (${elapsed}s) — ` +
        `processed: ${result.processed}, skipped: ${result.skipped}, ` +
        `failed: ${result.failed}, chunks inserted: ${result.totalChunks}, ` +
        `empty: ${result.empty}`,
    );
  }

  /**
   * Daily changed-only sync: every day at 03:00 UTC.
   * Re-ingests only laws whose XML has changed (checksum mismatch).
   * Does NOT call the crawler, so no new laws are discovered.
   */
  @Cron("0 3 * * *")
  async dailySync(): Promise<void> {
    const startedAt = new Date();
    this.logger.log(`Daily sync started at ${startedAt.toISOString()}`);

    const result = await this.runIngestAll("Daily sync");
    if (!result) return;

    const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
    this.logger.log(
      `Daily sync finished at ${new Date().toISOString()} (${elapsed}s) — ` +
        `processed: ${result.processed}, skipped: ${result.skipped}, ` +
        `failed: ${result.failed}, chunks inserted: ${result.totalChunks}, ` +
        `empty: ${result.empty}`,
    );
  }

  /**
   * Index crawl guarded the same way: a TOC outage at 02:00 on Sunday must
   * skip the tick, never throw out of the cron handler (fail-fast exit
   * would take the whole bot down over a background crawl). Returns null
   * when the tick was skipped.
   */
  private async crawlIndex(
    label: string,
  ): Promise<Awaited<ReturnType<GiiCrawlerService["fetchIndex"]>> | null> {
    try {
      const laws = await this.crawler.fetchIndex();
      await this.crawler.upsertLaws(laws);
      return laws;
    } catch (err) {
      this.logger.warn(
        `${label} skipped: law index crawl failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Overlap-safe ingestAll for cron triggers: a still-running full ingest
   * (Sunday fullSync overlapping dailySync, or a manual admin trigger)
   * reads as "skip this tick", not as a crash — and since an unhandled
   * cron throw now exits the process (fail-fast on floating rejections),
   * letting the 409 propagate would turn a benign overlap into an outage.
   * Returns null when the tick was skipped.
   */  private async runIngestAll(
    label: string,
  ): Promise<Awaited<ReturnType<IngestionService["ingestAll"]>> | null> {
    try {
      return await this.ingestion.ingestAll();
    } catch (err) {
      if (err instanceof ConflictException) {
        this.logger.warn(
          `${label} skipped: a full ingestion is already running`,
        );
        return null;
      }
      throw err;
    }
  }
}
