import { Module } from "@nestjs/common";
import { GiiCrawlerService } from "./gii-crawler.service";
import { LawFetcherService } from "./law-fetcher.service";
import { EmbeddingService } from "./embedding.service";
import { EMBEDDING_PROVIDER } from "./ingestion.types";
import { LocalEmbeddingProvider } from "./local-embedding.provider";
import { IngestionService } from "./ingestion.service";
import { SyncSchedulerService } from "./sync-scheduler.service";

@Module({
  providers: [
    GiiCrawlerService,
    LawFetcherService,
    {
      provide: EMBEDDING_PROVIDER,
      useClass: LocalEmbeddingProvider,
    },
    EmbeddingService,
    IngestionService,
    SyncSchedulerService,
  ],
  // EmbeddingService exported for RagModule; IngestionService exported for SyncSchedulerService
  // (same module, but explicit export makes the dependency graph clear)
  exports: [EmbeddingService, IngestionService, EMBEDDING_PROVIDER],
})
export class IngestionModule {}
