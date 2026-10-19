import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "../prisma/prisma.module";
import { IngestionModule } from "../ingestion/ingestion.module";
import { TelegramModule } from "../telegram/telegram.module";
import { NIGHTLY_BATCH_QUEUE } from "./batch.types";
import { BatchLlmService } from "./batch-llm.service";
import { NightlyBatchScheduler } from "./nightly-scheduler.service";
import { NightlyBatchProcessor } from "./nightly-batch.processor";
import { ConflictPushService } from "./conflict-push.service";

@Module({
  imports: [
    PrismaModule,
    IngestionModule,
    TelegramModule,
    BullModule.registerQueue({ name: NIGHTLY_BATCH_QUEUE }),
  ],
  providers: [
    BatchLlmService,
    NightlyBatchScheduler,
    NightlyBatchProcessor,
    ConflictPushService,
  ],
  exports: [ConflictPushService],
})
export class BatchModule {}
