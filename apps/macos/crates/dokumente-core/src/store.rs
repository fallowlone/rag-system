//! Encrypted local store (SQLCipher). Holds the raw extracted text (which
//! never leaves the device), the local model's extraction JSON, and the sync
//! outbox queue.

use crate::crypto::KeyProvider;
use crate::error::{CoreError, Result};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS documents (
    id              TEXT PRIMARY KEY,
    source_hash     TEXT NOT NULL UNIQUE,
    file_name       TEXT,
    kind            TEXT NOT NULL,
    raw_text        TEXT NOT NULL,
    extraction_json TEXT,          -- NULL until the local model has run
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'extracted', 'synced', 'failed')),
    error           TEXT,
    source_path     TEXT,          -- original file path (v2): NULL for pre-v2 rows
    remote_document_id TEXT,       -- server-side id (v3): NULL until a push is accepted
    coverage_chars  INTEGER,       -- chars the model actually read (v4): NULL until extracted
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    payload     TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sending', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);

CREATE TABLE IF NOT EXISTS suggested_tasks (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    remote_document_id TEXT NOT NULL,
    title              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'confirmed', 'dismissed')),
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_suggested_tasks_status ON suggested_tasks(status, id);

CREATE TABLE IF NOT EXISTS remote_documents (
    id      TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_deadlines (
    id      TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_tasks (
    id      TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

/// Current schema version, tracked via `PRAGMA user_version`. Bump on every
/// SCHEMA_SQL change and add the matching step in `migrate()`.
const SCHEMA_VERSION: i64 = 4;

pub struct Store {
    conn: Connection,
}

#[derive(Debug)]
pub struct DocumentRow {
    pub id: String,
    pub source_hash: String,
    pub file_name: Option<String>,
    pub kind: String,
    pub raw_text: String,
    pub extraction_json: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    /// True when the document is longer than one extraction pass can see
    /// (`MAX_PROMPT_DOC_CHARS`). DERIVED, not stored: it is a property of the
    /// text we already hold, so there is nothing to migrate and nothing that
    /// can fall out of sync with the cap.
    ///
    /// It exists because the cut is otherwise invisible. `build_user_prompt`
    /// silently caps the prompt, the model returns well-formed JSON about the
    /// part it saw, and the row lands as a normal "extracted" document — so a
    /// Bescheid whose Widerspruchsfrist sits past the cut reads as fully
    /// analysed. The deterministic backstop still scans the FULL text, which
    /// is why this is a caveat and not a failure.
    pub coverage_truncated: bool,
}

#[derive(Debug)]
pub struct OutboxEntry {
    pub id: i64,
    pub document_id: String,
    pub payload: String,
    pub attempts: i64,
}

/// A task the backend suggested from a synced document's obligations — shown
/// to the user for confirmation, then created remotely via /app/v1/tasks.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SuggestedTask {
    pub id: i64,
    pub document_id: String,
    /// The document id AS CREATED SERVER-SIDE — used as `sourceDocumentId`
    /// when confirming, so the created task is linked to the real document.
    pub remote_document_id: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
}

fn key_to_hex(key: &str) -> String {
    key.bytes().map(|b| format!("{b:02x}")).collect()
}

/// Applies pending schema migrations. The v1 baseline runs through
/// `IF NOT EXISTS` in SCHEMA_SQL, so a pre-versioning database (user_version
/// 0 with all v1 tables already on disk — every install predating this
/// mechanism) is shape-identical to a fresh one: stamping is the whole
/// migration. Future versions add `if version < N` steps below.
fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    // v2: original file path on documents (server-side scan re-reads the
    // image). Column presence is probed, not assumed: fresh databases
    // already have it via SCHEMA_SQL, so a blind ALTER would fail there.
    if version < 2 && !has_column(conn, "documents", "source_path")? {
        conn.execute_batch("ALTER TABLE documents ADD COLUMN source_path TEXT")?;
    }
    // v3: the server-side document id, recorded when a push is accepted.
    // Without it the client cannot address DELETE /app/v1/documents/{id},
    // so a local delete left the server copy (and its summary, insights and
    // docvault vectors) behind and the row reappeared on the next pull.
    if version < 3 && !has_column(conn, "documents", "remote_document_id")? {
        conn.execute_batch("ALTER TABLE documents ADD COLUMN remote_document_id TEXT")?;
    }
    // v4: characters the model actually read, across all extraction windows.
    // Coverage stopped being derivable from the text length once extraction
    // became multi-pass: a window failing mid-way leaves real coverage below
    // what the length implies, and the "partially analysed" disclosure has to
    // reflect the run, not the file.
    if version < 4 && !has_column(conn, "documents", "coverage_chars")? {
        conn.execute_batch("ALTER TABLE documents ADD COLUMN coverage_chars INTEGER")?;
    }
    if version < SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in rows {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}
/// Locks a shared store. Long-running operations (network drains, inference)
/// must never hold this across I/O — snapshot what they need, drop the
/// guard, then re-lock per write (see SyncClient::push_pending).
pub(crate) fn lock_shared(store: &Mutex<Store>) -> Result<MutexGuard<'_, Store>> {
    store.lock().map_err(|_| CoreError::LockPoisoned)
}

impl Store {
    /// Opens (creating if needed) an encrypted database at `path`. The key
    /// comes from the KeyProvider — a wrong key fails on first access with
    /// a "file is not a database" error, not silently.
    pub fn open(path: &Path, keys: &dyn KeyProvider) -> Result<Self> {
        let key = keys.get_or_create_key()?;
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "key", key_to_hex(&key))?;
        // Explicit even though the bundled build defaults it on: ON DELETE
        // CASCADE (outbox, suggested_tasks) must never depend on a compile
        // flag surviving a future rusqlite/sqlcipher bump.
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Fail fast on a wrong key instead of deferring to the first query.
        conn.pragma_update(None, "journal_mode", "DELETE")?;
        conn.execute_batch(SCHEMA_SQL)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    /// In-memory encrypted database for tests.
    pub fn open_in_memory(keys: &dyn KeyProvider) -> Result<Self> {
        let key = keys.get_or_create_key()?;
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "key", key_to_hex(&key))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA_SQL)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    /// Ensures the DB is unreadable without the key: opening the same file
    /// with a different key must fail. (Sanity check used by tests and a
    /// future diagnostics screen.)
    pub fn verify_key(path: &Path, key: &str) -> bool {
        let conn = match Connection::open(path) {
            Ok(c) => c,
            Err(_) => return false,
        };
        if conn.pragma_update(None, "key", key_to_hex(key)).is_err() {
            return false;
        }
        conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |_| Ok(()))
            .is_ok()
    }

    /// Current schema version (`PRAGMA user_version`, see `migrate`).
    /// Surfaced for tests and a future diagnostics screen.
    pub fn schema_version(&self) -> Result<i64> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    pub fn insert_document(
        &self,
        id: &str,
        source_hash: &str,
        file_name: Option<&str>,
        kind: &str,
        raw_text: &str,
        source_path: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO documents (id, source_hash, file_name, kind, raw_text, status, source_path)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
            params![id, source_hash, file_name, kind, raw_text, source_path],
        )?;
        Ok(())
    }

    /// Returns the stored original file path, if the row has one (NULL for
    /// pre-v2 rows and for moved/deleted files — callers must handle None).
    pub fn get_source_path(&self, id: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT source_path FROM documents WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(row.get(0)?),
            None => Ok(None),
        }
    }

    /// Replaces the raw text after an out-of-band re-scan (server-side
    /// vision): clears the stale extraction/failed state back to pending so
    /// the normal extract flow picks it up.
    pub fn update_raw_text(&self, id: &str, raw_text: &str) -> Result<bool> {
        let updated = self.conn.execute(
            // coverage_chars clears with the text it described: a server
            // scan replaces the raw text wholesale, so the previous run's
            // reach says nothing about the new content.
            "UPDATE documents
             SET raw_text = ?2, extraction_json = NULL, status = 'pending', error = NULL,
                 coverage_chars = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![id, raw_text],
        )?;
        Ok(updated > 0)
    }

    /// Dedup check before any (expensive) local-model run.
    pub fn has_source_hash(&self, source_hash: &str) -> Result<bool> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM documents WHERE source_hash = ?1",
            params![source_hash],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn get_document(&self, id: &str) -> Result<Option<DocumentRow>> {
        let mut rows = self.query_documents("WHERE id = ?1", params![id])?;
        Ok(rows.pop())
    }

    pub fn list_documents(&self) -> Result<Vec<DocumentRow>> {
        self.query_documents("ORDER BY created_at DESC", params![])
    }

    fn query_documents(
        &self,
        tail: &str,
        params: impl rusqlite::Params,
    ) -> Result<Vec<DocumentRow>> {
        // `length()` on TEXT counts characters, matching the char-based cap
        // in `build_user_prompt` — comparing bytes would over-report for any
        // document with umlauts, i.e. all of them.
        //
        // `coverage_chars` is what the last run actually read; the cap is the
        // fallback for rows written before v4 and for documents not yet
        // extracted. The fallback errs toward disclosure: it can only claim
        // truncation that a later run disproves, never hide one.
        let sql = format!(
            "SELECT id, source_hash, file_name, kind, raw_text, extraction_json,
                    status, error, created_at,
                    length(raw_text) > COALESCE(coverage_chars, {cap})
                        AS coverage_truncated
             FROM documents {tail}",
            cap = crate::llm::MAX_PROMPT_DOC_CHARS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params, map_document_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Persists the local model's extraction and queues it for sync.
    /// `raw_text` stays local — the outbox payload contains only the
    /// structured extraction. Re-extraction replaces any still-pending
    /// outbox entry for the document instead of queueing a duplicate POST.
    ///
    /// All three writes run inside one SAVEPOINT: a crash between the
    /// outbox DELETE and the INSERT must never lose the queued upload
    /// (the pre-transaction code had exactly that window).
    /// `save_extraction` plus the coverage the run achieved. Separate rather
    /// than a changed signature: every existing caller means "coverage
    /// unknown", and making them all say so explicitly would be noise.
    pub fn save_extraction_with_coverage(
        &self,
        id: &str,
        extraction_json: &str,
        covered_chars: i64,
    ) -> Result<()> {
        self.save_extraction(id, extraction_json)?;
        self.conn.execute(
            "UPDATE documents SET coverage_chars = ?2 WHERE id = ?1",
            params![id, covered_chars],
        )?;
        Ok(())
    }

    pub fn save_extraction(&self, id: &str, extraction_json: &str) -> Result<()> {
        self.conn.execute("SAVEPOINT save_extraction", [])?;
        let result = (|| -> Result<()> {
            self.conn.execute(
                // coverage_chars resets to NULL: a re-extraction that
                // covered LESS (a window failing this time) must not inherit
                // the previous run's reach. The caller that knows the new
                // coverage writes it immediately after.
                "UPDATE documents
                 SET extraction_json = ?2, status = 'extracted',
                     coverage_chars = NULL,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                params![id, extraction_json],
            )?;
            self.conn.execute(
                "DELETE FROM outbox WHERE document_id = ?1 AND status = 'pending'",
                params![id],
            )?;
            self.conn.execute(
                "INSERT INTO outbox (document_id, payload) VALUES (?1, ?2)",
                params![id, extraction_json],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute("RELEASE save_extraction", [])?;
                Ok(())
            }
            Err(err) => {
                let _ = self.conn.execute("ROLLBACK TO save_extraction", []);
                let _ = self.conn.execute("RELEASE save_extraction", []);
                Err(err)
            }
        }
    }

    pub fn mark_failed(&self, id: &str, error: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE documents
             SET status = 'failed', error = ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![id, error],
        )?;
        Ok(())
    }

    /// Marks a document synced and records the id the SERVER assigned it.
    /// `remote_document_id` is None only when the response body could not be
    /// parsed; an existing id is then kept rather than nulled, because losing
    /// it costs the ability to delete the document server-side.
    pub fn mark_synced(&self, document_id: &str, remote_document_id: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE documents
             SET status = 'synced',
                 remote_document_id = COALESCE(?2, remote_document_id),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![document_id, remote_document_id],
        )?;
        Ok(())
    }

    /// The server-side id of a locally-stored document, when one push has
    /// been accepted. None means the document never reached the server, so
    /// deleting it locally is the whole job.
    pub fn remote_document_id(&self, document_id: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT remote_document_id FROM documents WHERE id = ?1")?;
        let mut rows = stmt.query(params![document_id])?;
        match rows.next()? {
            Some(row) => Ok(row.get(0)?),
            None => Ok(None),
        }
    }

    /// Drops every server-derived row and the sync bookkeeping that only
    /// makes sense for the account that produced it. Called on unpair: the
    /// cached documents, deadlines and tasks are another account's personal
    /// data, and a retained `sync_cursor` replayed against a DIFFERENT
    /// account silently hides every row of theirs older than that position.
    pub fn clear_remote_cache(&self) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM remote_documents", [])?;
        tx.execute("DELETE FROM remote_deadlines", [])?;
        tx.execute("DELETE FROM remote_tasks", [])?;
        tx.execute(
            "DELETE FROM settings WHERE key IN ('sync_cursor', 'device_name')",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Deletes the document and its local side-effects (pending outbox
    /// entries, suggested tasks). The schema also declares ON DELETE
    /// CASCADE, but the explicit deletes keep this correct for database
    /// files written before the foreign_keys pragma existed — a deleted
    /// document must never sync afterwards.
    pub fn delete_document(&self, id: &str) -> Result<bool> {
        // One transaction: a failure partway through used to leave the
        // document row alive with its outbox entry already gone — a document
        // that can never sync and never stops showing as pending.
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM outbox WHERE document_id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM suggested_tasks WHERE document_id = ?1",
            params![id],
        )?;
        let deleted = tx.execute("DELETE FROM documents WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(deleted > 0)
    }

    pub fn pending_outbox(&self, limit: i64) -> Result<Vec<OutboxEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, document_id, payload, attempts FROM outbox
             WHERE status = 'pending'
               AND (next_try_at IS NULL
                    OR next_try_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ORDER BY id LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(OutboxEntry {
                id: row.get(0)?,
                document_id: row.get(1)?,
                payload: row.get(2)?,
                attempts: row.get(3)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn outbox_mark_done(&self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE outbox SET status = 'done' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Re-queues a parked document's failed outbox entries for retry: status
    /// back to pending, attempts reset, backoff cleared — plus the document
    /// row back to pending so the UI stops showing it failed. Without this,
    /// a parked doc (5× transient, or 1× 4xx) could never reach the server:
    /// there was no API to un-park it. Returns the number of entries revived.
    pub fn requeue_failed_document(&self, document_id: &str) -> Result<usize> {
        let entries = self.conn.execute(
            "UPDATE outbox SET status = 'pending', attempts = 0, next_try_at = NULL
             WHERE document_id = ?1 AND status = 'failed'",
            params![document_id],
        )?;
        if entries > 0 {
            self.conn.execute(
                "UPDATE documents SET status = 'pending', error = NULL,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                params![document_id],
            )?;
        }
        Ok(entries)
    }

    /// Re-queues for retry with a growing attempt counter and an
    /// exponential backoff (`next_try_at`, 60s·2^attempts, capped at 64x —
    /// `pending_outbox` skips not-yet-due entries). After MAX_ATTEMPTS the
    /// entry is parked as 'failed' (a diagnostics screen can re-queue it).
    pub fn outbox_mark_retry(&self, id: i64, max_attempts: i64) -> Result<bool> {
        let updated = self.conn.execute(
            "UPDATE outbox
             SET attempts = attempts + 1,
                 next_try_at = strftime(
                     '%Y-%m-%dT%H:%M:%fZ', 'now',
                     '+' || CAST(
                         60 * (1 << min(attempts + 1, 6)) AS TEXT
                     ) || ' seconds'),
                 status = CASE WHEN attempts + 1 >= ?2 THEN 'failed' ELSE 'pending' END
             WHERE id = ?1",
            params![id, max_attempts],
        )?;
        Ok(updated > 0)
    }

    /// Records tasks the backend suggested from a document's obligations —
    /// they are NOT created server-side until the user confirms them.
    pub fn insert_suggested_tasks(
        &self,
        document_id: &str,
        remote_document_id: &str,
        titles: &[String],
    ) -> Result<()> {
        if titles.is_empty() {
            return Ok(());
        }
        for title in titles {
            self.conn.execute(
                "INSERT INTO suggested_tasks (document_id, remote_document_id, title)
                 VALUES (?1, ?2, ?3)",
                params![document_id, remote_document_id, title],
            )?;
        }
        Ok(())
    }

    /// Pending + confirmed suggestions (dismissed ones are hidden from the UI).
    pub fn list_suggested_tasks(&self) -> Result<Vec<SuggestedTask>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, document_id, remote_document_id, title, status, created_at
             FROM suggested_tasks
             WHERE status != 'dismissed'
             ORDER BY id",
        )?;
        let rows = stmt.query_map([], query_suggested_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Atomically claims a pending suggested task (marks it 'confirmed').
    /// Returns None when the row does not exist or is no longer pending, so a
    /// concurrent double-confirm can never create a task twice. On a remote
    /// failure the caller reverts it with `revert_suggested_task`.
    pub fn claim_suggested_task(&self, id: i64) -> Result<Option<SuggestedTask>> {
        let updated = self.conn.execute(
            "UPDATE suggested_tasks SET status = 'confirmed'
             WHERE id = ?1 AND status = 'pending'",
            params![id],
        )?;
        if updated == 0 {
            return Ok(None);
        }
        self.get_suggested_task(id)
    }

    /// Returns the row to pending after a failed remote creation.
    pub fn revert_suggested_task(&self, id: i64) -> Result<bool> {
        let updated = self.conn.execute(
            "UPDATE suggested_tasks SET status = 'pending'
             WHERE id = ?1 AND status = 'confirmed'",
            params![id],
        )?;
        Ok(updated > 0)
    }

    pub fn dismiss_suggested_task(&self, id: i64) -> Result<bool> {
        let updated = self.conn.execute(
            "UPDATE suggested_tasks SET status = 'dismissed'
             WHERE id = ?1 AND status = 'pending'",
            params![id],
        )?;
        Ok(updated > 0)
    }

    /// Deletes a confirmed suggestion after its remote task was created:
    /// confirmed rows have served their purpose and would otherwise
    /// accumulate forever (list hides only dismissed ones).
    pub fn consume_suggested_task(&self, id: i64) -> Result<bool> {
        let deleted = self.conn.execute(
            "DELETE FROM suggested_tasks WHERE id = ?1 AND status = 'confirmed'",
            params![id],
        )?;
        Ok(deleted > 0)
    }

    /// Resets suggestions stranded in 'confirmed' back to 'pending'. A crash
    /// between claim and the remote POST leaves a row that is neither
    /// retryable (claim/dismiss require pending) nor consumed — call once at
    /// startup. Returns the number of rows revived.
    pub fn reset_confirmed_suggestions(&self) -> Result<usize> {
        let revived = self.conn.execute(
            "UPDATE suggested_tasks SET status = 'pending' WHERE status = 'confirmed'",
            [],
        )?;
        Ok(revived)
    }

    /// Upserts all remote collections in a single transaction and advances
    /// the stored cursor. Returns the counts of upserted rows.
    pub fn apply_updates(&self, updates: &crate::sync::RemoteUpdates) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;

        // Server-declared resync (stale cursor past tombstone retention):
        // the local snapshot may hold rows the server already forgot, so
        // drop the whole cache before applying the fresh full pull — in the
        // same transaction, or a crash resurrects ghosts.
        if updates.resync {
            tx.execute("DELETE FROM remote_documents", [])?;
            tx.execute("DELETE FROM remote_deadlines", [])?;
            tx.execute("DELETE FROM remote_tasks", [])?;
        }

        for doc in &updates.documents {
            let payload = serde_json::to_string(doc).map_err(CoreError::Serialization)?;
            tx.execute(
                "INSERT INTO remote_documents (id, payload) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
                params![doc.id, payload],
            )?;
        }

        for dl in &updates.deadlines {
            let payload = serde_json::to_string(dl).map_err(CoreError::Serialization)?;
            tx.execute(
                "INSERT INTO remote_deadlines (id, payload) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
                params![dl.id, payload],
            )?;
        }

        for task in &updates.tasks {
            let payload = serde_json::to_string(task).map_err(CoreError::Serialization)?;
            tx.execute(
                "INSERT INTO remote_tasks (id, payload) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
                params![task.id, payload],
            )?;
        }

        // Server-side deletions (tombstones): drop the local rows in the
        // same transaction — a crash between upserts and deletes must not
        // resurrect deleted rows on the next pull.
        for id in &updates.deleted.documents {
            tx.execute("DELETE FROM remote_documents WHERE id = ?1", params![id])?;
        }
        for id in &updates.deleted.deadlines {
            tx.execute("DELETE FROM remote_deadlines WHERE id = ?1", params![id])?;
        }
        for id in &updates.deleted.tasks {
            tx.execute("DELETE FROM remote_tasks WHERE id = ?1", params![id])?;
        }

        // Backfill the server id for documents pushed before the client
        // started recording it. Without this, `remote_document_id` is NULL
        // forever on those rows and deleting one removes only the local copy
        // — the very failure the column was added to close, left open for
        // every document that already existed. The join key is the source
        // hash, which both sides derived from the same bytes; only NULL ids
        // are filled, so a recorded id is never overwritten by a stale page.
        for doc in &updates.documents {
            let Some(hash) = doc.source_hash.as_deref() else {
                continue;
            };
            tx.execute(
                "UPDATE documents SET remote_document_id = ?1
                 WHERE source_hash = ?2 AND remote_document_id IS NULL",
                params![doc.id, hash],
            )?;
        }

        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('sync_cursor', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![updates.next_cursor],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// Returns all cached remote data (merged snapshot).
    pub fn remote_data(&self) -> Result<crate::sync::RemoteData> {
        let documents = self.query_remote("remote_documents")?;
        let deadlines = self.query_remote("remote_deadlines")?;
        let tasks = self.query_remote("remote_tasks")?;
        Ok(crate::sync::RemoteData {
            documents,
            deadlines,
            tasks,
        })
    }

    /// Gets a setting value by key.
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    /// Sets a setting value.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Removes a setting (e.g. a poisoned sync cursor the server rejects —
    /// the next pull restarts as a full pull instead of wedging on 400s).
    pub fn clear_setting(&self, key: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Reads one cached remote table. A single corrupt payload skips that
    /// row (stderr note) instead of failing the whole snapshot — one bad
    /// cache entry must not blank the Documents/Calendar/Tasks screens.
    fn query_remote<T: serde::de::DeserializeOwned>(&self, table: &str) -> Result<Vec<T>> {
        let mut stmt = self.conn.prepare(&format!("SELECT payload FROM {table}"))?;
        let rows = stmt.query_map([], |row| {
            let payload: String = row.get(0)?;
            Ok(payload)
        })?;
        let mut out = Vec::new();
        for payload in rows {
            let payload = payload?;
            match serde_json::from_str(&payload) {
                Ok(value) => out.push(value),
                Err(e) => eprintln!("dokumente-core: skipping corrupt cached row in {table}: {e}"),
            }
        }
        Ok(out)
    }

    /// Test-only raw SQL escape hatch (planting corrupt cache rows, pragma
    /// probes). Zero release surface: cfg(test)-gated.
    #[cfg(test)]
    pub(crate) fn exec_for_test(&self, sql: &str) -> Result<usize> {
        Ok(self.conn.execute(sql, [])?)
    }

    fn get_suggested_task(&self, id: i64) -> Result<Option<SuggestedTask>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, document_id, remote_document_id, title, status, created_at
             FROM suggested_tasks WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(query_suggested_row(row)?)),
            None => Ok(None),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RemoteData {
    pub documents: Vec<crate::sync::RemoteDocument>,
    pub deadlines: Vec<crate::sync::RemoteDeadline>,
    pub tasks: Vec<crate::sync::RemoteTask>,
}

fn query_suggested_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SuggestedTask> {
    Ok(SuggestedTask {
        id: row.get(0)?,
        document_id: row.get(1)?,
        remote_document_id: row.get(2)?,
        title: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn map_document_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentRow> {
    Ok(DocumentRow {
        id: row.get(0)?,
        source_hash: row.get(1)?,
        file_name: row.get(2)?,
        kind: row.get(3)?,
        raw_text: row.get(4)?,
        extraction_json: row.get(5)?,
        status: row.get(6)?,
        error: row.get(7)?,
        created_at: row.get(8)?,
        coverage_truncated: row.get(9)?,
    })
}
