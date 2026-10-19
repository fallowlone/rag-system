import { DocumentJobPayload } from "./document-job.types";

/**
 * Port DocumentProcessor depends on instead of importing TelegramService
 * directly — breaks the TelegramModule <-> DocumentsModule circular module
 * dependency (both previously needed `forwardRef()`: TelegramService needs
 * DocumentQueueService to enqueue jobs, DocumentProcessor needs TelegramService
 * to deliver results). TelegramService implements this interface; the binding
 * lives in DocumentJobNotifierModule.
 */
export const DOCUMENT_JOB_NOTIFIER = Symbol("DOCUMENT_JOB_NOTIFIER");

export interface DocumentJobNotifier {
  processDocumentJob(payload: DocumentJobPayload): Promise<void>;
  notifyDocumentJobFailed(payload: DocumentJobPayload, err: Error): Promise<void>;
}
