//! Sync to the NestJS backend over HTTPS. Only structured extraction JSON
//! leaves the device. An outbox queue in the encrypted store guarantees
//! at-least-once delivery; the backend dedups by sourceHash.

use crate::crypto::KeyProvider;
use crate::error::{CoreError, Result};
use crate::store::{OutboxEntry, Store};
use std::sync::Arc;
use std::time::Duration;

pub const MAX_OUTBOX_ATTEMPTS: i64 = 5;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Store settings keys (see `Store::get_setting`).
/// Upload of structured summaries; "0" pauses it, missing/anything else allows.
pub const SETTING_SYNC_UPLOAD: &str = "sync_upload_enabled";
/// Device name shown as "Paired as …" after a successful claim poll.
pub const SETTING_DEVICE_NAME: &str = "device_name";

/// Anthropic's per-image ceiling on the direct Claude API, applied to the
/// BASE64 payload. Mirrors `VISION_MAX_BASE64_BYTES` in
/// `src/vision/vision.types.ts` — keep the two in step.
const VISION_MAX_BASE64_BYTES: u64 = 10 * 1024 * 1024;

/// Local read cap for server-side scans, in RAW bytes — what the caller
/// actually holds. Base64 inflates by 4/3, so this is the same ceiling the
/// backend enforces (`VISION_MAX_IMAGE_BYTES`), expressed in the client's
/// unit. Hardcoding the base64 figure as a raw-byte limit rejected ordinary
/// phone photos the server would have accepted.
pub const MAX_SCAN_IMAGE_BYTES: u64 = VISION_MAX_BASE64_BYTES * 3 / 4;

/// Reads an image file for server-side scanning: capped on the descriptor
/// (no stat→read race, no symlinked special files) and standard-base64
/// encoded for the `scan-image` payload. The backend re-validates magic
/// bytes and size — this is only a fail-fast read.
pub fn read_scan_image(path: &std::path::Path) -> Result<String> {
    use base64::Engine as _;
    let bytes = crate::extraction::read_capped(path, MAX_SCAN_IMAGE_BYTES)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Abstraction over HTTP so sync logic is testable without a network.
/// Returns (status, body). Must be Send + Sync so SyncClient works inside
/// Tauri's spawn_blocking closures.
pub trait Transport: Send + Sync {
    fn post_json(
        &self,
        path: &str,
        token: &str,
        body: &str,
    ) -> std::result::Result<(u16, String), String>;

    fn get_json(&self, path: &str, token: &str) -> std::result::Result<(u16, String), String>;

    fn delete_json(&self, path: &str, token: &str) -> std::result::Result<(u16, String), String>;

    fn patch_json(
        &self,
        path: &str,
        token: &str,
        body: &str,
    ) -> std::result::Result<(u16, String), String>;
}

/// Production transport: blocking ureq over the system TLS stack.
pub struct HttpTransport {
    pub base_url: String,
}

impl HttpTransport {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }
}

/// Splits a ureq result into the (status, body) tuple the Transport trait
/// promises. ureq 2.x reports HTTP error statuses as Err(Status) — without
/// this mapping, send_entry's Ok(4xx)-is-rejected arm would be dead code in
/// production (reachable only via scripted fakes in tests).
fn split_response(
    result: std::result::Result<ureq::Response, ureq::Error>,
) -> std::result::Result<(u16, String), String> {
    match result {
        Ok(response) => {
            let status = response.status();
            let body = response.into_string().map_err(|err| err.to_string())?;
            Ok((status, body))
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            Ok((code, body))
        }
        Err(err) => Err(err.to_string()),
    }
}

impl Transport for HttpTransport {
    fn post_json(
        &self,
        path: &str,
        token: &str,
        body: &str,
    ) -> std::result::Result<(u16, String), String> {
        split_response(
            ureq::post(&format!("{}{}", self.base_url, path))
                .timeout(HTTP_TIMEOUT)
                .set("Authorization", &format!("Bearer {token}"))
                .set("Content-Type", "application/json")
                .send_bytes(body.as_bytes()),
        )
    }

    fn get_json(&self, path: &str, token: &str) -> std::result::Result<(u16, String), String> {
        split_response(
            ureq::get(&format!("{}{}", self.base_url, path))
                .timeout(HTTP_TIMEOUT)
                .set("Authorization", &format!("Bearer {token}"))
                .call(),
        )
    }

    fn delete_json(&self, path: &str, token: &str) -> std::result::Result<(u16, String), String> {
        split_response(
            ureq::delete(&format!("{}{}", self.base_url, path))
                .timeout(HTTP_TIMEOUT)
                .set("Authorization", &format!("Bearer {token}"))
                .call(),
        )
    }

    fn patch_json(
        &self,
        path: &str,
        token: &str,
        body: &str,
    ) -> std::result::Result<(u16, String), String> {
        split_response(
            ureq::patch(&format!("{}{}", self.base_url, path))
                .timeout(HTTP_TIMEOUT)
                .set("Authorization", &format!("Bearer {token}"))
                .set("Content-Type", "application/json")
                .send_bytes(body.as_bytes()),
        )
    }
}

/// Reads the "Allow sync of structured summaries" device setting. Upload is
/// allowed unless explicitly set to "0" — fresh installs pair with it on.
pub fn sync_upload_allowed(store: &Store) -> Result<bool> {
    Ok(store.get_setting(SETTING_SYNC_UPLOAD)?.as_deref() != Some("0"))
}

/// Result of one outbox drain pass.
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct SyncReport {
    pub sent: usize,
    pub retried: usize,
    pub parked: usize,
    /// Extraction-quality assessments for pushed documents that came back
    /// with issues (empty when the server reported none).
    pub quality_flags: Vec<QualityFlag>,
}

/// One extraction-quality issue from the ingest response.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct QualityIssue {
    pub code: String,
    pub severity: String,
    pub message: String,
}

/// Extraction-quality assessment for one pushed document.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct QualityFlag {
    #[serde(rename = "documentId")]
    pub document_id: String,
    pub score: i64,
    pub issues: Vec<QualityIssue>,
}

/// A tag attached to a remotely-known document.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct RemoteTag {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

/// Document as known server-side (metadata + sanitized summary only — the
/// raw text never exists on the server).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct RemoteDocument {
    pub id: String,
    /// The device computed this hash before uploading, so it is the join key
    /// between a local row and its server id — that is how documents ingested
    /// before the client recorded ids become deletable server-side. Absent on
    /// payloads cached by older builds and on older servers.
    #[serde(rename = "sourceHash", default)]
    pub source_hash: Option<String>,
    /// Wire name is camelCase `fileName` (see AppDocumentListItem); the
    /// snake_case alias keeps payloads cached by older builds readable.
    #[serde(rename = "fileName", alias = "file_name", default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    pub category: String,
    #[serde(rename = "factsCount", default)]
    pub facts_count: i64,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(rename = "isActive", default = "default_true")]
    pub is_active: bool,
    #[serde(default)]
    pub status: Option<String>,
    /// RFC 3339 strings — the UI layer formats them for display.
    #[serde(rename = "expiryDate", default)]
    pub expiry_date: Option<String>,
    #[serde(rename = "docDate", default)]
    pub doc_date: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub tags: Vec<RemoteTag>,
    /// Server-side LLM insights (step 2). Absent on payloads cached before
    /// the feature existed — defaults to empty, never fails old caches.
    #[serde(default)]
    pub insights: Vec<RemoteInsight>,
}

/// Server-side LLM insight attached to a remote document (red_flag,
/// grey_zone, next_step, deadline_note with high/medium/low severity).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct RemoteInsight {
    pub id: String,
    #[serde(rename = "documentId")]
    pub document_id: String,
    pub kind: String,
    pub severity: String,
    pub title: String,
    pub body: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
}

/// Proactive cross-document hint from GET /app/v1/hints (step 4).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct RemoteHint {
    pub kind: String,
    pub severity: String,
    #[serde(rename = "documentIds", default)]
    pub document_ids: Vec<String>,
    pub title: String,
    pub body: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct RemoteDeadline {
    pub id: String,
    pub label: String,
    /// YYYY-MM-DD on the wire.
    #[serde(rename = "deadlineDate")]
    pub deadline_date: String,
    #[serde(rename = "sourceType", default)]
    pub source_type: Option<String>,
    #[serde(rename = "sourceId", default)]
    pub source_id: Option<String>,
    #[serde(rename = "completedAt", default)]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct RemoteTask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    /// YYYY-MM-DD or null.
    #[serde(rename = "dueDate", default)]
    pub due_date: Option<String>,
    pub status: String,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(rename = "sourceType", default)]
    pub source_type: Option<String>,
    #[serde(rename = "sourceDocumentId", default)]
    pub source_document_id: Option<String>,
    #[serde(rename = "completedAt", default)]
    pub completed_at: Option<String>,
}

/// Response of GET /app/v1/sync — everything that changed since the cursor.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct RemoteUpdates {
    /// Opaque per-collection keyset cursor for the next call (base64url, not
    /// a clock reading) — store as `sync_cursor`.
    #[serde(rename = "nextCursor")]
    pub next_cursor: String,
    #[serde(default)]
    pub documents: Vec<RemoteDocument>,
    #[serde(default)]
    pub deadlines: Vec<RemoteDeadline>,
    #[serde(default)]
    pub tasks: Vec<RemoteTask>,
    /// Ids of server-side deleted rows since the cursor, by collection.
    /// Absent on responses cached before tombstones existed — defaults to
    /// empty, never fails old caches.
    #[serde(default)]
    pub deleted: RemoteDeletedIds,
    #[serde(rename = "hasMore", default)]
    pub has_more: bool,
    /// True when the server discarded the incoming cursor as older than
    /// tombstone retention and restarted from scratch: the client must drop
    /// its local snapshot before applying this page (handled in
    /// `apply_updates`), or missed deletions would haunt the cache forever.
    /// Absent on older servers — defaults to false.
    #[serde(default)]
    pub resync: bool,
}

/// Synced-row ids the server deleted since the cursor — the client must
/// drop these local rows instead of displaying deleted data forever.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize, serde::Serialize)]
pub struct RemoteDeletedIds {
    #[serde(default)]
    pub documents: Vec<String>,
    #[serde(default)]
    pub deadlines: Vec<String>,
    #[serde(default)]
    pub tasks: Vec<String>,
}

/// Merged remote snapshot for the UI — no cursor / pagination metadata.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct RemoteData {
    pub documents: Vec<RemoteDocument>,
    pub deadlines: Vec<RemoteDeadline>,
    pub tasks: Vec<RemoteTask>,
}

/// Result of a full pull-and-apply cycle.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PullReport {
    pub pages: u32,
    pub documents: usize,
    pub deadlines: usize,
    pub tasks: usize,
    pub deleted: usize,
    /// True when any applied page carried the server's resync flag (the
    /// local snapshot was wiped before applying — see `apply_updates`).
    pub resynced: bool,
}

/// Syncs structured extraction JSON to the backend. Owns its dependencies
/// (Arc<dyn Transport>, Arc<dyn KeyProvider>) so it is `Send + 'static` and
/// can be moved into Tauri's `spawn_blocking`.
pub struct SyncClient {
    pub transport: Arc<dyn Transport>,
    pub keys: Arc<dyn KeyProvider>,
}

impl SyncClient {
    pub fn new(transport: Arc<dyn Transport>, keys: Arc<dyn KeyProvider>) -> Self {
        Self { transport, keys }
    }
}

/// Backend question cap (`z.string().min(1).max(4000)` on POST /app/v1/chat
/// and POST /app/v1/documents/{id}/ask): fail fast client-side with a clear
/// message instead of paying a round trip for a guaranteed 400 — or worse,
/// hanging an IPC call on a multi-megabyte payload.
const MAX_ASK_CHARS: usize = 4000;

