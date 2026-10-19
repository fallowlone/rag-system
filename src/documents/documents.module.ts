import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { DOCUMENT_JOB_QUEUE } from "./queue/document-job.types";
import { DocumentQueueService } from "./queue/document-queue.service";
import { DocumentProcessor } from "./queue/document.processor";

// DOCUMENT_JOB_NOTIFIER (injected by DocumentProcessor) comes from the
// @Global() DocumentJobNotifierModule imported in AppModule — not imported
// here, since that's exactly the reverse-import that used to make this
// module circularly depend on TelegramModule (see document-job-notifier.ts).
@Module({
  imports: [BullModule.registerQueue({ name: DOCUMENT_JOB_QUEUE })],
  providers: [DocumentQueueService, DocumentProcessor],
  exports: [DocumentQueueService],
})
export class DocumentsModule {}
