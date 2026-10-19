import { Global, Module } from "@nestjs/common";
import { TelegramModule } from "../../telegram/telegram.module";
import { TelegramService } from "../../telegram/telegram.service";
import { DOCUMENT_JOB_NOTIFIER } from "./document-job-notifier";

/**
 * Global so DOCUMENT_JOB_NOTIFIER is injectable inside DocumentsModule
 * (DocumentProcessor) without DocumentsModule importing TelegramModule —
 * that reverse import is exactly what created the circular module
 * dependency this fix removes. Only needs to be imported once, in
 * AppModule.
 */
@Global()
@Module({
  imports: [TelegramModule],
  providers: [{ provide: DOCUMENT_JOB_NOTIFIER, useExisting: TelegramService }],
  exports: [DOCUMENT_JOB_NOTIFIER],
})
export class DocumentJobNotifierModule {}
