export const NIGHTLY_BATCH_QUEUE = "nightly-batch";
export const NIGHTLY_BATCH_JOB = "consolidate";

/**
 * BullMQ payload for the nightly batch. The processor reads ConversationLog
 * for [processedDate, processedDate + 1 day) where processedDate is the
 * Europe/Berlin start-of-day instant for the day we are consolidating.
 */
export interface NightlyBatchPayload {
  userId: string;
  /** ISO 8601 UTC instant for Europe/Berlin start-of-day. */
  processedDateIso: string;
}

export interface ConversationBlock {
  startedAt: Date;
  endedAt: Date;
  messages: Array<{
    role: string;
    content: string;
    createdAt: Date;
  }>;
}
