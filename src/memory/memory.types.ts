export type MemoryType =
  | "fact"
  | "preference"
  | "document"
  | "quote"
  | "decision";

export interface RecalledDiary {
  id: string;
  date: Date;
  entry: string;
  similarity: number;
}

export type UserLang = "ru" | "de" | "en" | "uk";

export type DocumentCategory =
  | "mietvertrag"
  | "jobcenter"
  | "bank"
  | "visa"
  | "versicherung"
  | "other";

/**
 * A document without its extracted text — what list views actually render.
 * `fullText` is up to DOC_FULLTEXT_MAX_CHARS per row, so selecting it for a
 * listing costs tens of megabytes on a batch-ingested account.
 */
export type DocumentListItem = Omit<UserDocumentRecord, "fullText">;

export interface UserDocumentRecord {
  id: string;
  userId: string;
  fileName: string | null;
  category: DocumentCategory;
  sourceHash: string;
  factsCount: number;
  fullText: string | null;
  summary: string | null;
  isActive: boolean;
  expiryDate: Date | null;
  createdAt: Date;
  /**
   * sha256 of the extraction payload this row was built from, when known.
   * The ingest path compares it to tell a re-upload from a re-extraction.
   */
  extractionHash?: string | null;
}

export interface StoredMemory {
  id: string;
  userId: string;
  type: MemoryType;
  content: string; // German text used for embedding
  contentOriginal: string | null; // original-language text for display
  createdAt: Date;
}

export interface RecalledMemory {
  id: string;
  type: MemoryType;
  content: string;
  similarity: number;
  createdAt: Date;
}

/** A deadline date extracted from a UserMemory fact via regex. */
export interface MemoryDeadline {
  /** Memory content truncated to 60 chars, used as the display label. */
  label: string;
  date: Date;
  daysLeft: number;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

/**
 * A conversation-history read that also reports how many raw Redis list
 * entries were consumed (including entries that failed to parse). Needed by
 * the summarization collapse so it can replace exactly the prefix it read
 * (LTRIM readCount) without wiping entries appended concurrently after the
 * read.
 */
export interface ConversationHistoryRead {
  messages: ConversationMessage[];
  /** Raw LRANGE entry count at read time — may exceed messages.length if corrupted entries were skipped. */
  readCount: number;
}

/**
 * Result of a GDPR-erasure sweep (UserMemoryService.forgetAll). Postgres
 * deletion is atomic (single transaction) and always fully reflected in
 * `deletedCount`; the remaining stores (Redis conversation history, BullMQ
 * job payloads, Redis "letter_*_pending"/"lang" keys) are
 * best-effort — each is cleaned independently and any failure is logged and
 * surfaces here rather than aborting the other steps.
 */
export interface ForgetAllResult {
  /** Sum of rows deleted across the per-user Postgres tables + docvault vectors. */
  deletedCount: number;
  /** Number of BullMQ document-processing jobs removed for this user. */
  documentJobsRemoved: number;
  /** Number of BullMQ nightly-batch jobs removed for this user. */
  nightlyJobsRemoved: number;
  /**
   * Labels of cleanup steps that failed (e.g. "conversation-history",
   * "document-queue", "nightly-batch-queue", "letter_style_pending",
   * "letter_pdf_pending", "lang-cache").
   * Empty when everything succeeded.
   */
  failures: string[];
}
