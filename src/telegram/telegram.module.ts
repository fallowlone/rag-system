import { Module } from "@nestjs/common";
import { RagModule } from "../rag/rag.module";
import { MemoryModule } from "../memory/memory.module";
import { DeadlinesModule } from "../deadlines/deadlines.module";
import { DocumentsModule } from "../documents/documents.module";
import { AppApiModule } from "../app-api/app-api.module";
import { VisionModule } from "../vision/vision.module";
import { TelegramService } from "./telegram.service";

// No forwardRef needed: DocumentsModule no longer imports TelegramModule
// back (DocumentProcessor depends on the DOCUMENT_JOB_NOTIFIER port instead —
// see documents/queue/document-job-notifier.ts), so this is a plain
// one-directional import.
// AppApiModule is imported for AppAuthService (the /pair command mints a
// one-time pairing code); AppApiModule itself never imports TelegramModule,
// so no cycle is created.
@Module({
  imports: [RagModule, MemoryModule, DeadlinesModule, DocumentsModule, AppApiModule, VisionModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