/// Trims and bounds a chat question. Returns the trimmed text to send.
///
/// Length is counted in UTF-16 code units, not Rust `char`s: the bound being
/// mirrored is a Zod `.max(4000)`, and JavaScript's `String.length` counts
/// astral characters (emoji) as two. Counting `char`s made this side the more
/// permissive one, so exactly the payloads it exists to stop still paid the
/// round trip and came back 400.
fn validate_ask(question: &str) -> Result<&str> {
    let trimmed = question.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput("question is empty".into()));
    }
    let len = trimmed.encode_utf16().count();
    if len > MAX_ASK_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "question is {len} chars (max {MAX_ASK_CHARS})"
        )));
    }
    Ok(trimmed)
}

/// Matches `fetch_updates`' rejection message for one HTTP status.
/// (The status travels inside `CoreError::Sync(String)` — see that method.)
fn is_http_status(err: &CoreError, status: u16) -> bool {
    match err {
        CoreError::Sync(msg) => msg.contains(&format!("(HTTP {status})")),
        _ => false,
    }
}

/// Device-generated pairing proposal (reverse flow). The 6-digit code is
/// shown as `DOK-######`; the 256-bit secret authorizes the claim poll and
/// is never logged or displayed.
pub struct PairingProposal {
    pub code: String,
    pub secret: String,
}

impl PairingProposal {
    pub fn generate() -> Self {
        use rand::{Rng, RngCore};
        let mut rng = rand::thread_rng();
        let code = format!("{:06}", rng.gen_range(0..1_000_000u32));
        let mut secret_bytes = [0u8; 32];
        rng.fill_bytes(&mut secret_bytes);
        let secret = secret_bytes.iter().map(|b| format!("{b:02x}")).collect();
        Self { code, secret }
    }

    pub fn display_code(&self) -> String {
        format!("DOK-{}", self.code)
    }
}

impl SyncClient {
    /// Registers a device-generated pairing proposal server-side
    /// (POST /app/v1/auth/pair-propose). The user then sends the displayed
    /// DOK-###### code to the Telegram bot, which claims it.
    pub fn propose_pairing(&self, proposal: &PairingProposal, device_name: &str) -> Result<()> {
        let body = serde_json::json!({
            "code": proposal.code,
            "deviceName": device_name,
            "secret": proposal.secret,
        });
        let (status, _) = self
            .transport
            .post_json("/app/v1/auth/pair-propose", "", &body.to_string())
            .map_err(CoreError::Sync)?;
        if status != 200 {
            return Err(CoreError::Sync(format!(
                "pairing proposal rejected (HTTP {status})"
            )));
        }
        Ok(())
    }

