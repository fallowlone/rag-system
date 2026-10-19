/** Shapes returned by the dokumente-core Tauri commands (snake_case fields
 *  come from serde-serialized Rust structs; camelCase from the backend JSON
 *  passed through sync_pull / remote_data). Keep in sync with the Rust definitions. */

export interface DocumentRow {
  id: string;
  source_hash: string;
  file_name: string | null;
  kind: string;
  raw_text: string;
  extraction_json: string | null;
  status: "pending" | "extracted" | "synced" | "failed";
  error: string | null;
  created_at: string;
  /**
   * The document is longer than one extraction pass can see, so the model
   * only read its beginning. Derived server-side from the stored text, not a
   * column. The deterministic backstop still scans the whole document, which
   * is why this is a caveat on the analysis rather than a failure.
   */
  coverage_truncated: boolean;
}

export interface SuggestedTask {
  id: number;
  document_id: string;
  remote_document_id: string;
  title: string;
  status: "pending" | "confirmed" | "dismissed";
  created_at: string;
}

export interface SyncReport {
  sent: number;
  retried: number;
  parked: number;
  quality_flags: QualityFlag[];
}

export interface QualityIssue {
  code: string;
  severity: string;
  message: string;
}

export interface QualityFlag {
  documentId: string;
  score: number;
  issues: QualityIssue[];
}

export interface RemoteTag {
  id: string;
  name: string;
  color: string | null;
}

export interface RemoteDocument {
  id: string;
  fileName: string | null;
  title: string | null;
  category: string;
  factsCount: number;
  summary: string | null;
  isActive: boolean;
  status: string | null;
  expiryDate: string | null;
  docDate: string | null;
  createdAt: string | null;
  tags: RemoteTag[];
  insights: RemoteInsight[];
}

export interface RemoteInsight {
  id: string;
  documentId: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface RemoteHint {
  kind: string;
  // Wide, like RemoteTask.status: Rust sends a bare String, so a new
  // server-side severity must render (falling back to the "low" styling)
  // rather than silently violate the declared type.
  severity: string;
  documentIds: string[];
  title: string;
  body: string;
}

export interface RemoteDeadline {
  id: string;
  label: string;
  deadlineDate: string; // YYYY-MM-DD
  sourceType: string | null;
  sourceId: string | null;
  completedAt: string | null;
}

/** The statuses the backend accepts on PATCH /app/v1/tasks/{id}. */
export type TaskStatus = "open" | "in_progress" | "done" | "missed";

export interface RemoteTask {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  // Wide string, not a union: an unknown future status must surface
  // somewhere (the Open column, like "missed") rather than vanish from
  // every column filter on the board.
  status: string;
  // Nullable on the wire: Rust models it as Option<String> (#[serde(default)])
  // and the backend can omit it. A non-null union here was a type-level lie —
  // any `task.priority.` member access would have compiled and then crashed.
  priority: "low" | "normal" | "high" | null;
  sourceType: string | null;
  sourceDocumentId: string | null;
  completedAt: string | null;
}

export interface RemoteData {
  documents: RemoteDocument[];
  deadlines: RemoteDeadline[];
  tasks: RemoteTask[];
}

export interface ModelStatus {
  downloaded: boolean;
  name: string;
  small: boolean;
  size_bytes: number;
  pinned: boolean;
}

/** One entry of a `list_folder_files` scan (mirrors `FolderFile`). */
export interface FolderFile {
  path: string;
  file_name: string;
  size_bytes: number;
  supported: boolean;
  too_large: boolean;
}

/** Result of a `list_folder_files` scan (mirrors `FolderScan`). */
export interface FolderScan {
  files: FolderFile[];
  truncated: boolean;
}
