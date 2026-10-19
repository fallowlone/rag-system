import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { BullModule } from "@nestjs/bullmq";
import { APP_GUARD } from "@nestjs/core";
import { CacheModule } from "./cache/cache.module";
import { PrismaModule } from "./prisma/prisma.module";
import { IngestionModule } from "./ingestion/ingestion.module";
import { RagModule } from "./rag/rag.module";
import { MemoryModule } from "./memory/memory.module";
import { ConversationModule } from "./conversation/conversation.module";
import { TelegramModule } from "./telegram/telegram.module";
import { AdminModule } from "./admin/admin.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PdfModule } from "./pdf/pdf.module";
import { HealthModule } from "./health/health.module";
import { BatchModule } from "./batch/batch.module";
import { DocumentJobNotifierModule } from "./documents/queue/document-job-notifier.module";
import { AppApiModule } from "./app-api/app-api.module";

function parseRedisUrl(): {
  host: string;
  port: number;
  password?: string;
  db?: number;
} {
  const raw = process.env.REDIS_URL;
  if (!raw) {
    throw new Error("REDIS_URL is required for BullMQ");
  }
  const url = new URL(raw);
  // BullMQ Workers require maxRetriesPerRequest: null on the underlying ioredis
  // connection; that flag is set on the Bull connection-options object below,
  // not here.
  return {
    host: url.hostname,
    port: Number.parseInt(url.port || "6379", 10),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname.length > 1
      ? Number.parseInt(url.pathname.slice(1), 10)
      : undefined,
  };
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 30 }]),
    BullModule.forRoot({
      connection: {
        ...parseRedisUrl(),
        // BullMQ Workers must not have a request-retry cap; setting it would
        // make the blocking BRPOP loop give up after a few seconds.
        maxRetriesPerRequest: null,
      },
    }),
    CacheModule,
    PrismaModule,
    PdfModule,
    IngestionModule,
    RagModule,
    MemoryModule,
    ConversationModule,
    DocumentJobNotifierModule,
    AppApiModule,
    TelegramModule,
    AdminModule,
    NotificationsModule,
    HealthModule,
    BatchModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
