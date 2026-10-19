import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import {
  DOCUMENT_JOB_NAME,
  DOCUMENT_JOB_QUEUE,
  DocumentJobPayload,
} from "./document-job.types";

@Injectable()
export class DocumentQueueService {
  private readonly logger = new Logger(DocumentQueueService.name);

  constructor(
    @InjectQueue(DOCUMENT_JOB_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueue(payload: DocumentJobPayload): Promise<string> {
    const job = await this.queue.add(DOCUMENT_JOB_NAME, payload, {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 1_000, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 30 * 24 * 60 * 60 },
      // One pending/active job per (user, file): Telegram re-delivers
      // updates on network hiccups and users double-tap files. Without this,
      // both copies run the full Anthropic pipeline and race on the
      // (userId, sourceHash) unique row. The dedup key (no ttl) is removed
      // when the job finalizes (completed or failed), so legitimate retries
      // and re-uploads after finalization still create fresh jobs — those
      // land on the created===false heal branch in processDocumentJob.
      deduplication: {
        id: `doc:${payload.userId}:${payload.sourceHash ?? payload.fileId}`,
      },
    });
    this.logger.debug(
      `Enqueued document job ${job.id} for user ${payload.userId}`,
    );
    return String(job.id);
  }
}
