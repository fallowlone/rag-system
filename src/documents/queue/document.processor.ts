import { Inject, Logger } from "@nestjs/common";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import Anthropic from "@anthropic-ai/sdk";
import { Job, RateLimitError, UnrecoverableError } from "bullmq";
import {
  DOCUMENT_JOB_NOTIFIER,
  DocumentJobNotifier,
} from "./document-job-notifier";
import {
  DOCUMENT_JOB_QUEUE,
  DocumentJobPayload,
} from "./document-job.types";

const RATE_LIMIT_BACKOFF_MS = 90_000;

// Jobs are I/O-bound (Anthropic calls, Redis, Postgres); pdf parsing already
// runs off-thread in the Piscina pool. 6 concurrent jobs keep the pipeline
// saturated on 429-prone days without oversubscribing the process (the pool
// maxThreads is pinned to match — see getPdfParsePool).
const DOCUMENT_JOB_CONCURRENCY = 6;

// Full jobs (chunked Haiku extraction + Piscina parse + 3 post-LLM calls)
// routinely run past BullMQ's 30s default lock TTL on large PDFs; an expired
// lock looks like a stall and the job is redelivered alongside the still
// running original (double cost + P2002 race). The lock auto-renews while
// the worker is alive — 120s only raises the bar for false positives.
const DOCUMENT_JOB_LOCK_MS = 120_000;
const DOCUMENT_JOB_STALLED_INTERVAL_MS = 60_000;

@Processor(DOCUMENT_JOB_QUEUE, {
  concurrency: DOCUMENT_JOB_CONCURRENCY,
  lockDuration: DOCUMENT_JOB_LOCK_MS,
  stalledInterval: DOCUMENT_JOB_STALLED_INTERVAL_MS,
})
export class DocumentProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentProcessor.name);

  constructor(
    @Inject(DOCUMENT_JOB_NOTIFIER)
    private readonly notifier: DocumentJobNotifier,
  ) {
    super();
  }

  async process(job: Job<DocumentJobPayload>): Promise<void> {
    this.logger.log(
      `Processing document job ${job.id} for user ${job.data.userId} (attempt ${job.attemptsMade + 1})`,
    );

    try {
      await this.notifier.processDocumentJob(job.data);
    } catch (err) {
      // Anthropic rate limits are transient; pause the worker and let BullMQ
      // re-deliver the same job after the cooldown without consuming an attempt.
      if (err instanceof Anthropic.RateLimitError) {
        this.logger.warn(
          `Rate limit hit on job ${job.id}; rate-limiting worker for ${RATE_LIMIT_BACKOFF_MS}ms`,
        );
        await this.worker.rateLimit(RATE_LIMIT_BACKOFF_MS);
        // RateLimitError is the documented signal that re-queues the job
        // without incrementing attemptsMade.
        throw new RateLimitError();
      }
      throw err;
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<DocumentJobPayload> | undefined, err: Error): void {
    if (!job) return;

    const attempts = job.opts.attempts ?? 1;
    // UnrecoverableError is terminal by contract (BullMQ will not retry it),
    // so it notifies on the first failure even though attemptsMade < attempts.
    const isFinal = job.attemptsMade >= attempts || err instanceof UnrecoverableError;
    const reason = err.message.slice(0, 200);

    if (isFinal) {
      this.logger.error(
        `Document job ${job.id} permanently failed after ${job.attemptsMade} attempts: ${reason}`,
      );
      void this.notifier
        .notifyDocumentJobFailed(job.data, err)
        .catch((notifyErr: unknown) => {
          this.logger.warn(
            `Failed to notify user about job ${job.id} failure: ${
              notifyErr instanceof Error ? notifyErr.message : String(notifyErr)
            }`,
          );
        });
      return;
    }

    this.logger.warn(
      `Document job ${job.id} attempt ${job.attemptsMade} failed: ${reason}`,
    );
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job<DocumentJobPayload>): void {
    this.logger.log(
      `Document job ${job.id} completed for user ${job.data.userId}`,
    );
  }
}