    /// Single claim poll (POST /app/v1/auth/pair-status with a JSON body —
    /// the secret must never travel in a GET query string where proxies and
    /// access logs retain it). Returns true once the user claimed the code
    /// in Telegram, storing the device token in the keychain. False = still
    /// pending (or expired — the UI owns the 60s countdown and regenerates).
    pub fn poll_pairing_claim(&self, proposal: &PairingProposal) -> Result<bool> {
        let body = serde_json::json!({
            "code": proposal.code,
            "secret": proposal.secret,
        });
        let (status, response_body) = self
            .transport
            .post_json("/app/v1/auth/pair-status", "", &body.to_string())
            .map_err(CoreError::Sync)?;
        if status != 200 {
            return Err(CoreError::Sync(format!(
                "pairing poll rejected (HTTP {status})"
            )));
        }

        #[derive(serde::Deserialize)]
        struct PollResponse {
            claimed: bool,
            token: Option<String>,
        }
        let parsed: PollResponse = serde_json::from_str(&response_body)?;
        if parsed.claimed {
            let token = parsed
                .token
                .ok_or_else(|| CoreError::Sync("pairing claimed without a token".into()))?;
            self.keys.set(crate::crypto::TOKEN_ACCOUNT, &token)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Revokes the server session for this device and wipes the local token.
    /// Returns true when a local token existed.
    pub fn unpair(&self) -> Result<bool> {
        let token = self.keys.get(crate::crypto::TOKEN_ACCOUNT)?;
        let Some(token) = token else {
            return Ok(false);
        };
        let (status, _) = self
            .transport
            .delete_json("/app/v1/auth/session", &token)
            .map_err(CoreError::Sync)?;
        // The server answered (any status): a revoked-or-gone session must
        // never leave a live-looking device behind, so wipe the local token.
        // A transport error returned above instead, leaving the token in
        // place for a retry — there is no evidence the session is gone.
        self.keys.delete(crate::crypto::TOKEN_ACCOUNT)?;
        if !(200..300).contains(&status) {
            return Err(CoreError::Sync(format!("unpair rejected (HTTP {status})")));
        }
        Ok(true)
    }

    /// Drains up to `limit` pending outbox entries. Transient failures
    /// (HTTP 408/429/>= 500, network errors) count a retry with backoff; other
    /// 4xx mark the entry done-with-error (the server explicitly rejected
    /// it — retrying the same payload cannot succeed) and fail the
    /// document. HTTP 401 aborts the whole drain with an error instead:
    /// the token is expired, so every further entry would 401 too, and
    /// parking the batch as failed would leave no recovery path — the
    /// untouched entries stay pending for the next drain after re-pairing.
    ///
    /// Takes the shared store and holds the lock only for snapshots and
    /// per-entry marks — never across network I/O — so listing, deleting
    /// or pairing never stall behind a slow drain. Concurrent drains are
    /// safe (if redundant): server ingest dedups by sourceHash and applies
    /// backend suggestions only on `created`, while every local mark is
    /// idempotent.
    pub fn push_pending(&self, store: &std::sync::Mutex<Store>, limit: i64) -> Result<SyncReport> {
        let guard = crate::store::lock_shared(store)?;
        let upload_allowed = sync_upload_allowed(&guard)?;
        drop(guard);
        if !upload_allowed {
            // User unchecked "Allow sync of structured summaries" — drain
            // nothing, report nothing. Pull is unaffected.
            return Ok(SyncReport::default());
        }
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;

        // Snapshot, then release the lock before any network call.
        let pending = crate::store::lock_shared(store)?.pending_outbox(limit)?;
        let mut report = SyncReport::default();

        for entry in &pending {
            match self.send_entry(&token, entry) {
                SendOutcome::Accepted(body) => {
                    // Parse first: the server id travels in the body and has
                    // to be recorded by `mark_synced`, or the document can
                    // never be deleted server-side. A malformed body is
                    // still not fatal (best-effort), it just costs the id.
                    let accepted = parse_ingest_body(&body);
                    let store = crate::store::lock_shared(store)?;
                    store.outbox_mark_done(entry.id)?;
                    store.mark_synced(
                        &entry.document_id,
                        accepted.as_ref().map(|a| a.document_id.as_str()),
                    )?;
                    if let Some(accepted) = accepted {
                        if accepted.created && !accepted.suggested_tasks.is_empty() {
                            store.insert_suggested_tasks(
                                &entry.document_id,
                                &accepted.document_id,
                                &accepted.suggested_tasks,
                            )?;
                        }
                        if !accepted.quality_issues.is_empty() {
                            report.quality_flags.push(QualityFlag {
                                document_id: accepted.document_id,
                                score: accepted.quality_score,
                                issues: accepted.quality_issues,
                            });
                        }
                    }
                    report.sent += 1;
                }
                SendOutcome::Rejected(reason) => {
                    // 4xx (except 401, handled below): permanently rejected —
                    // park the entry and fail the document so the UI can
                    // surface the error.
                    let store = crate::store::lock_shared(store)?;
                    store.outbox_mark_done(entry.id)?;
                    store.mark_failed(&entry.document_id, &reason)?;
                    report.parked += 1;
                }
                SendOutcome::Unauthorized => {
                    // Expired/revoked token: stop the drain NOW. Every entry
                    // still ahead would 401 the same way, and marking them
                    // done+failed would burn the batch with no recovery.
                    // Untouched entries stay pending; the error tells the UI
                    // to ask for re-pairing, after which the drain resumes.
                    return Err(CoreError::Sync(
                        "sync unauthorized (HTTP 401) — re-pair the device, then retry".into(),
                    ));
                }
                SendOutcome::Transient(reason) => {
                    let store = crate::store::lock_shared(store)?;
                    store.outbox_mark_retry(entry.id, MAX_OUTBOX_ATTEMPTS)?;
                    if entry.attempts + 1 >= MAX_OUTBOX_ATTEMPTS {
                        store.mark_failed(&entry.document_id, &reason)?;
                        report.parked += 1;
                    } else {
                        report.retried += 1;
                    }
                }
            }
        }
        Ok(report)
    }

    /// Creates a task on the backend (/app/v1/tasks) and links it to the
    /// server-side document via `sourceDocumentId`. Used by the suggested-
    /// task confirmation flow.
    pub fn create_task(&self, title: &str, source_document_id: &str) -> Result<()> {
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;
        let body = serde_json::json!({
            "title": title,
            "priority": "normal",
            "sourceDocumentId": source_document_id,
        });
        let (status, _) = self
            .transport
            .post_json("/app/v1/tasks", &token, &body.to_string())
            .map_err(CoreError::Sync)?;
        if !(200..300).contains(&status) {
            return Err(CoreError::Sync(format!(
                "task creation rejected (HTTP {status})"
            )));
        }
        Ok(())
    }

    /// Moves a task to a new status (`PATCH /app/v1/tasks/{id}`). The board
    /// was read-only: tasks arrived from the server and could only be
    /// completed elsewhere, which made the app's own Tasks page a viewer of
    /// work it could not close.
    pub fn update_task_status(&self, task_id: &str, status: &str) -> Result<()> {
        // Mirror of the backend's Zod enum — a typo here would otherwise cost
        // a round trip to learn the same thing.
        const ALLOWED: [&str; 4] = ["open", "in_progress", "done", "missed"];
        if !ALLOWED.contains(&status) {
            return Err(CoreError::InvalidInput(format!(
                "unknown task status {status:?}"
            )));
        }
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;
        let payload = serde_json::json!({ "status": status }).to_string();
        let path = format!("/app/v1/tasks/{task_id}");
        let (code, _) = self
            .transport
            .patch_json(&path, &token, &payload)
            .map_err(CoreError::Sync)?;
        if !(200..300).contains(&code) {
            return Err(CoreError::Sync(format!(
                "task update rejected (HTTP {code})"
            )));
        }
        Ok(())
    }

    /// Deletes ONE document server-side (`DELETE /app/v1/documents/{id}`),
    /// removing the stored summary, the extracted facts, the Sonnet insights
    /// and the owner-scoped docvault vectors. `remote_document_id` is the id
    /// the server assigned on ingest (see `Store::remote_document_id`).
    ///
    /// A 404 counts as success: the row is already gone, which is exactly
    /// the state the caller asked for. Every other non-2xx is an error, so
    /// the caller can refuse to delete the local copy and leave the user
    /// with a document that still exists in both places rather than one
    /// that silently survives only on the server.
    pub fn delete_remote_document(&self, remote_document_id: &str) -> Result<()> {
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;
        let path = format!("/app/v1/documents/{remote_document_id}");
        let (status, _) = self
            .transport
            .delete_json(&path, &token)
            .map_err(CoreError::Sync)?;
        if status == 404 {
            return Ok(());
        }
        if !(200..300).contains(&status) {
            return Err(CoreError::Sync(format!(
                "document delete rejected (HTTP {status})"
            )));
        }
        Ok(())
    }

    /// Pulls everything that changed server-side since `cursor` (the
    /// previous response's `nextCursor`; None = full pull). The cursor is
    /// persisted by the caller (store/settings), not here.
    pub fn fetch_updates(&self, cursor: Option<&str>, limit: u32) -> Result<RemoteUpdates> {
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;

        let mut path = format!("/app/v1/sync?limit={limit}");
        if let Some(cursor) = cursor {
            // ISO-8601 cursors contain only RFC 3986 query-safe characters
            // (digits, '-', ':', '.', '+') except '+' which appears in some
            // timezone offsets — encode it to avoid it parsing as a space.
            let encoded = cursor.replace('+', "%2B");
            path.push_str(&format!("&cursor={encoded}"));
        }

        let (status, body) = self
            .transport
            .get_json(&path, &token)
            .map_err(CoreError::Sync)?;
        if status != 200 {
            return Err(CoreError::Sync(format!(
                "sync pull rejected (HTTP {status})"
            )));
        }
        serde_json::from_str(&body).map_err(CoreError::Serialization)
    }

    /// Asks the backend chat (/app/v1/chat) — user facts + German laws RAG.
    /// Returns the complete answer; the endpoint is non-streaming JSON.
    pub fn ask_chat(&self, question: &str, language: Option<&str>) -> Result<String> {
        let question = validate_ask(question)?;
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;
        let mut payload = serde_json::json!({ "question": question });
        if let Some(lang) = language {
            payload["language"] = serde_json::json!(lang);
        }
        let (status, body) = self
            .transport
            .post_json("/app/v1/chat", &token, &payload.to_string())
            .map_err(CoreError::Sync)?;
        if status != 200 {
            return Err(CoreError::Sync(format!("chat rejected (HTTP {status})")));
        }
        #[derive(serde::Deserialize)]
        struct ChatResponse {
            answer: String,
        }
        serde_json::from_str::<ChatResponse>(&body)
            .map(|r| r.answer)
            .map_err(CoreError::Serialization)
    }

    /// Asks about ONE server-side document
    /// (`POST /app/v1/documents/{id}/ask`) — retrieval scoped to that
    /// document's chunks plus the law corpus. Returns the answer string.
    pub fn ask_document(
        &self,
        document_id: &str,
        question: &str,
        language: Option<&str>,
    ) -> Result<String> {
        let question = validate_ask(question)?;
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;
        let mut payload = serde_json::json!({ "question": question });
        if let Some(lang) = language {
            payload["language"] = serde_json::json!(lang);
        }
        let path = format!("/app/v1/documents/{document_id}/ask");
        let (status, body) = self
            .transport
            .post_json(&path, &token, &payload.to_string())
            .map_err(CoreError::Sync)?;
        if status != 200 {
            return Err(CoreError::Sync(format!(
                "document ask rejected (HTTP {status})"
            )));
        }
        #[derive(serde::Deserialize)]
        struct AskResponse {
            answer: String,
        }
        serde_json::from_str::<AskResponse>(&body)
            .map(|r| r.answer)
            .map_err(CoreError::Serialization)
    }

    /// Sends one image to the backend for Sonnet transcription
    /// (`POST /app/v1/scan-image`). Stateless: nothing is stored, the caller
    /// decides what to do with the text. The backend enforces format/size;
    /// this side only checks pairing + HTTP status + the `{text}` shape.
    pub fn scan_image_bytes(&self, image_b64: &str, language: Option<&str>) -> Result<String> {
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;
        let mut payload = serde_json::json!({ "image": image_b64 });
        if let Some(lang) = language {
            payload["language"] = serde_json::json!(lang);
        }
        let (status, body) = self
            .transport
            .post_json("/app/v1/scan-image", &token, &payload.to_string())
            .map_err(CoreError::Sync)?;
        if status == 429 {
            return Err(CoreError::Sync(
                "scan rate-limited (HTTP 429) — try again in a minute".into(),
            ));
        }
        if status != 200 {
            return Err(CoreError::Sync(format!(
                "image scan rejected (HTTP {status})"
            )));
        }
        #[derive(serde::Deserialize)]
        struct ScanResponse {
            text: String,
        }
        serde_json::from_str::<ScanResponse>(&body)
            .map(|r| r.text)
            .map_err(CoreError::Serialization)
    }

    /// Fetches proactive cross-document hints (`GET /app/v1/hints`).
    pub fn fetch_hints(&self) -> Result<Vec<RemoteHint>> {
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;
        let (status, body) = self
            .transport
            .get_json("/app/v1/hints", &token)
            .map_err(CoreError::Sync)?;
        if status != 200 {
            return Err(CoreError::Sync(format!("hints rejected (HTTP {status})")));
        }
        #[derive(serde::Deserialize)]
        struct HintsResponse {
            #[serde(default)]
            hints: Vec<RemoteHint>,
        }
        serde_json::from_str::<HintsResponse>(&body)
            .map(|r| r.hints)
            .map_err(CoreError::Serialization)
    }

    /// Marks a server-side deadline done (or reopens it) via
    /// `PATCH /app/v1/deadlines/{id}`. Without this, a handled deadline
    /// resurfaced in every morning tracker run.
    pub fn complete_deadline(&self, deadline_id: &str, completed: bool) -> Result<()> {
        let token = self
            .keys
            .get(crate::crypto::TOKEN_ACCOUNT)?
            .ok_or_else(|| CoreError::Sync("device not paired".into()))?;
        let payload = serde_json::json!({ "completed": completed }).to_string();
        let path = format!("/app/v1/deadlines/{deadline_id}");
        let (status, _) = self
            .transport
            .patch_json(&path, &token, &payload)
            .map_err(CoreError::Sync)?;
        if status != 200 {
            return Err(CoreError::Sync(format!(
                "deadline complete rejected (HTTP {status})"
            )));
        }
        Ok(())
    }

    /// Performs a full incremental sync: reads the stored cursor, fetches
    /// all pages (up to MAX_PAGES), applies each page atomically to the
    /// local store, and advances the cursor per page. Returns a summary.
    /// Hitting MAX_PAGES with rows still pending is an error, never a
    /// silent truncation: every applied page already advanced the stored
    /// cursor, so the caller surfaces the error and the next pull resumes
    /// where this one stopped. Like push_pending, the lock is held only
    /// for the cursor read and per-page applies — never across fetches.
    pub fn pull_and_apply(
        &self,
        store: &std::sync::Mutex<Store>,
        limit: u32,
    ) -> Result<PullReport> {
        const MAX_PAGES: u32 = 50;

        let mut cursor = crate::store::lock_shared(store)?.get_setting("sync_cursor")?;
        let mut total_docs = 0;
        let mut total_deadlines = 0;
        let mut total_tasks = 0;
        let mut total_deleted = 0;
        let mut pages = 0;
        let mut incomplete = false;
        let mut resynced = false;

        for _ in 0..MAX_PAGES {
            let updates = match self.fetch_updates(cursor.as_deref(), limit) {
                Ok(updates) => updates,
                Err(e) if cursor.is_some() && is_http_status(&e, 400) => {
                    // Poisoned cursor (server pruned the tombstones it
                    // references, hand-edited settings, clock jump): every
                    // future pull would 400 the same way. Drop the cursor
                    // and retry ONCE as a full pull instead of wedging sync
                    // forever — the loop tail re-seeds the cursor from the
                    // retry's next_cursor when it pages. A 400 on a
                    // cursor-less pull is a real bug: surface it.
                    crate::store::lock_shared(store)?.clear_setting("sync_cursor")?;
                    let mut fresh = self.fetch_updates(None, limit)?;
                    // Restarting from scratch is the same event the server
                    // signals with `resync`, so it needs the same wipe: rows
                    // deleted while the cursor was unusable are absent from
                    // this full pull, and upserts never delete — without the
                    // wipe they haunt the local cache forever. The server
                    // cannot set the flag here (a cursor-less request has
                    // nothing stale to declare), so the client sets it.
                    fresh.resync = true;
                    fresh
                }
                Err(e) => return Err(e),
            };
            total_docs += updates.documents.len();
            total_deadlines += updates.deadlines.len();
            total_tasks += updates.tasks.len();
            total_deleted += updates.deleted.documents.len()
                + updates.deleted.deadlines.len()
                + updates.deleted.tasks.len();
            resynced = resynced || updates.resync;
            crate::store::lock_shared(store)?.apply_updates(&updates)?;
            pages += 1;

            incomplete = updates.has_more;
            if !updates.has_more {
                break;
            }
            cursor = Some(updates.next_cursor);
        }

        if incomplete {
            return Err(CoreError::Sync(format!(
                "sync incomplete after {MAX_PAGES} pages — retry to continue"
            )));
        }

        Ok(PullReport {
            pages,
            documents: total_docs,
            deadlines: total_deadlines,
            tasks: total_tasks,
            deleted: total_deleted,
            resynced,
        })
    }

    fn send_entry(&self, token: &str, entry: &OutboxEntry) -> SendOutcome {
        match self
            .transport
            .post_json("/app/v1/documents", token, &entry.payload)
        {
            Ok((status, body)) if (200..300).contains(&status) => SendOutcome::Accepted(body),
            // Rate-limited: back off and retry later, never park as failed.
            Ok((429, _)) => SendOutcome::Transient("rate limited (HTTP 429) — backing off".into()),
            // Request timeout: the server may or may not have processed it,
            // but the ingest endpoint is idempotent on (userId, sourceHash)
            // (duplicate → created=false), so a retry is safe — while
            // parking on the first 408 would strand the doc forever.
            Ok((408, _)) => {
                SendOutcome::Transient("request timeout (HTTP 408) — backing off".into())
            }
            // Expired/revoked device token: abort the drain, keep entries
            // pending (see push_pending).
            Ok((401, _)) => SendOutcome::Unauthorized,
            Ok((status, _)) if (400..500).contains(&status) => {
                SendOutcome::Rejected(format!("server rejected payload (HTTP {status})"))
            }
            Ok((status, _)) => SendOutcome::Transient(format!("server error (HTTP {status})")),
            Err(err) => SendOutcome::Transient(err),
        }
    }
}

/// Parsed `POST /app/v1/documents` response: server-side document id,
/// suggested tasks (only meaningful for newly created documents), and the
/// extraction-quality assessment (present on duplicates too). Missing fields
/// default so older servers never fail the sync.
struct IngestAccepted {
    document_id: String,
    created: bool,
    suggested_tasks: Vec<String>,
    quality_score: i64,
    quality_issues: Vec<QualityIssue>,
}

/// Parses the `POST /app/v1/documents` response body. Returns None ONLY for
/// a malformed body (the sync itself still succeeds). A duplicate upload is
/// parsed like any other: it carries no new suggested tasks, but its
/// `documentId` is the same server-side id, and dropping it here used to
/// leave re-pushed documents with no way to be deleted server-side.
fn parse_ingest_body(body: &str) -> Option<IngestAccepted> {
    #[derive(serde::Deserialize)]
    struct IngestResponse {
        #[serde(rename = "documentId")]
        document_id: String,
        #[serde(default)]
        created: bool,
        #[serde(rename = "suggestedTasks", default)]
        suggested_tasks: Vec<String>,
        #[serde(default)]
        quality: IngestQuality,
    }
    #[derive(serde::Deserialize, Default)]
    struct IngestQuality {
        #[serde(default)]
        score: i64,
        #[serde(default)]
        issues: Vec<QualityIssue>,
    }
    let parsed: IngestResponse = serde_json::from_str(body).ok()?;
    Some(IngestAccepted {
        document_id: parsed.document_id,
        created: parsed.created,
        suggested_tasks: parsed.suggested_tasks,
        quality_score: parsed.quality.score,
        quality_issues: parsed.quality.issues,
    })
}

enum SendOutcome {
    Accepted(String),
    Rejected(String),
    Transient(String),
    Unauthorized,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::InMemoryProvider;
    use crate::store::Store;
    use std::sync::Arc;

    /// Scriptable fake transport: pops one outcome per request (LIFO order
    /// — push responses in reverse).
    struct FakeTransport {
        responses: std::sync::Mutex<Vec<std::result::Result<(u16, String), String>>>,
        get_responses: std::sync::Mutex<Vec<std::result::Result<(u16, String), String>>>,
        seen_paths: std::sync::Mutex<Vec<String>>,
        seen_bodies: std::sync::Mutex<Vec<String>>,
        seen_tokens: std::sync::Mutex<Vec<String>>,
    }

    impl FakeTransport {
        fn with(responses: Vec<std::result::Result<(u16, String), String>>) -> Self {
            Self {
                responses: std::sync::Mutex::new(responses),
                get_responses: std::sync::Mutex::new(Vec::new()),
                seen_paths: std::sync::Mutex::new(Vec::new()),
                seen_bodies: std::sync::Mutex::new(Vec::new()),
                seen_tokens: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    impl Transport for FakeTransport {
        fn post_json(
            &self,
            _path: &str,
            token: &str,
            body: &str,
        ) -> std::result::Result<(u16, String), String> {
            self.seen_paths.lock().unwrap().push(_path.into());
            self.seen_bodies.lock().unwrap().push(body.into());
            self.seen_tokens.lock().unwrap().push(token.into());
            self.responses
                .lock()
                .unwrap()
                .pop()
                .expect("no scripted response left")
        }

        fn get_json(&self, path: &str, token: &str) -> std::result::Result<(u16, String), String> {
            self.seen_paths.lock().unwrap().push(path.into());
            self.seen_tokens.lock().unwrap().push(token.into());
            self.get_responses
                .lock()
                .unwrap()
                .pop()
                .expect("no scripted GET response")
        }

        fn delete_json(
            &self,
            path: &str,
            token: &str,
        ) -> std::result::Result<(u16, String), String> {
            self.seen_paths.lock().unwrap().push(path.into());
            self.seen_tokens.lock().unwrap().push(token.into());
            self.get_responses
                .lock()
                .unwrap()
                .pop()
                .expect("no scripted DELETE response")
        }

        fn patch_json(
            &self,
            path: &str,
            token: &str,
            body: &str,
        ) -> std::result::Result<(u16, String), String> {
            self.seen_paths.lock().unwrap().push(path.into());
            self.seen_bodies.lock().unwrap().push(body.into());
            self.seen_tokens.lock().unwrap().push(token.into());
            self.responses
                .lock()
                .unwrap()
                .pop()
                .expect("no scripted PATCH response")
        }
    }

    fn setup() -> (std::sync::Mutex<Store>, InMemoryProvider) {
        let keys = InMemoryProvider::new();
        let store = Store::open_in_memory(&keys).unwrap();
        (std::sync::Mutex::new(store), keys)
    }

    fn queue_entry(store: &std::sync::Mutex<Store>) {
        let store = store.lock().unwrap();
        store
            .insert_document("doc-1", &"h".repeat(64), None, "pdf", "raw text", None)
            .unwrap();
        store
            .save_extraction(
                "doc-1",
                &format!(
                    r#"{{"sourceHash":"{}","category":"other","facts":[],"deadlines":[],"obligations":[],"addresses":[],"amounts":[],"tags":[],"isActive":true}}"#,
                    "h".repeat(64)
                ),
            )
            .unwrap();
    }

    /// Helper: create a SyncClient backed by a fake transport, returning both
    /// the client and a clone of the Arc<FakeTransport> so tests can inspect
    /// what was sent.
    fn make_client(
        transport: Arc<FakeTransport>,
        keys: InMemoryProvider,
    ) -> (SyncClient, Arc<FakeTransport>) {
        let client = SyncClient::new(Arc::clone(&transport) as Arc<dyn Transport>, Arc::new(keys));
        (client, transport)
    }

    /// Minimal single-shot HTTP stub (std only): answers the first request
    /// with `status` + `body`. Used to prove HttpTransport's real status
    /// mapping — FakeTransport can script Ok(4xx), which production ureq
    /// never yields (it returns Err(Status) instead).
    fn stub_http_server(status: u16, body: &'static str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                // Read the FULL request (headers + body) before responding:
                // answering while ureq is still sending the POST body races
                // into RST/EOF on the client and flakes the test.
                let mut received = Vec::new();
                let mut buf = [0u8; 4096];
                let mut header_len: Option<usize> = None;
                while header_len.is_none() {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            received.extend_from_slice(&buf[..n]);
                            if let Some(pos) = find_bytes(&received, b"\r\n\r\n") {
                                header_len = Some(pos + 4);
                            }
                        }
                        Err(_) => break,
                    }
                }
                if let Some(hlen) = header_len {
                    let content_length = String::from_utf8_lossy(&received[..hlen])
                        .lines()
                        .filter_map(|line| {
                            line.strip_prefix("Content-Length:")
                                .or_else(|| line.strip_prefix("content-length:"))
                        })
                        .filter_map(|value| value.trim().parse::<usize>().ok())
                        .next()
                        .unwrap_or(0);
                    while received.len() < hlen + content_length {
                        match stream.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => received.extend_from_slice(&buf[..n]),
                            Err(_) => break,
                        }
                    }
                }
                let reason = match status {
                    200 => "OK",
                    400 => "Bad Request",
                    401 => "Unauthorized",
                    500 => "Internal Server Error",
                    _ => "Error",
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    #[test]
    fn http_transport_reports_error_statuses_as_tuples() {
        // send_entry classifies Ok(4xx) as permanently rejected — reachable
        // in production only if HttpTransport converts ureq's Err(Status)
        // back into (status, body) instead of a featureless Err string.
        for (status, body) in [(400u16, "bad"), (401, "nope"), (500, "boom")] {
            let transport = HttpTransport::new(stub_http_server(status, body));
            let (got_status, got_body) = transport
                .post_json("/app/v1/documents", "tok", "{}")
                .unwrap();
            assert_eq!(got_status, status);
            assert_eq!(got_body, body);
        }
    }

    /// Transport whose next request blocks until the test releases it.
    /// Proves drains never hold the store lock across network I/O: while
    /// the request is in flight, the test thread must still acquire the
    /// store via try_lock (deterministic — no sleeps, no flakes).
    struct GateTransport {
        started: std::sync::mpsc::Sender<()>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        response: std::sync::Mutex<Option<std::result::Result<(u16, String), String>>>,
    }

    impl GateTransport {
        fn gate(&self) -> std::result::Result<(u16, String), String> {
            let _ = self.started.send(());
            self.release.lock().unwrap().recv().unwrap();
            self.response
                .lock()
                .unwrap()
                .take()
                .expect("gate response consumed twice")
        }
    }

    impl Transport for GateTransport {
        fn post_json(
            &self,
            _path: &str,
            _token: &str,
            _body: &str,
        ) -> std::result::Result<(u16, String), String> {
            self.gate()
        }

        fn get_json(
            &self,
            _path: &str,
            _token: &str,
        ) -> std::result::Result<(u16, String), String> {
            self.gate()
        }

        fn delete_json(
            &self,
            _path: &str,
            _token: &str,
        ) -> std::result::Result<(u16, String), String> {
            unimplemented!("gate transport only serves one request kind per test")
        }

        fn patch_json(
            &self,
            _path: &str,
            _token: &str,
            _body: &str,
        ) -> std::result::Result<(u16, String), String> {
            unimplemented!("gate transport only serves one request kind per test")
        }
    }

    fn gated_client(
        keys: InMemoryProvider,
        response: std::result::Result<(u16, String), String>,
    ) -> (
        SyncClient,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (tx_started, rx_started) = std::sync::mpsc::channel();
        let (tx_release, rx_release) = std::sync::mpsc::channel();
        let transport = std::sync::Arc::new(GateTransport {
            started: tx_started,
            release: std::sync::Mutex::new(rx_release),
            response: std::sync::Mutex::new(Some(response)),
        });
        let client = SyncClient::new(transport, std::sync::Arc::new(keys));
        (client, rx_started, tx_release)
    }

    #[test]
    fn push_pending_releases_the_store_lock_during_network_io() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let store = std::sync::Arc::new(store);
        let (client, rx_started, tx_release) = gated_client(keys, Ok((201, "{}".into())));

        std::thread::scope(|s| {
            s.spawn(|| {
                client.push_pending(&store, 10).unwrap();
            });
            // The drain is inside the POST right now.
            rx_started
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(
                store.try_lock().is_ok(),
                "store lock held across network I/O"
            );
            tx_release.send(()).unwrap();
        });
        // The drain completed normally afterwards.
        assert!(store.lock().unwrap().pending_outbox(10).unwrap().is_empty());
    }

    #[test]
    fn pull_and_apply_releases_the_store_lock_during_fetch() {
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let store = std::sync::Arc::new(store);
        let page = r#"{"nextCursor":"c","documents":[],"deadlines":[],"tasks":[],"hasMore":false}"#;
        let (client, rx_started, tx_release) = gated_client(keys, Ok((200, page.into())));

        std::thread::scope(|s| {
            s.spawn(|| {
                client.pull_and_apply(&store, 200).unwrap();
            });
            rx_started
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(
                store.try_lock().is_ok(),
                "store lock held across network I/O"
            );
            tx_release.send(()).unwrap();
        });
        assert_eq!(
            store.lock().unwrap().get_setting("sync_cursor").unwrap(),
            Some("c".into())
        );
    }

    #[test]
    fn deleted_document_never_syncs() {
        // Privacy regression: whatever is in the outbox for a deleted
        // document must not reach the network — the delete path removes
        // pending entries alongside the row.
        let (store, keys) = setup();
        queue_entry(&store);
        assert!(store.lock().unwrap().delete_document("doc-1").unwrap());
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        // No scripted responses: any request would panic the fake.
        let (client, transport) = make_client(Arc::new(FakeTransport::with(vec![])), keys);
        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(report, SyncReport::default());
        assert!(transport.seen_paths.lock().unwrap().is_empty());
    }

    #[test]
    fn push_pending_parks_on_real_400_without_retries() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = HttpTransport::new(stub_http_server(400, "bad request"));
        let client = SyncClient::new(Arc::new(transport), Arc::new(keys));

        let report = client.push_pending(&store, 10).unwrap();

        assert_eq!(report.sent, 0);
        assert_eq!(report.retried, 0);
        assert_eq!(report.parked, 1);
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get_document("doc-1")
                .unwrap()
                .unwrap()
                .status,
            "failed"
        );
        assert!(store.lock().unwrap().pending_outbox(10).unwrap().is_empty());
    }

    #[test]
    fn push_pending_sends_extraction_and_marks_synced() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, transport) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((201, "{}".into()))])),
            keys,
        );

        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(
            report,
            SyncReport {
                sent: 1,
                retried: 0,
                parked: 0,
                quality_flags: vec![],
            }
        );
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get_document("doc-1")
                .unwrap()
                .unwrap()
                .status,
            "synced"
        );
        assert_eq!(transport.seen_tokens.lock().unwrap()[0], "device-token");
        assert!(transport.seen_bodies.lock().unwrap()[0].contains("\"sourceHash\""));
    }

    #[test]
    fn push_pending_requires_pairing() {
        let (store, keys) = setup();
        queue_entry(&store);
        let (client, _) = make_client(Arc::new(FakeTransport::with(vec![])), keys);
        let err = client.push_pending(&store, 10).unwrap_err();
        assert!(matches!(err, CoreError::Sync(_)));
    }

    #[test]
    fn pairing_proposal_shape() {
        let proposal = PairingProposal::generate();
        assert_eq!(proposal.code.len(), 6);
        assert!(proposal.code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(proposal.secret.len(), 64);
        assert!(proposal.secret.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(proposal.display_code(), format!("DOK-{}", proposal.code));
    }

    #[test]
    fn propose_pairing_posts_code_name_secret() {
        let keys = InMemoryProvider::new();
        let (client, transport) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((200, "{}".into()))])),
            keys,
        );
        let proposal = PairingProposal {
            code: "482193".to_string(),
            secret: "s".repeat(64),
        };
        client.propose_pairing(&proposal, "MacBook Pro").unwrap();
        assert_eq!(
            transport.seen_paths.lock().unwrap()[0],
            "/app/v1/auth/pair-propose"
        );
        let body: serde_json::Value =
            serde_json::from_str(&transport.seen_bodies.lock().unwrap()[0]).unwrap();
        assert_eq!(body["code"], "482193");
        assert_eq!(body["deviceName"], "MacBook Pro");
        assert_eq!(body["secret"], "s".repeat(64));
    }

    #[test]
    fn propose_pairing_rejects_non_200() {
        let keys = InMemoryProvider::new();
        let (client, _) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((429, "slow down".into()))])),
            keys,
        );
        let proposal = PairingProposal {
            code: "482193".to_string(),
            secret: "s".repeat(64),
        };
        let err = client.propose_pairing(&proposal, "Mac").unwrap_err();
        assert!(matches!(err, CoreError::Sync(_)));
    }

    #[test]
    fn poll_pairing_claim_stores_token_when_claimed() {
        let keys = Arc::new(InMemoryProvider::new());
        let transport = Arc::new(FakeTransport::with(vec![]));
        transport
            .responses
            .lock()
            .unwrap()
            .push(Ok((200, r#"{"claimed":true,"token":"tok-1"}"#.to_string())));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            Arc::clone(&keys) as Arc<dyn KeyProvider>,
        );
        let proposal = PairingProposal {
            code: "482193".to_string(),
            secret: "s".repeat(64),
        };
        assert!(client.poll_pairing_claim(&proposal).unwrap());
        assert_eq!(
            keys.get(crate::crypto::TOKEN_ACCOUNT).unwrap(),
            Some("tok-1".to_string())
        );
        // POST with a JSON body — the secret must never appear in the path.
        let path = transport.seen_paths.lock().unwrap()[0].clone();
        assert_eq!(path, "/app/v1/auth/pair-status");
        let body: serde_json::Value =
            serde_json::from_str(&transport.seen_bodies.lock().unwrap()[0]).unwrap();
        assert_eq!(body["code"], "482193");
        assert_eq!(body["secret"], "s".repeat(64));
    }

    #[test]
    fn poll_pairing_claim_pending_without_storing() {
        let keys = Arc::new(InMemoryProvider::new());
        let transport = Arc::new(FakeTransport::with(vec![]));
        transport
            .responses
            .lock()
            .unwrap()
            .push(Ok((200, r#"{"claimed":false}"#.to_string())));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            Arc::clone(&keys) as Arc<dyn KeyProvider>,
        );
        let proposal = PairingProposal {
            code: "482193".to_string(),
            secret: "s".repeat(64),
        };
        assert!(!client.poll_pairing_claim(&proposal).unwrap());
        assert_eq!(keys.get(crate::crypto::TOKEN_ACCOUNT).unwrap(), None);
    }

    #[test]
    fn unpair_revokes_session_and_wipes_token() {
        let keys = Arc::new(InMemoryProvider::new());
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![]));
        transport
            .get_responses
            .lock()
            .unwrap()
            .push(Ok((200, "{}".to_string())));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            Arc::clone(&keys) as Arc<dyn KeyProvider>,
        );
        assert!(client.unpair().unwrap());
        assert_eq!(keys.get(crate::crypto::TOKEN_ACCOUNT).unwrap(), None);
        assert_eq!(
            transport.seen_paths.lock().unwrap()[0],
            "/app/v1/auth/session"
        );
        assert_eq!(transport.seen_tokens.lock().unwrap()[0], "device-token");
    }

    #[test]
    fn unpair_without_token_is_noop() {
        let keys = InMemoryProvider::new();
        let (client, transport) = make_client(Arc::new(FakeTransport::with(vec![])), keys);
        assert!(!client.unpair().unwrap());
        assert!(transport.seen_paths.lock().unwrap().is_empty());
    }

    #[test]
    fn push_pending_paused_when_upload_disabled() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        store
            .lock()
            .unwrap()
            .set_setting(SETTING_SYNC_UPLOAD, "0")
            .unwrap();
        let (client, transport) = make_client(Arc::new(FakeTransport::with(vec![])), keys);
        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(report, SyncReport::default());
        // Nothing reached the network.
        assert!(transport.seen_paths.lock().unwrap().is_empty());
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get_document("doc-1")
                .unwrap()
                .unwrap()
                .status,
            "extracted"
        );
    }

    #[test]
    fn push_pending_retries_on_network_error() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, _) = make_client(
            // LIFO: popped from the back — network error first.
            Arc::new(FakeTransport::with(vec![
                Ok((201, "{}".into())),
                Err("network down".into()),
            ])),
            keys,
        );
        // First pass: transient failure → retried. Second pass would succeed
        // but we only do one pass here. The document keeps its 'extracted'
        // status — only the outbox entry is re-queued.
        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(
            report,
            SyncReport {
                sent: 0,
                retried: 1,
                parked: 0,
                quality_flags: vec![],
            }
        );
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get_document("doc-1")
                .unwrap()
                .unwrap()
                .status,
            "extracted"
        );
    }

    #[test]
    fn push_pending_rejects_on_4xx() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, _) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((400, "bad request".into()))])),
            keys,
        );
        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(
            report,
            SyncReport {
                sent: 0,
                retried: 0,
                parked: 1,
                quality_flags: vec![],
            }
        );
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get_document("doc-1")
                .unwrap()
                .unwrap()
                .status,
            "failed"
        );
    }

    #[test]
    fn push_pending_aborts_on_401_leaving_entries_pending() {
        let (store, keys) = setup();
        queue_entry(&store);
        // Paired but with a wrong token — 401 aborts the drain with an
        // error INSTEAD of parking the batch as failed: the entries stay
        // pending so the next drain (after re-pairing) resumes them.
        keys.set(crate::crypto::TOKEN_ACCOUNT, "wrong-token")
            .unwrap();

        let (client, _) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((401, "Unauthorized".into()))])),
            keys,
        );
        let err = client.push_pending(&store, 10).unwrap_err();
        assert!(matches!(err, CoreError::Sync(_)));
        assert!(err.to_string().contains("401"));
        // Nothing was burned: the document is still 'extracted' (not
        // failed) and the outbox entry is still pending.
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get_document("doc-1")
                .unwrap()
                .unwrap()
                .status,
            "extracted"
        );
        assert_eq!(store.lock().unwrap().pending_outbox(10).unwrap().len(), 1);
    }

    #[test]
    fn push_pending_backs_off_on_429_instead_of_parking() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, _) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((429, "slow down".into()))])),
            keys,
        );
        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(
            report,
            SyncReport {
                sent: 0,
                retried: 1,
                parked: 0,
                quality_flags: vec![],
            }
        );
        // Rate-limiting is transient: the document is NOT failed, and the
        // entry is deferred via next_try_at (not due yet) rather than lost.
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get_document("doc-1")
                .unwrap()
                .unwrap()
                .status,
            "extracted"
        );
        assert_eq!(store.lock().unwrap().pending_outbox(10).unwrap().len(), 0);
    }

    #[test]
    fn push_pending_backs_off_on_408_instead_of_parking() {
        // 408 is ambiguous (server may or may not have processed the
        // idempotent ingest) — retry, never park on the first attempt.
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, _) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((408, "timeout".into()))])),
            keys,
        );
        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(report.retried, 1);
        assert_eq!(report.parked, 0);
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get_document("doc-1")
                .unwrap()
                .unwrap()
                .status,
            "extracted"
        );
    }

    #[test]
    fn captures_suggested_tasks_from_response() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, _) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((201, r#"{"documentId":"remote-1","created":true,"factsStored":1,"deadlinesCreated":0,"suggestedTasks":["Nachweis einreichen","Antrag stellen"]}"#.into()))])),
            keys,
        );
        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(report.sent, 1);

        let tasks = store.lock().unwrap().list_suggested_tasks().unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].title, "Nachweis einreichen");
        assert_eq!(tasks[0].remote_document_id, "remote-1");
        assert_eq!(tasks[0].status, "pending");
    }

    #[test]
    fn duplicate_upload_does_not_capture_suggested_tasks() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, _) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((200, r#"{"documentId":"remote-1","created":false,"factsStored":0,"deadlinesCreated":0,"suggestedTasks":[]}"#.into()))])),
            keys,
        );
        client.push_pending(&store, 10).unwrap();
        assert!(store
            .lock()
            .unwrap()
            .list_suggested_tasks()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn malformed_success_body_does_not_fail_sync() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, _) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((201, "not json".into()))])),
            keys,
        );
        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(report.sent, 1);
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get_document("doc-1")
                .unwrap()
                .unwrap()
                .status,
            "synced"
        );
        assert!(store
            .lock()
            .unwrap()
            .list_suggested_tasks()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn create_task_posts_linked_task_with_bearer_token() {
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let (client, transport) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((201, "{}".into()))])),
            keys,
        );

        client
            .create_task("Nachweis einreichen", "remote-1")
            .unwrap();
        let body = transport.seen_bodies.lock().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&body[0]).unwrap();
        assert_eq!(payload["title"], "Nachweis einreichen");
        assert_eq!(payload["sourceDocumentId"], "remote-1");
        assert_eq!(transport.seen_tokens.lock().unwrap()[0], "device-token");
    }

    #[test]
    fn create_task_requires_pairing() {
        let keys = InMemoryProvider::new();
        let (client, _) = make_client(Arc::new(FakeTransport::with(vec![])), keys);
        assert!(client.create_task("t", "d").is_err());
    }
    #[test]
    fn fetch_updates_parses_server_response_and_sends_cursor() {
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let body = r#"{
            "serverTime": "2026-08-22T10:00:00.000Z",
            "nextCursor": "2026-08-22T10:00:00.000Z",
            "documents": [{
                "id": "doc-9", "fileName": "vertrag.pdf", "title": null,
                "category": "mietvertrag", "factsCount": 2, "summary": null,
                "isActive": true, "status": "active", "appSource": false,
                "expiryDate": null, "docDate": null, "createdAt": null,
                "tags": [{"id":"t1","name":"Wohnung","color":null}]
            }],
            "deadlines": [{
                "id": "dl-1", "label": "Frist", "deadlineDate": "2026-09-01",
                "sourceType": "document", "sourceId": "doc-9", "completedAt": null
            }],
            "tasks": [{
                "id": "task-1", "title": "Unterlagen", "description": null,
                "dueDate": "2026-09-01", "status": "open", "priority": "high",
                "sourceType": "manual", "sourceDocumentId": null, "completedAt": null
            }],
            "deleted": {
                "documents": ["doc-gone"],
                "deadlines": ["dl-gone"],
                "tasks": ["task-gone"]
            },
            "hasMore": false
        }"#;

        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() = vec![Ok((200, body.to_string()))];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        let updates = client
            .fetch_updates(Some("2026-08-21T10:00:00.000Z"), 100)
            .unwrap();

        assert_eq!(updates.next_cursor, "2026-08-22T10:00:00.000Z");
        assert_eq!(updates.documents.len(), 1);
        assert_eq!(updates.documents[0].category, "mietvertrag");
        // The wire name is camelCase `fileName` — a missing serde rename
        // silently deserializes to None and drops every filename.
        assert_eq!(
            updates.documents[0].file_name.as_deref(),
            Some("vertrag.pdf")
        );
        assert_eq!(updates.documents[0].tags[0].name, "Wohnung");
        assert_eq!(updates.deadlines.len(), 1);
        assert_eq!(updates.deadlines[0].deadline_date, "2026-09-01");
        assert_eq!(updates.tasks.len(), 1);
        assert_eq!(updates.tasks[0].title, "Unterlagen");
        assert!(!updates.has_more);
        // Tombstoned ids ride along for the client to drop locally.
        assert_eq!(updates.deleted.documents, vec!["doc-gone".to_string()]);
        assert_eq!(updates.deleted.deadlines, vec!["dl-gone".to_string()]);
        assert_eq!(updates.deleted.tasks, vec!["task-gone".to_string()]);

        // Cursor + limit landed in the query string; bearer token was sent.
        let paths = transport.seen_paths.lock().unwrap();
        assert_eq!(
            paths[0],
            "/app/v1/sync?limit=100&cursor=2026-08-21T10:00:00.000Z"
        );
        assert_eq!(transport.seen_tokens.lock().unwrap()[0], "device-token");
    }

    #[test]
    fn remote_document_filename_survives_wire_and_cache_round_trips() {
        // Current wire format (camelCase).
        let wire: RemoteDocument =
            serde_json::from_str(r#"{"id":"d","fileName":"vertrag.pdf","category":"x"}"#).unwrap();
        assert_eq!(wire.file_name.as_deref(), Some("vertrag.pdf"));
        // Legacy snake_case payloads cached by older builds stay readable.
        let legacy: RemoteDocument =
            serde_json::from_str(r#"{"id":"d","file_name":"alt.pdf","category":"x"}"#).unwrap();
        assert_eq!(legacy.file_name.as_deref(), Some("alt.pdf"));
        // Re-serialization uses the wire name, so cache and server agree.
        let cached = serde_json::to_value(&wire).unwrap();
        assert_eq!(cached["fileName"], "vertrag.pdf");
        assert!(cached.get("file_name").is_none());
    }

    #[test]
    fn fetch_updates_full_pull_has_no_cursor_param() {
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() = vec![Ok((
            200,
            r#"{"nextCursor":"c","documents":[],"deadlines":[],"tasks":[],"hasMore":false}"#.into(),
        ))];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        let updates = client.fetch_updates(None, 50).unwrap();
        assert!(updates.documents.is_empty());
        let paths = transport.seen_paths.lock().unwrap();
        assert_eq!(paths[0], "/app/v1/sync?limit=50");
    }

    #[test]
    fn fetch_updates_encodes_plus_in_cursor() {
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() = vec![Ok((
            200,
            r#"{"nextCursor":"c","documents":[],"deadlines":[],"tasks":[],"hasMore":false}"#.into(),
        ))];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        client
            .fetch_updates(Some("2026-08-22T10:00:00+02:00"), 50)
            .unwrap();
        let paths = transport.seen_paths.lock().unwrap();
        assert!(paths[0].contains("cursor=2026-08-22T10:00:00%2B02:00"));
    }

    #[test]
    fn fetch_updates_requires_pairing_and_rejects_non_200() {
        // Unpaired
        let keys = InMemoryProvider::new();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );
        assert!(client.fetch_updates(None, 50).is_err());

        // Paired but server errors
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() = vec![Ok((500, "oops".into()))];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );
        let err = client.fetch_updates(None, 50).unwrap_err();
        assert!(matches!(err, CoreError::Sync(_)));
    }
    #[test]
    fn complete_deadline_patches_server_and_rejects_non_200() {
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![Ok((
            200,
            r#"{"updated":true,"completed":true}"#.into(),
        ))]));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        client.complete_deadline("dl-1", true).unwrap();

        let paths = transport.seen_paths.lock().unwrap();
        assert_eq!(paths[0], "/app/v1/deadlines/dl-1");
        let bodies = transport.seen_bodies.lock().unwrap();
        assert_eq!(bodies[0], r#"{"completed":true}"#);

        // Non-200 surfaces instead of a silent success.
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![Ok((400, "bad".into()))]));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );
        let err = client.complete_deadline("dl-1", false).unwrap_err();
        assert!(matches!(err, CoreError::Sync(_)));
    }

    #[test]
    fn ask_chat_posts_question_with_language_and_parses_answer() {
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![Ok((
            200,
            r#"{"answer":"Ihre Frist läuft am 01.09. ab."}"#.into(),
        ))]));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        let answer = client
            .ask_chat("Wann läuft meine Frist?", Some("de"))
            .unwrap();
        assert!(answer.contains("01.09."));
        let body = transport.seen_bodies.lock().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&body[0]).unwrap();
        assert_eq!(payload["question"], "Wann läuft meine Frist?");
        assert_eq!(payload["language"], "de");
        assert_eq!(transport.seen_paths.lock().unwrap()[0], "/app/v1/chat");
    }

    #[test]
    fn ask_chat_requires_pairing() {
        let keys = InMemoryProvider::new();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );
        assert!(client.ask_chat("q", None).is_err());
    }

    #[test]
    fn ask_document_posts_to_scoped_path_and_parses_answer() {
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![Ok((
            200,
            r#"{"answer":"Die Kürzung betrifft nur Oktober."}"#.into(),
        ))]));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        let answer = client
            .ask_document("doc-9", "Was bedeutet die Kürzung?", Some("de"))
            .unwrap();
        assert!(answer.contains("Oktober"));
        assert_eq!(
            transport.seen_paths.lock().unwrap()[0],
            "/app/v1/documents/doc-9/ask"
        );
        let body = transport.seen_bodies.lock().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&body[0]).unwrap();
        assert_eq!(payload["question"], "Was bedeutet die Kürzung?");
        assert_eq!(payload["language"], "de");
    }

    #[test]
    fn ask_document_requires_pairing_and_rejects_non_200() {
        let keys = InMemoryProvider::new();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );
        assert!(client.ask_document("doc-9", "q", None).is_err());
    }

    #[test]
    fn fetch_hints_parses_hint_list() {
        let keys = InMemoryProvider::new();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() = vec![Ok((
            200,
            r#"{"hints":[{"kind":"missing_widerspruch_deadline","severity":"high","documentIds":["doc-1"],"title":"Frist prüfen","body":"Bis Oktober."}]}"#.into(),
        ))];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        let hints = client.fetch_hints().unwrap();
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].kind, "missing_widerspruch_deadline");
        assert_eq!(hints[0].severity, "high");
        assert_eq!(hints[0].document_ids, vec!["doc-1".to_string()]);
        assert_eq!(transport.seen_paths.lock().unwrap()[0], "/app/v1/hints");
    }

    #[test]
    fn fetch_hints_requires_pairing_and_rejects_non_200() {
        let keys = InMemoryProvider::new();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );
        assert!(client.fetch_hints().is_err());
    }

    #[test]
    fn push_pending_reports_quality_flags_from_ingest_response() {
        let (store, keys) = setup();
        queue_entry(&store);
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, _) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((201, r#"{"documentId":"remote-1","created":true,"factsStored":1,"deadlinesCreated":0,"quality":{"score":65,"issues":[{"code":"no_dates","severity":"low","message":"Kein Datum."}]},"suggestedTasks":[]}"#.into()))])),
            keys,
        );
        let report = client.push_pending(&store, 10).unwrap();
        assert_eq!(report.sent, 1);
        assert_eq!(report.quality_flags.len(), 1);
        assert_eq!(report.quality_flags[0].document_id, "remote-1");
        assert_eq!(report.quality_flags[0].score, 65);
        assert_eq!(report.quality_flags[0].issues[0].code, "no_dates");
    }

    #[test]
    fn remote_document_without_insights_defaults_to_empty() {
        // Payloads cached before the analysis feature carry no insights key.
        let doc: crate::sync::RemoteDocument = serde_json::from_str(
            r#"{"id":"doc-1","category":"other","factsCount":0,"isActive":true,"tags":[]}"#,
        )
        .unwrap();
        assert!(doc.insights.is_empty());
    }
    #[test]
    fn transmitted_payload_never_contains_raw_text() {
        // PRIVACY INVARIANT: the outbox payload is the extraction JSON only.
        // The raw document text (kept solely in the encrypted store) must not
        // appear anywhere on the wire, even when it shares words with facts.
        let (store, keys) = setup();
        let secret_marker = "GEHEIMER_ROHTEXT_ANKER_7f3a";
        store
            .lock()
            .unwrap()
            .insert_document(
                "doc-1",
                &"h".repeat(64),
                Some("geheim.pdf"),
                "pdf",
                &format!("Vertraulicher Bescheid {secret_marker} mit vollstaendigem Text"),
                None,
            )
            .unwrap();
        store
            .lock()
            .unwrap()
            .save_extraction(
                "doc-1",
                &format!(
                    r#"{{"sourceHash":"{}","category":"other","facts":[],"deadlines":[],"obligations":[],"addresses":[],"amounts":[],"tags":[],"isActive":true}}"#,
                    "h".repeat(64)
                ),
            )
            .unwrap();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let (client, transport) = make_client(
            Arc::new(FakeTransport::with(vec![Ok((201, "{}".into()))])),
            keys,
        );
        client.push_pending(&store, 10).unwrap();

        let bodies = transport.seen_bodies.lock().unwrap();
        assert_eq!(bodies.len(), 1);
        assert!(!bodies[0].contains(secret_marker));
        assert!(!bodies[0].contains("Vertraulicher Bescheid"));
    }

    #[test]
    fn store_apply_updates_upserts_remote_data_and_cursor() {
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let updates = crate::sync::RemoteUpdates {
            next_cursor: "2026-08-22T10:00:00.000Z".into(),
            documents: vec![crate::sync::RemoteDocument {
                id: "doc-1".into(),
                source_hash: None,
                file_name: Some("vertrag.pdf".into()),
                title: Some("Mietvertrag".into()),
                category: "mietvertrag".into(),
                facts_count: 2,
                summary: Some("summary".into()),
                is_active: true,
                status: Some("active".into()),
                expiry_date: None,
                doc_date: None,
                created_at: None,
                tags: vec![],
                insights: vec![],
            }],
            deadlines: vec![crate::sync::RemoteDeadline {
                id: "dl-1".into(),
                label: "Frist".into(),
                deadline_date: "2026-09-01".into(),
                source_type: Some("document".into()),
                source_id: Some("doc-1".into()),
                completed_at: None,
            }],
            tasks: vec![crate::sync::RemoteTask {
                id: "task-1".into(),
                title: "Unterlagen".into(),
                description: None,
                due_date: Some("2026-09-01".into()),
                status: "open".into(),
                priority: Some("high".into()),
                source_type: Some("manual".into()),
                source_document_id: None,
                completed_at: None,
            }],
            deleted: Default::default(),
            has_more: false,
            resync: false,
        };

        store.lock().unwrap().apply_updates(&updates).unwrap();

        // Verify cursor stored
        assert_eq!(
            store.lock().unwrap().get_setting("sync_cursor").unwrap(),
            Some("2026-08-22T10:00:00.000Z".into())
        );

        // Verify remote data retrievable
        let data = store.lock().unwrap().remote_data().unwrap();
        assert_eq!(data.documents.len(), 1);
        assert_eq!(data.documents[0].id, "doc-1");
        assert_eq!(data.documents[0].category, "mietvertrag");
        assert_eq!(data.deadlines.len(), 1);
        assert_eq!(data.deadlines[0].id, "dl-1");
        assert_eq!(data.tasks.len(), 1);
        assert_eq!(data.tasks[0].title, "Unterlagen");
    }

    #[test]
    fn store_apply_updates_is_idempotent() {
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let updates = crate::sync::RemoteUpdates {
            next_cursor: "cursor-1".into(),
            documents: vec![crate::sync::RemoteDocument {
                id: "doc-1".into(),
                source_hash: None,
                file_name: None,
                title: None,
                category: "other".into(),
                facts_count: 0,
                summary: None,
                is_active: true,
                status: None,
                expiry_date: None,
                doc_date: None,
                created_at: None,
                tags: vec![],
                insights: vec![],
            }],
            deadlines: vec![],
            tasks: vec![],
            deleted: Default::default(),
            has_more: false,
            resync: false,
        };

        store.lock().unwrap().apply_updates(&updates).unwrap();
        store.lock().unwrap().apply_updates(&updates).unwrap(); // same data again

        let data = store.lock().unwrap().remote_data().unwrap();
        assert_eq!(data.documents.len(), 1); // still just one row
    }

    #[test]
    fn pull_and_apply_fetches_all_pages_and_applies() {
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        // Page 1 response
        let page1 = r#"{
            "nextCursor": "c2",
            "documents": [{"id":"d1","fileName":null,"title":null,"category":"other","factsCount":0,"summary":null,"isActive":true,"status":null,"appSource":false,"expiryDate":null,"docDate":null,"createdAt":null,"tags":[]}],
            "deadlines": [],
            "tasks": [],
            "hasMore": true
        }"#;
        // Page 2 response
        let page2 = r#"{
            "nextCursor": "c3",
            "documents": [{"id":"d2","fileName":null,"title":null,"category":"other","factsCount":0,"summary":null,"isActive":true,"status":null,"appSource":false,"expiryDate":null,"docDate":null,"createdAt":null,"tags":[]}],
            "deadlines": [],
            "tasks": [],
            "hasMore": false
        }"#;

        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() =
            vec![Ok((200, page2.into())), Ok((200, page1.into()))];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        let report = client.pull_and_apply(&store, 200).unwrap();

        assert_eq!(report.pages, 2);
        assert_eq!(report.documents, 2);
        assert_eq!(report.deadlines, 0);
        assert_eq!(report.tasks, 0);

        let data = store.lock().unwrap().remote_data().unwrap();
        assert_eq!(data.documents.len(), 2);

        // Cursor should be advanced to the last page's nextCursor
        assert_eq!(
            store.lock().unwrap().get_setting("sync_cursor").unwrap(),
            Some("c3".into())
        );

        // Paths should show two requests with correct cursors
        let paths = transport.seen_paths.lock().unwrap();
        assert_eq!(paths.len(), 2);
        assert!(!paths[0].contains("cursor=")); // first request had no cursor (None)
        assert!(paths[1].contains("cursor=c2")); // second request uses page1's nextCursor
    }

    #[test]
    fn pull_and_apply_errors_when_pages_remain() {
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        // Always return hasMore=true with one doc per page
        let page = r#"{
            "nextCursor": "next",
            "documents": [{"id":"d","fileName":null,"title":null,"category":"other","factsCount":0,"summary":null,"isActive":true,"status":null,"appSource":false,"expiryDate":null,"docDate":null,"createdAt":null,"tags":[]}],
            "deadlines": [],
            "tasks": [],
            "hasMore": true
        }"#;

        let transport = Arc::new(FakeTransport::with(vec![]));
        // LIFO: we push 60 responses, but MAX_PAGES=50, so only 50 should be processed
        *transport.get_responses.lock().unwrap() = vec![Ok((200, page.into())); 60];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        // Capped with rows pending: an error (surfaced in the UI's sync
        // error slot), never a silent truncation.
        let err = client.pull_and_apply(&store, 1).unwrap_err();
        assert!(matches!(err, CoreError::Sync(_)));
        // All 50 pages were applied and the cursor advanced past them, so
        // the next pull resumes instead of restarting.
        assert_eq!(transport.seen_paths.lock().unwrap().len(), 50);
        assert_eq!(
            store.lock().unwrap().get_setting("sync_cursor").unwrap(),
            Some("next".into())
        );
    }

    #[test]
    fn pull_and_apply_requires_pairing() {
        let (store, keys) = setup();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );
        assert!(client.pull_and_apply(&store, 10).is_err());
    }

    #[test]
    fn schema_version_stamped_on_fresh_open() {
        let (store, _keys) = setup();
        assert_eq!(store.lock().unwrap().schema_version().unwrap(), 4);
    }

    #[test]
    fn reopened_store_keeps_data_and_version() {
        // Pre-versioning databases (user_version 0, v1 tables on disk) take
        // the same path: IF NOT EXISTS baseline is a no-op, version stamps.
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        let keys = InMemoryProvider::new();
        {
            let store = Store::open(&path, &keys).unwrap();
            store
                .insert_document("d1", &"h".repeat(64), None, "pdf", "raw", None)
                .unwrap();
            store.set_setting("sync_cursor", "c1").unwrap();
        }
        let store = Store::open(&path, &keys).unwrap();
        assert_eq!(store.schema_version().unwrap(), 4);
        assert_eq!(store.get_setting("sync_cursor").unwrap(), Some("c1".into()));
    }

    #[test]
    fn source_path_round_trips_and_raw_text_update_resets() {
        let (store, _keys) = setup();
        let store = store.lock().unwrap();
        store
            .insert_document("d1", &"h".repeat(64), None, "pdf", "raw", None)
            .unwrap();
        // Pre-v2 rows carry NULL.
        assert_eq!(store.get_source_path("d1").unwrap(), None);
        assert_eq!(store.get_source_path("missing").unwrap(), None);

        // A server-side re-scan replaces the text and re-arms extraction.
        assert!(store.update_raw_text("d1", "scanned text").unwrap());
        let doc = store.get_document("d1").unwrap().unwrap();
        assert_eq!(doc.raw_text, "scanned text");
        assert_eq!(doc.status, "pending");
        assert!(!store.update_raw_text("missing", "x").unwrap());
    }

    #[test]
    fn read_scan_image_caps_and_encodes() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scan.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n pixels").unwrap();
        let b64 = read_scan_image(&path).unwrap();
        assert_eq!(
            b64,
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n pixels")
        );

        // Oversize fails fast without reading the whole file.
        let big = dir.path().join("big.png");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_SCAN_IMAGE_BYTES + 1).unwrap();
        let err = read_scan_image(&big).unwrap_err();
        assert!(
            matches!(err, crate::error::CoreError::FileTooLarge { .. }),
            "unexpected: {err}"
        );
    }

    #[test]
    fn scan_image_posts_base64_and_returns_text() {
        let (_store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![Ok((
            200,
            r#"{"text":"BG-Nummer 123"}"#.into(),
        ))]));
        let (client, seen) = make_client(Arc::clone(&transport), keys);
        let text = client.scan_image_bytes("aGk=", Some("de")).unwrap();
        assert_eq!(text, "BG-Nummer 123");
        assert_eq!(
            seen.seen_paths.lock().unwrap().as_slice(),
            ["/app/v1/scan-image"]
        );
        let body = seen.seen_bodies.lock().unwrap().pop().unwrap();
        assert!(
            body.contains(r#""image":"aGk=""#),
            "image payload missing: {body}"
        );
        assert!(
            body.contains(r#""language":"de""#),
            "language missing: {body}"
        );
    }

    #[test]
    fn scan_image_rejects_unpaired_and_http_errors() {
        // Unpaired: no token, no network.
        let (_store, keys) = setup();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let (client, _seen) = make_client(transport, keys);
        let err = client.scan_image_bytes("aGk=", None).unwrap_err();
        assert!(err.to_string().contains("not paired"), "unexpected: {err}");

        // Paired but rejected: 429 names the rate limit, other codes the status.
        for (status, needle) in [(429u16, "rate-limited"), (400u16, "HTTP 400")] {
            let (_store, keys) = setup();
            keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
                .unwrap();
            let transport = Arc::new(FakeTransport::with(vec![Ok((status, "nope".into()))]));
            let (client, _seen) = make_client(transport, keys);
            let err = client.scan_image_bytes("aGk=", None).unwrap_err();
            assert!(err.to_string().contains(needle), "unexpected: {err}");
        }
    }

    #[test]
    fn clear_setting_removes_cursor_and_tolerates_absence() {
        let (store, _keys) = setup();
        let store = store.lock().unwrap();
        store.set_setting("sync_cursor", "c1").unwrap();
        store.clear_setting("sync_cursor").unwrap();
        assert_eq!(store.get_setting("sync_cursor").unwrap(), None);
        // Idempotent — clearing again is not an error.
        store.clear_setting("sync_cursor").unwrap();
    }

    #[test]
    fn resync_page_wipes_stale_snapshot() {
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let stale_page = r#"{
            "nextCursor": "c1",
            "documents": [{"id":"d-old","fileName":null,"title":null,"category":"other","factsCount":0,"summary":null,"isActive":true,"status":null,"appSource":false,"expiryDate":null,"docDate":null,"createdAt":null,"tags":[]}],
            "deadlines": [],
            "tasks": [],
            "hasMore": false
        }"#;
        let resync_page = r#"{
            "nextCursor": "c2",
            "documents": [{"id":"d-new","fileName":null,"title":null,"category":"other","factsCount":0,"summary":null,"isActive":true,"status":null,"appSource":false,"expiryDate":null,"docDate":null,"createdAt":null,"tags":[]}],
            "deadlines": [],
            "tasks": [],
            "hasMore": false,
            "resync": true
        }"#;

        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() =
            vec![Ok((200, resync_page.into())), Ok((200, stale_page.into()))];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        let first = client.pull_and_apply(&store, 200).unwrap();
        assert!(!first.resynced);
        assert_eq!(
            store.lock().unwrap().remote_data().unwrap().documents.len(),
            1
        );

        let second = client.pull_and_apply(&store, 200).unwrap();
        assert!(second.resynced);
        // The stale row is gone — only the resync page's document remains.
        let data = store.lock().unwrap().remote_data().unwrap();
        assert_eq!(data.documents.len(), 1);
        assert_eq!(data.documents[0].id, "d-new");
        assert_eq!(
            store.lock().unwrap().get_setting("sync_cursor").unwrap(),
            Some("c2".into())
        );
    }

    #[test]
    fn validate_ask_counts_the_way_the_backend_does() {
        let (_store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let (client, t) = make_client(transport, keys);

        // 2001 astral chars: 2001 Rust `char`s but 4002 UTF-16 units, which
        // is what the backend's Zod `.max(4000)` measures. Counting chars let
        // this through to a guaranteed 400.
        let emoji = "\u{1F600}".repeat(2001);
        assert!(matches!(
            client.ask_chat(&emoji, None),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(t.seen_paths.lock().unwrap().is_empty());

        // Just inside the bound still goes out.
        let ok = "\u{1F600}".repeat(2000);
        *t.responses.lock().unwrap() = vec![Ok((200, r#"{"answer":"ja"}"#.into()))];
        assert_eq!(client.ask_chat(&ok, None).unwrap(), "ja");
    }

    #[test]
    fn accepted_push_records_the_server_document_id() {
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        queue_entry(&store);

        let transport = Arc::new(FakeTransport::with(vec![Ok((
            200,
            r#"{"documentId":"srv-42","created":true,"suggestedTasks":[]}"#.into(),
        ))]));
        let (client, _t) = make_client(transport, keys);

        assert_eq!(client.push_pending(&store, 10).unwrap().sent, 1);
        // Without this id there is no way to address DELETE
        // /app/v1/documents/{id}, so a local delete leaves the server copy.
        assert_eq!(
            store.lock().unwrap().remote_document_id("doc-1").unwrap(),
            Some("srv-42".to_string())
        );
    }

    #[test]
    fn duplicate_push_still_records_the_server_document_id() {
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        queue_entry(&store);

        // created=false with no quality issues: the response parser used to
        // discard this body entirely, losing the id with it.
        let transport = Arc::new(FakeTransport::with(vec![Ok((
            200,
            r#"{"documentId":"srv-dup","created":false,"suggestedTasks":[]}"#.into(),
        ))]));
        let (client, _t) = make_client(transport, keys);

        assert_eq!(client.push_pending(&store, 10).unwrap().sent, 1);
        assert_eq!(
            store.lock().unwrap().remote_document_id("doc-1").unwrap(),
            Some("srv-dup".to_string())
        );
    }

    #[test]
    fn update_task_status_patches_the_task() {
        let (_store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![Ok((200, "{}".into()))]));
        let (client, t) = make_client(transport, keys);

        client.update_task_status("task-1", "done").unwrap();
        assert_eq!(
            t.seen_paths.lock().unwrap().as_slice(),
            ["/app/v1/tasks/task-1"]
        );
        assert_eq!(
            t.seen_bodies.lock().unwrap().as_slice(),
            [r#"{"status":"done"}"#]
        );
    }

    #[test]
    fn update_task_status_rejects_unknown_states_before_the_network() {
        let (_store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let (client, t) = make_client(transport, keys);

        // Mirrors the backend Zod enum — a typo must not cost a round trip.
        assert!(matches!(
            client.update_task_status("task-1", "finished"),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(t.seen_paths.lock().unwrap().is_empty());
    }

    #[test]
    fn update_task_status_surfaces_server_rejection() {
        let (_store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![Ok((404, "gone".into()))]));
        let (client, _t) = make_client(transport, keys);

        assert!(client.update_task_status("task-1", "done").is_err());
    }

    #[test]
    fn delete_remote_document_targets_the_server_id() {
        let (_store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() = vec![Ok((200, "{}".into()))];
        let (client, t) = make_client(transport, keys);

        client.delete_remote_document("srv-42").unwrap();
        assert_eq!(
            t.seen_paths.lock().unwrap().as_slice(),
            ["/app/v1/documents/srv-42"]
        );
        assert_eq!(t.seen_tokens.lock().unwrap().as_slice(), ["device-token"]);
    }

    #[test]
    fn delete_remote_document_treats_404_as_done_and_surfaces_the_rest() {
        let (_store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![]));
        // LIFO: 404 first, then 500.
        *transport.get_responses.lock().unwrap() =
            vec![Ok((500, "boom".into())), Ok((404, "gone".into()))];
        let (client, _t) = make_client(transport, keys);

        // Already gone is the state the caller asked for.
        client.delete_remote_document("srv-1").unwrap();
        // A server error must NOT read as deleted — the caller keeps the
        // local row instead of leaving the copy only where nobody looks.
        assert!(client.delete_remote_document("srv-2").is_err());
    }

    #[test]
    fn delete_remote_document_requires_pairing() {
        let (_store, keys) = setup();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let (client, t) = make_client(transport, keys);

        assert!(client.delete_remote_document("srv-1").is_err());
        assert!(t.seen_paths.lock().unwrap().is_empty());
    }

    #[test]
    fn scan_image_cap_matches_the_backend_raw_byte_limit() {
        // Backend: VISION_MAX_BASE64_BYTES * 3 / 4 (vision.types.ts). The old
        // 5 MB was Bedrock's figure applied to the wrong unit, and rejected
        // ordinary phone photos the server would have taken.
        assert_eq!(MAX_SCAN_IMAGE_BYTES, 7_864_320);
    }

    #[test]
    fn poisoned_cursor_retries_once_as_full_pull() {
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        store
            .lock()
            .unwrap()
            .set_setting("sync_cursor", "poison")
            .unwrap();

        // A row cached under the now-unusable cursor. The server deleted it
        // while the cursor was poisoned, so the recovery pull cannot mention
        // it — only the wipe can remove it.
        store
            .lock()
            .unwrap()
            .apply_updates(&RemoteUpdates {
                next_cursor: "poison".into(),
                documents: vec![RemoteDocument {
                    id: "d-stale".to_string(),
                    source_hash: None,
                    file_name: Some("stale.pdf".to_string()),
                    title: None,
                    category: "other".to_string(),
                    facts_count: 0,
                    summary: None,
                    is_active: true,
                    status: None,
                    expiry_date: None,
                    doc_date: None,
                    created_at: None,
                    tags: vec![],
                    insights: vec![],
                }],
                deadlines: vec![],
                tasks: vec![],
                deleted: Default::default(),
                has_more: false,
                resync: false,
            })
            .unwrap();

        let full_page = r#"{
            "nextCursor": "c-fresh",
            "documents": [{"id":"d-new","category":"other"}],
            "deadlines": [],
            "tasks": [],
            "hasMore": false
        }"#;

        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() = vec![
            Ok((200, full_page.into())),
            Ok((400, "cursor rejected".into())),
        ];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        let report = client.pull_and_apply(&store, 200).unwrap();
        assert_eq!(report.pages, 1);
        // Restarting from scratch IS a resync: the report says so, and the
        // stale row is gone. (This assertion used to read `!resynced` — it
        // encoded the bug: the snapshot was kept, so a row deleted while the
        // cursor was unusable stayed visible forever.)
        assert!(report.resynced);
        let data = store.lock().unwrap().remote_data().unwrap();
        assert_eq!(data.documents.len(), 1);
        assert_eq!(data.documents[0].id, "d-new");

        let paths = transport.seen_paths.lock().unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].contains("cursor=poison"));
        assert!(!paths[1].contains("cursor="));
        // The retry's cursor replaced the poisoned one.
        assert_eq!(
            store.lock().unwrap().get_setting("sync_cursor").unwrap(),
            Some("c-fresh".into())
        );
    }

    #[test]
    fn poisoned_full_pull_surfaces_the_400() {
        // No stored cursor: a 400 is a real bug, not a poisoned cursor —
        // no retry, surface it.
        let (store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();

        let transport = Arc::new(FakeTransport::with(vec![]));
        *transport.get_responses.lock().unwrap() = vec![Ok((400, "bad limit".into()))];
        let client = SyncClient::new(
            Arc::clone(&transport) as Arc<dyn Transport>,
            std::sync::Arc::new(keys),
        );

        let err = client.pull_and_apply(&store, 200).unwrap_err();
        assert!(matches!(err, CoreError::Sync(_)));
        assert_eq!(transport.seen_paths.lock().unwrap().len(), 1);
    }

    #[test]
    fn ask_chat_rejects_empty_and_oversize_questions_before_any_io() {
        let (_store, keys) = setup();
        let transport = Arc::new(FakeTransport::with(vec![Ok((
            200,
            r#"{"answer":"a"}"#.into(),
        ))]));
        let (client, transport) = make_client(transport, keys);

        for bad in ["", "   ", "\n\t "] {
            assert!(
                matches!(client.ask_chat(bad, None), Err(CoreError::InvalidInput(_))),
                "empty question must fail validation: {bad:?}"
            );
        }
        let oversize = "x".repeat(4001);
        assert!(matches!(
            client.ask_chat(&oversize, None),
            Err(CoreError::InvalidInput(_))
        ));
        // Nothing reached the transport — no round trip was paid.
        assert!(transport.seen_paths.lock().unwrap().is_empty());
    }

    #[test]
    fn ask_chat_boundary_4000_chars_passes_validation() {
        // Exactly at the backend Zod cap: validation passes, the call fails
        // later on the missing pairing — proving the length check let it
        // through.
        let (_store, keys) = setup();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let (client, _transport) = make_client(transport, keys);

        let err = client.ask_chat(&"x".repeat(4000), None).unwrap_err();
        assert!(
            matches!(err, CoreError::Sync(_)),
            "expected pairing failure past validation, got: {err}"
        );
    }

    #[test]
    fn ask_question_is_trimmed_before_sending() {
        let (_store, keys) = setup();
        keys.set(crate::crypto::TOKEN_ACCOUNT, "device-token")
            .unwrap();
        let transport = Arc::new(FakeTransport::with(vec![Ok((
            200,
            r#"{"answer":"a"}"#.into(),
        ))]));
        let (client, transport) = make_client(transport, keys);

        assert_eq!(client.ask_chat("  frage  ", None).unwrap(), "a");
        let bodies = transport.seen_bodies.lock().unwrap();
        assert_eq!(bodies.len(), 1);
        assert!(bodies[0].contains(r#""question":"frage""#));
    }

    #[test]
    fn ask_document_shares_the_same_input_validation() {
        let (_store, keys) = setup();
        let transport = Arc::new(FakeTransport::with(vec![]));
        let (client, transport) = make_client(transport, keys);

        assert!(matches!(
            client.ask_document("doc-1", "", None),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            client.ask_document("doc-1", &"x".repeat(5000), None),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(transport.seen_paths.lock().unwrap().is_empty());
    }
}

/// Whether a base URL may carry the device token.
///
/// The token is sent as a Bearer header on every sync request. `resolve_base_url`
/// checked only that the scheme was http(s) — enough to stop `file:` or
/// `javascript:` exfiltration, but it let a REMOTE `http://` origin through, and
/// nothing in this repository terminates TLS. A plain-HTTP backend on anything
/// but the loopback interface therefore put a credential that grants full
/// access to `/app/v1/*` on the wire in clear text.
///
/// Loopback stays allowed on purpose: `http://127.0.0.1:3000` is the documented
/// development default, there is no network to sniff, and requiring TLS there
/// would only push people to disable verification.
pub fn base_url_allows_token(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("https://") {
        return !rest.is_empty();
    }
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        // Strip credentials, if someone wrote them into the URL.
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = match host.rfind(':') {
        // Keep bracketed IPv6 literals whole: the last colon inside "[::1]"
        // is part of the address, not a port separator.
        Some(idx) if !host.ends_with(']') => &host[..idx],
        _ => host,
    };
    matches!(
        host.trim_end_matches('.'),
        "localhost" | "127.0.0.1" | "[::1]" | "::1"
    ) || host.starts_with("127.")
}

#[cfg(test)]
mod base_url_tests {
    use super::base_url_allows_token;

    #[test]
    fn https_is_always_allowed() {
        assert!(base_url_allows_token("https://api.example.com"));
        assert!(base_url_allows_token("https://api.example.com:8443/base"));
    }

    #[test]
    fn loopback_http_is_allowed_because_there_is_no_wire() {
        for url in [
            "http://127.0.0.1:3000",
            "http://localhost:3000",
            "http://localhost",
            "http://127.0.0.5:3000",
            "http://[::1]:3000",
        ] {
            assert!(base_url_allows_token(url), "should allow {url}");
        }
    }

    #[test]
    fn remote_http_is_refused_the_token() {
        // The whole point: a Bearer token that grants full access to /app/v1
        // must not travel in clear text across a network.
        for url in [
            "http://api.example.com",
            "http://203.0.113.10:3000",
            "http://example.com/base",
            // Not loopback — a host that merely starts with the same letters.
            "http://localhost.evil.com",
            // Credentials in the URL must not disguise the real host.
            "http://127.0.0.1@evil.com",
        ] {
            assert!(!base_url_allows_token(url), "should refuse {url}");
        }
    }

    #[test]
    fn non_http_schemes_stay_refused() {
        for url in ["file:///etc/passwd", "javascript:alert(1)", "ws://x", ""] {
            assert!(!base_url_allows_token(url), "should refuse {url}");
        }
    }
}
