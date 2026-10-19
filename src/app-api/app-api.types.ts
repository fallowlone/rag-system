import { DocumentCategory } from "../memory/memory.types";

/**
 * Types for the macOS companion-app HTTP API (/app/v1/*).
 *
 * Raw documents never leave the device — every payload here carries only the
 * local model's structured, relevance-filtered extraction.
 */

/** Session attached to the request by AppAuthGuard after token validation. */
export interface AppSession {
  sessionId: string;
  userId: string;
}

/** Shape AppAuthGuard attaches to every authed /app/v1 request. */
export interface AppAuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  appSession: AppSession;
}

export interface DeviceSessionInfo {
  id: string;
  deviceName: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  /** Token expiry — the device must rotate before this instant. */
  expiresAt: Date;
}

export interface AppPairResult {
  token: string;
  sessionId: string;
  userId: string;
}

/** Device-initiated (reverse) pairing: the app shows a DOK-###### code and
 *  the user sends it to the Telegram bot, which claims it for their account. */
export interface DevicePairClaimResult {
  deviceName: string;
  sessionId: string;
}

export type DevicePairPollResult =
  | { claimed: false }
  | { claimed: true; token: string; sessionId: string; userId: string };

export interface AppIngestFact {
  content: string;
  importance: "high" | "medium" | "low";
}

export interface AppIngestDeadline {
  label: string;
  date: string; // YYYY-MM-DD
  kind?: string;
}

export interface AppIngestAddress {
  purpose?: string;
  address: string;
}

export interface AppIngestAmount {
  label?: string;
  value: string;
  currency?: string;
}

/** Strict-shape extraction payload produced by the local (on-device) model. */
export interface AppDocumentIngestInput {
  sourceHash: string;
  fileName?: string;
  title?: string;
  sender?: string;
  category: DocumentCategory;
  docDate?: string;
  summary?: string;
  facts: AppIngestFact[];
  deadlines: AppIngestDeadline[];
  obligations: string[];
  addresses: AppIngestAddress[];
  amounts: AppIngestAmount[];
  tags: string[];
  isActive: boolean;
  expiryDate?: string;
}

export interface AppDocumentIngestResult {
  documentId: string;
  created: boolean;
  factsStored: number;
  deadlinesCreated: number;
  /**
   * Deterministic extraction-quality assessment (DocumentQualityService).
   * The app surfaces `issues` as "bitte prüfe diese Felder" right after
   * ingest — the local model likely missed content. Present on duplicates
   * too: it describes the payload, not the stored rows.
   */
  quality: DocumentQualityReport;
  /**
   * Server-side analysis (DocumentAnalysisService, LLM). Empty when the
   * analysis was refused or temporarily failed — the app can retry via
   * POST /app/v1/documents/:id/analyze. On duplicates: stored insights.
   */
  insights: AppInsightRecord[];
  /**
   * Obligations detected by the local model. Deliberately NOT auto-committed:
   * the app shows them as suggested tasks and the user confirms each one
   * before it is POSTed to /app/v1/tasks.
   */
  suggestedTasks: string[];
}

export interface DocumentQualityIssue {
  /** Machine-readable code for client-side localization (e.g. "no_facts"). */
  code: string;
  severity: "high" | "medium" | "low";
  /** Human-readable German message for direct display. */
  message: string;
}

export interface DocumentQualityReport {
  /** 0-100; starts at 100, each issue subtracts by severity. */
  score: number;
  issues: DocumentQualityIssue[];
}

export interface AppInsightRecord {
  id: string;
  documentId: string;
  /** 'red_flag' | 'grey_zone' | 'next_step' | 'deadline_note' */
  kind: string;
  /** 'high' | 'medium' | 'low' */
  severity: string;
  title: string;
  body: string;
  createdAt: Date;
}

export interface AppHint {
  kind:
    | "missing_widerspruch_deadline"
    | "expired_still_active"
    | "deadline_cluster"
    | "analysis_missing";
  severity: "high" | "medium" | "low";
  /** Documents this hint is about (one or many for clusters/aggregates). */
  documentIds: string[];
  /** Human-readable German message for direct display. */
  title: string;
  body: string;
}

export interface AppDocumentListItem {
  id: string;
  /**
   * The device already knows this hash — it computed it before uploading — so
   * echoing it back lets a client match its local rows to the server ids
   * without a second endpoint. That is what makes server-side deletion work
   * for documents ingested before the client started recording the id.
   */
  sourceHash: string;
  fileName: string | null;
  title: string | null;
  category: string;
  factsCount: number;
  summary: string | null;
  isActive: boolean;
  status: string | null;
  appSource: boolean;
  expiryDate: Date | null;
  docDate: Date | null;
  createdAt: Date;
  tags: { id: string; name: string; color: string | null }[];
  insights: AppInsightRecord[];
}

export type AppTaskStatus = "open" | "in_progress" | "done" | "missed";
export type AppTaskPriority = "low" | "normal" | "high";

export interface AppTaskCreateInput {
  title: string;
  description?: string;
  dueDate?: string | null; // YYYY-MM-DD
  priority: AppTaskPriority;
  sourceDocumentId?: string;
}

export interface AppTaskUpdateInput {
  title?: string;
  description?: string | null;
  dueDate?: string | null;
  status?: AppTaskStatus;
  priority?: AppTaskPriority;
}

export interface AppTaskRecord {
  id: string;
  title: string;
  description: string | null;
  dueDate: Date | null;
  status: AppTaskStatus;
  priority: AppTaskPriority;
  sourceType: string;
  sourceDocumentId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppDeadlineRecord {
  id: string;
  label: string;
  deadlineDate: Date;
  sourceType: string;
  sourceId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppSyncInput {
  /**
   * Opaque cursor from the previous response's `nextCursor`. Carries a
   * per-collection (updatedAt, id) keyset position, so a collection that hit
   * the page limit resumes exactly where it stopped instead of losing rows
   * behind a wall-clock timestamp. Legacy plain ISO-8601 cursors (pre-keyset
   * clients) are accepted and treated as (instant, start-of-ids).
   */
  cursor?: string;
  /** Per-collection page size, clamped server-side. */
  limit: number;
}

export interface AppSyncResult {
  /** Server clock at response time, for display only — never used as a cursor. */
  serverTime: Date;
  /** Opaque per-collection keyset cursor for the next call. */
  nextCursor: string;
  documents: AppDocumentListItem[];
  deadlines: AppDeadlineRecord[];
  tasks: AppTaskRecord[];
  /**
   * Ids of synced rows deleted since the cursor, by collection. The client
   * must drop these local rows — without this, server-side deletes stayed
   * visible on the device forever.
   */
  deleted: AppDeletedIds;
  /** true when any collection hit the limit — client should page again. */
  hasMore: boolean;
  /**
   * true when the incoming cursor was older than tombstone retention: the
   * server restarted from scratch because intermediate deletions are already
   * pruned. New clients must drop their local cache before applying this
   * page (otherwise missed deletions stay visible forever); old clients
   * just merge the full pull.
   */
  resync: boolean;
}

/** Synced-row ids deleted since the cursor, grouped by collection. */
export interface AppDeletedIds {
  documents: string[];
  deadlines: string[];
  tasks: string[];
}
