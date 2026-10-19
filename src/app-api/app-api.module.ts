import { Module } from "@nestjs/common";
import { RagModule } from "../rag/rag.module";
import { MemoryModule } from "../memory/memory.module";
import { DeadlinesModule } from "../deadlines/deadlines.module";
import { AppAuthService } from "./app-auth.service";
import { AppAuthGuard } from "./app-auth.guard";
import { AppDocumentsService } from "./app-documents.service";
import { AppDocumentAskService } from "./app-document-ask.service";
import { DocumentAnalysisService } from "./document-analysis.service";
import { AppHintsService } from "./app-hints.service";
import { DocumentQualityService } from "./document-quality.service";
import { AppTasksService } from "./app-tasks.service";
import { AppChatService } from "./app-chat.service";
import { AppSyncService } from "./app-sync.service";
import { AppAuthController } from "./app-auth.controller";
import { AppDocumentsController } from "./app-documents.controller";
import { AppTasksController } from "./app-tasks.controller";
import { AppChatController } from "./app-chat.controller";
import { AppSyncController } from "./app-sync.controller";
import { AppMetaController } from "./app-meta.controller";
import { AppHintsController } from "./app-hints.controller";
import { AppDeadlinesController } from "./app-deadlines.controller";
import { AppScanController } from "./app-scan.controller";
import { VisionModule } from "../vision/vision.module";

/**
 * HTTP API for the macOS companion app ("Dokumente").
 *
 * No TelegramModule import here — TelegramModule imports AppApiModule (for
 * AppAuthService used by the /pair command), so a reverse import would create
 * a cycle. PrismaService/CacheService/ConversationService are @Global().
 */
@Module({
  imports: [RagModule, MemoryModule, DeadlinesModule, VisionModule],
  controllers: [
    AppAuthController,
    AppMetaController,
    AppDocumentsController,
    AppTasksController,
    AppDeadlinesController,
    AppChatController,
    AppSyncController,
    AppHintsController,
    AppScanController,
  ],
  providers: [
    AppAuthService,
    AppAuthGuard,
    AppDocumentsService,
    AppDocumentAskService,
    DocumentAnalysisService,
    AppHintsService,
    DocumentQualityService,
    AppTasksService,
    AppChatService,
    AppSyncService,
  ],
  exports: [AppAuthService],
})
export class AppApiModule {}
