import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { IngestionModule } from "../ingestion/ingestion.module";
import { DeadlinesModule } from "../deadlines/deadlines.module";
import { DOCUMENT_JOB_QUEUE } from "../documents/queue/document-job.types";
import { NIGHTLY_BATCH_QUEUE } from "../batch/batch.types";
import { UserMemoryService } from "./user-memory.service";
import { MemoryTranslationService } from "./memory-translation.service";

@Module({
  imports: [
    IngestionModule,
    DeadlinesModule,
    // Registered here (by name only) so forgetAll's GDPR sweep can remove
    // this user's jobs from both queues. ConversationService and
    // CacheService are @Global() providers (ConversationModule,
    // CacheModule) so they need no explicit import. This avoids a module
    // cycle: MemoryModule never imports DocumentsModule or BatchModule
    // (both of which already depend on TelegramModule, which in turn
    // depends on MemoryModule) — it only registers the same named BullMQ
    // queues those modules use, which BullMQ supports from any number of
    // modules since the queue itself lives in Redis, not in module state.
    BullModule.registerQueue({ name: DOCUMENT_JOB_QUEUE }),
    BullModule.registerQueue({ name: NIGHTLY_BATCH_QUEUE }),
  ],
  providers: [UserMemoryService, MemoryTranslationService],
  exports: [UserMemoryService, MemoryTranslationService],
})
export class MemoryModule {}
