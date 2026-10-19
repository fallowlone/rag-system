use crate::crypto::InMemoryProvider;
use crate::store::Store;

fn open() -> Store {
    let provider = InMemoryProvider::new();
    Store::open_in_memory(&provider).unwrap()
}

fn sample_extraction() -> String {
    format!(
        r#"{{"sourceHash":"{}","category":"jobcenter","facts":[],"deadlines":[],"obligations":[],"addresses":[],"amounts":[],"tags":[],"isActive":true}}"#,
        "a".repeat(64)
    )
}

#[test]
fn insert_and_fetch_document() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", Some("bescheid.pdf"), "pdf", "text", None)
        .unwrap();
    let doc = store.get_document("doc-1").unwrap().unwrap();
    assert_eq!(doc.raw_text, "text");
    assert_eq!(doc.status, "pending");
    assert!(store.has_source_hash("hash-1").unwrap());
    assert!(!store.has_source_hash("hash-2").unwrap());
}

#[test]
fn save_extraction_queues_outbox_and_updates_status() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .save_extraction("doc-1", &sample_extraction())
        .unwrap();

    let doc = store.get_document("doc-1").unwrap().unwrap();
    assert_eq!(doc.status, "extracted");
    assert!(doc.extraction_json.is_some());

    let pending = store.pending_outbox(10).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].document_id, "doc-1");
    assert_eq!(pending[0].attempts, 0);
}

#[test]
fn outbox_retry_parks_after_max_attempts() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .save_extraction("doc-1", &sample_extraction())
        .unwrap();

    // max_attempts = 3: two retries stay pending, the third parks it.
    assert!(store.outbox_mark_retry(1, 3).unwrap());
    assert!(store.outbox_mark_retry(1, 3).unwrap());
    assert!(store.outbox_mark_retry(1, 3).unwrap());
    assert_eq!(store.pending_outbox(10).unwrap().len(), 0);
}

#[test]
fn requeue_failed_document_revives_parked_entries() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .save_extraction("doc-1", &sample_extraction())
        .unwrap();
    // Park it: two retries then the parking third.
    assert!(store.outbox_mark_retry(1, 2).unwrap());
    assert!(store.outbox_mark_retry(1, 2).unwrap());
    store
        .mark_failed("doc-1", "server error (HTTP 500)")
        .unwrap();
    assert_eq!(store.pending_outbox(10).unwrap().len(), 0);

    // Requeue revives the entry AND the document row.
    assert_eq!(store.requeue_failed_document("doc-1").unwrap(), 1);
    let pending = store.pending_outbox(10).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].attempts, 0);
    assert_eq!(
        store.get_document("doc-1").unwrap().unwrap().status,
        "pending"
    );

    // Nothing parked → no-op, zero revived.
    assert_eq!(store.requeue_failed_document("doc-1").unwrap(), 0);
}

#[test]
fn reset_confirmed_suggestions_revives_crash_wedge() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .insert_suggested_tasks("doc-1", "remote-doc-1", &["Task A".to_string()])
        .unwrap();
    let id = store.list_suggested_tasks().unwrap()[0].id;
    // Simulate the crash: claimed (confirmed) but the remote POST never ran.
    assert!(store.claim_suggested_task(id).unwrap().is_some());

    assert_eq!(store.reset_confirmed_suggestions().unwrap(), 1);
    // Retryable again: claim works, and the row is back in the list.
    assert!(store.claim_suggested_task(id).unwrap().is_some());
    assert_eq!(store.list_suggested_tasks().unwrap()[0].status, "confirmed");
}

#[test]
fn consume_suggested_task_deletes_only_confirmed_rows() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .insert_suggested_tasks(
            "doc-1",
            "remote-doc-1",
            &["Task A".to_string(), "Task B".to_string()],
        )
        .unwrap();
    let tasks = store.list_suggested_tasks().unwrap();
    // Pending rows are never consumed (only confirmed ones after success).
    assert!(!store.consume_suggested_task(tasks[0].id).unwrap());
    assert!(store.claim_suggested_task(tasks[0].id).unwrap().is_some());
    assert!(store.consume_suggested_task(tasks[0].id).unwrap());
    let remaining = store.list_suggested_tasks().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].title, "Task B");
}

#[test]
fn mark_synced_and_delete() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .save_extraction("doc-1", &sample_extraction())
        .unwrap();
    store.mark_synced("doc-1", Some("srv-1")).unwrap();
    assert_eq!(
        store.get_document("doc-1").unwrap().unwrap().status,
        "synced"
    );

    // Deleting the document cascades the outbox entry.
    assert!(store.delete_document("doc-1").unwrap());
    assert!(store.get_document("doc-1").unwrap().is_none());
    assert!(store.pending_outbox(10).unwrap().is_empty());
    assert!(!store.delete_document("doc-1").unwrap());
}

#[test]
fn file_is_encrypted_without_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let provider = InMemoryProvider::new();
    {
        let store = Store::open(&path, &provider).unwrap();
        store
            .insert_document("doc-1", "hash-1", None, "pdf", "secret text", None)
            .unwrap();
    }

    // The raw file must not contain the plaintext.
    let bytes = std::fs::read(&path).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("secret text"));

    // A wrong key must fail verification.
    assert!(!Store::verify_key(
        &path,
        "wrong-key-wrong-key-wrong-key-wrong"
    ));
    // The right key must pass.
    assert!(Store::verify_key(&path, crate::crypto::TEST_DB_KEY));
}

#[test]
fn duplicate_source_hash_rejected() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    let err = store
        .insert_document("doc-2", "hash-1", None, "pdf", "text2", None)
        .unwrap_err();
    match err {
        crate::error::CoreError::Store(rusqlite::Error::SqliteFailure(ffi, _)) => {
            assert_eq!(ffi.extended_code & 0xff, 19); // SQLITE_CONSTRAINT
        }
        other => panic!("expected constraint violation, got {other:?}"),
    }
}

#[test]
fn suggested_tasks_lifecycle() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .insert_suggested_tasks(
            "doc-1",
            "remote-doc-1",
            &[
                "Nachweis einreichen".to_string(),
                "Antrag stellen".to_string(),
            ],
        )
        .unwrap();

    let pending = store.list_suggested_tasks().unwrap();
    assert_eq!(pending.len(), 2);
    assert_eq!(pending[0].title, "Nachweis einreichen");
    assert_eq!(pending[0].remote_document_id, "remote-doc-1");
    assert_eq!(pending[0].status, "pending");

    // Atomic claim prevents double-confirm
    let claimed = store.claim_suggested_task(pending[0].id).unwrap().unwrap();
    assert_eq!(claimed.status, "confirmed");
    assert!(store.claim_suggested_task(pending[0].id).unwrap().is_none());

    // Revert after a failed remote create
    assert!(store.revert_suggested_task(pending[0].id).unwrap());
    assert_eq!(store.list_suggested_tasks().unwrap()[0].status, "pending");

    // Dismiss the second
    assert!(store.dismiss_suggested_task(pending[1].id).unwrap());
    let remaining = store.list_suggested_tasks().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, pending[0].id);
}

#[test]
fn delete_document_cascades_suggested_tasks() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .insert_suggested_tasks("doc-1", "remote-1", &["Loslegen".to_string()])
        .unwrap();
    assert_eq!(store.list_suggested_tasks().unwrap().len(), 1);

    assert!(store.delete_document("doc-1").unwrap());
    assert!(store.list_suggested_tasks().unwrap().is_empty());
}

#[test]
fn file_backed_delete_removes_outbox_and_suggestions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let provider = InMemoryProvider::new();
    {
        let store = Store::open(&path, &provider).unwrap();
        store
            .insert_document("doc-1", "hash-1", Some("a.pdf"), "pdf", "text", None)
            .unwrap();
        store
            .save_extraction("doc-1", &sample_extraction())
            .unwrap();
        store
            .insert_suggested_tasks("doc-1", "remote-1", &["Los".to_string()])
            .unwrap();
        // A deleted document must never sync afterwards: no orphan outbox
        // payload, no orphan suggestions — via explicit cleanup as well as
        // the schema's ON DELETE CASCADE.
        assert!(store.delete_document("doc-1").unwrap());
        assert!(store.pending_outbox(10).unwrap().is_empty());
        assert!(store.list_suggested_tasks().unwrap().is_empty());
    }
    // Reopening the same file (fresh connection, pragma re-applied) shows
    // no orphans either.
    let store = Store::open(&path, &provider).unwrap();
    assert!(store.pending_outbox(10).unwrap().is_empty());
    assert!(store.list_suggested_tasks().unwrap().is_empty());
}

#[test]
fn reextraction_replaces_pending_outbox_entry() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .save_extraction("doc-1", &sample_extraction())
        .unwrap();
    // Second model run (e.g. after a model switch) must not queue a
    // duplicate POST for the same document.
    store
        .save_extraction("doc-1", &sample_extraction())
        .unwrap();
    let pending = store.pending_outbox(10).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].document_id, "doc-1");
}

#[test]
fn outbox_retry_defers_entry_via_backoff_without_losing_it() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    store
        .save_extraction("doc-1", &sample_extraction())
        .unwrap();

    // One transient failure: the entry leaves the due set (backed off via
    // next_try_at) but is NOT failed — the document keeps 'extracted'.
    assert!(store.outbox_mark_retry(1, 5).unwrap());
    assert!(store.pending_outbox(10).unwrap().is_empty());
    assert_eq!(
        store.get_document("doc-1").unwrap().unwrap().status,
        "extracted"
    );

    // Once the backoff expires the same entry is due again — deferred, not
    // lost and not duplicated.
    store
        .exec_for_test("UPDATE outbox SET next_try_at = '2000-01-01T00:00:00.000Z'")
        .unwrap();
    let pending = store.pending_outbox(10).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].attempts, 1);
}

#[test]
fn save_extraction_rolls_back_for_unknown_documents() {
    let store = open();
    // No documents row: the outbox INSERT violates the FK constraint, so
    // the SAVEPOINT must roll back instead of leaving partial state.
    let err = store
        .save_extraction("ghost-id", &sample_extraction())
        .unwrap_err();
    assert!(err.to_string().contains("FOREIGN KEY"));
    assert!(store.pending_outbox(10).unwrap().is_empty());
}

#[test]
fn remote_data_all_corrupt_returns_empty() {
    let store = open();
    store
        .exec_for_test("INSERT INTO remote_documents (id, payload) VALUES ('a', 'xx'), ('b', '{{')")
        .unwrap();
    let data = store.remote_data().unwrap();
    assert!(data.documents.is_empty());
    assert!(data.deadlines.is_empty());
    assert!(data.tasks.is_empty());
}

#[test]
fn remote_data_skips_corrupt_cached_row() {
    use crate::sync::{RemoteDocument, RemoteUpdates};
    let store = open();
    let updates = RemoteUpdates {
        next_cursor: "cursor-1".to_string(),
        documents: vec![RemoteDocument {
            id: "doc-1".to_string(),
            source_hash: None,
            file_name: Some("a.pdf".to_string()),
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
    };
    store.apply_updates(&updates).unwrap();
    store
        .exec_for_test("INSERT INTO remote_documents (id, payload) VALUES ('bad', 'not-json{{')")
        .unwrap();

    // One corrupt cache row must not brick the whole snapshot.
    let data = store.remote_data().unwrap();
    assert_eq!(data.documents.len(), 1);
    assert_eq!(data.documents[0].file_name.as_deref(), Some("a.pdf"));
}

#[test]
fn apply_updates_drops_tombstoned_rows() {
    use crate::sync::{
        RemoteDeadline, RemoteDeletedIds, RemoteDocument, RemoteTask, RemoteUpdates,
    };
    let store = open();
    // Seed one row per collection.
    let seed = RemoteUpdates {
        next_cursor: "cursor-1".to_string(),
        documents: vec![RemoteDocument {
            id: "doc-1".to_string(),
            source_hash: None,
            file_name: None,
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
        deadlines: vec![RemoteDeadline {
            id: "dl-1".to_string(),
            label: "Frist".to_string(),
            deadline_date: "2026-09-01".to_string(),
            source_type: None,
            source_id: None,
            completed_at: None,
        }],
        tasks: vec![RemoteTask {
            id: "task-1".to_string(),
            title: "T".to_string(),
            description: None,
            due_date: None,
            status: "open".to_string(),
            priority: None,
            source_type: None,
            source_document_id: None,
            completed_at: None,
        }],
        deleted: Default::default(),
        has_more: false,
        resync: false,
    };
    store.apply_updates(&seed).unwrap();
    assert_eq!(store.remote_data().unwrap().documents.len(), 1);

    // Tombstone leg: upsert nothing, delete everything.
    let tombstones = RemoteUpdates {
        next_cursor: "cursor-2".to_string(),
        documents: vec![],
        deadlines: vec![],
        tasks: vec![],
        deleted: RemoteDeletedIds {
            documents: vec!["doc-1".to_string()],
            deadlines: vec!["dl-1".to_string()],
            tasks: vec!["task-1".to_string()],
        },
        has_more: false,
        resync: false,
    };
    store.apply_updates(&tombstones).unwrap();

    let data = store.remote_data().unwrap();
    assert!(data.documents.is_empty());
    assert!(data.deadlines.is_empty());
    assert!(data.tasks.is_empty());
    // Deleting unknown ids is a no-op, never an error (stale tombstones).
    store.apply_updates(&tombstones).unwrap();
}

#[test]
fn mark_synced_records_and_keeps_the_server_id() {
    let store = open();
    store
        .insert_document("doc-1", "hash-1", None, "pdf", "text", None)
        .unwrap();
    // Never pushed: nothing to delete server-side.
    assert_eq!(store.remote_document_id("doc-1").unwrap(), None);

    store.mark_synced("doc-1", Some("srv-1")).unwrap();
    assert_eq!(
        store.remote_document_id("doc-1").unwrap(),
        Some("srv-1".to_string())
    );

    // An unparseable ingest response must not null the id it cannot supply —
    // losing it costs the ability to delete the document server-side.
    store.mark_synced("doc-1", None).unwrap();
    assert_eq!(
        store.remote_document_id("doc-1").unwrap(),
        Some("srv-1".to_string())
    );

    // Unknown document ids read as None, never as an error.
    assert_eq!(store.remote_document_id("nope").unwrap(), None);
}

#[test]
fn clear_remote_cache_drops_snapshot_and_sync_bookkeeping() {
    use crate::sync::{RemoteDocument, RemoteUpdates};
    let store = open();
    let updates = RemoteUpdates {
        next_cursor: "c1".into(),
        documents: vec![RemoteDocument {
            id: "d-1".to_string(),
            source_hash: None,
            file_name: Some("a.pdf".to_string()),
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
    };
    store.apply_updates(&updates).unwrap();
    store.set_setting("device_name", "Old Mac").unwrap();
    assert_eq!(store.remote_data().unwrap().documents.len(), 1);
    assert_eq!(store.get_setting("sync_cursor").unwrap(), Some("c1".into()));

    store.clear_remote_cache().unwrap();

    // The previous account's rows are gone...
    let data = store.remote_data().unwrap();
    assert!(data.documents.is_empty());
    assert!(data.deadlines.is_empty());
    assert!(data.tasks.is_empty());
    // ...and so is the cursor, which replayed against a different account
    // hides every row of theirs older than that position.
    assert_eq!(store.get_setting("sync_cursor").unwrap(), None);
    assert_eq!(store.get_setting("device_name").unwrap(), None);

    // Idempotent: unpairing twice is not an error.
    store.clear_remote_cache().unwrap();
}

#[test]
fn apply_updates_backfills_the_server_id_by_source_hash() {
    use crate::sync::{RemoteDocument, RemoteUpdates};
    let store = open();
    let hash = "h".repeat(64);
    store
        .insert_document("doc-1", &hash, None, "pdf", "text", None)
        .unwrap();
    // Pushed before the client recorded server ids: synced, but unaddressable.
    store.mark_synced("doc-1", None).unwrap();
    assert_eq!(store.remote_document_id("doc-1").unwrap(), None);

    let page = |id: &str, source_hash: Option<&str>| RemoteUpdates {
        next_cursor: "c1".into(),
        documents: vec![RemoteDocument {
            id: id.to_string(),
            source_hash: source_hash.map(str::to_string),
            file_name: None,
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
    };

    store.apply_updates(&page("srv-1", Some(&hash))).unwrap();
    assert_eq!(
        store.remote_document_id("doc-1").unwrap(),
        Some("srv-1".to_string())
    );

    // A later page must never overwrite an id already recorded — only NULLs
    // are filled, so a stale or replayed page cannot repoint a document.
    store.apply_updates(&page("srv-WRONG", Some(&hash))).unwrap();
    assert_eq!(
        store.remote_document_id("doc-1").unwrap(),
        Some("srv-1".to_string())
    );
}

#[test]
fn apply_updates_backfill_tolerates_older_servers_and_unknown_hashes() {
    use crate::sync::{RemoteDocument, RemoteUpdates};
    let store = open();
    let hash = "a".repeat(64);
    store
        .insert_document("doc-1", &hash, None, "pdf", "text", None)
        .unwrap();

    let mut updates = RemoteUpdates {
        next_cursor: "c1".into(),
        documents: vec![
            // Older server: no sourceHash on the wire at all.
            RemoteDocument {
                id: "srv-old".to_string(),
                source_hash: None,
                file_name: None,
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
            },
            // A document this device does not have locally.
            RemoteDocument {
                id: "srv-other".to_string(),
                source_hash: Some("b".repeat(64)),
                file_name: None,
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
            },
        ],
        deadlines: vec![],
        tasks: vec![],
        deleted: Default::default(),
        has_more: false,
        resync: false,
    };
    store.apply_updates(&updates).unwrap();
    assert_eq!(store.remote_document_id("doc-1").unwrap(), None);

    // And the hash is matched exactly — not by position in the page.
    updates.documents[1].source_hash = Some(hash.clone());
    store.apply_updates(&updates).unwrap();
    assert_eq!(
        store.remote_document_id("doc-1").unwrap(),
        Some("srv-other".to_string())
    );
}

#[test]
fn coverage_truncated_marks_documents_longer_than_one_pass() {
    use crate::llm::MAX_PROMPT_DOC_CHARS;
    let store = open();
    // Umlauts on purpose: the flag must count CHARACTERS like the prompt cap
    // does. A byte-length comparison would mark this short document
    // truncated, since every "ä" costs two bytes.
    let short = "ä".repeat(MAX_PROMPT_DOC_CHARS - 1);
    let long = "ä".repeat(MAX_PROMPT_DOC_CHARS + 1);
    store
        .insert_document("doc-short", &"a".repeat(64), None, "pdf", &short, None)
        .unwrap();
    store
        .insert_document("doc-long", &"b".repeat(64), None, "pdf", &long, None)
        .unwrap();

    assert!(!store.get_document("doc-short").unwrap().unwrap().coverage_truncated);
    assert!(store.get_document("doc-long").unwrap().unwrap().coverage_truncated);

    // And it travels through the list view the UI actually reads.
    let rows = store.list_documents().unwrap();
    let long_row = rows.iter().find(|r| r.id == "doc-long").unwrap();
    assert!(long_row.coverage_truncated);
}

#[test]
fn recorded_coverage_overrides_the_length_derivation() {
    use crate::llm::MAX_PROMPT_DOC_CHARS;
    let store = open();
    let long = "x".repeat(MAX_PROMPT_DOC_CHARS * 3);
    store
        .insert_document("doc-1", &"a".repeat(64), None, "pdf", &long, None)
        .unwrap();

    // Not yet extracted: the fallback assumes one pass and discloses.
    assert!(store.get_document("doc-1").unwrap().unwrap().coverage_truncated);

    // Multi-pass read the whole thing — no longer partial.
    store
        .save_extraction_with_coverage("doc-1", &sample_extraction(), long.chars().count() as i64)
        .unwrap();
    assert!(!store.get_document("doc-1").unwrap().unwrap().coverage_truncated);

    // A later run where a window failed covers less, and must say so even
    // though the document length has not changed.
    store
        .save_extraction_with_coverage("doc-1", &sample_extraction(), 30_000)
        .unwrap();
    assert!(store.get_document("doc-1").unwrap().unwrap().coverage_truncated);
}

#[test]
fn re_extraction_never_inherits_the_previous_runs_reach() {
    use crate::llm::MAX_PROMPT_DOC_CHARS;
    let store = open();
    let long = "x".repeat(MAX_PROMPT_DOC_CHARS * 2);
    store
        .insert_document("doc-1", &"a".repeat(64), None, "pdf", &long, None)
        .unwrap();
    store
        .save_extraction_with_coverage("doc-1", &sample_extraction(), long.chars().count() as i64)
        .unwrap();
    assert!(!store.get_document("doc-1").unwrap().unwrap().coverage_truncated);

    // A plain re-extraction knows nothing about coverage: it must fall back
    // to the conservative derivation, not keep claiming the old reach.
    store.save_extraction("doc-1", &sample_extraction()).unwrap();
    assert!(store.get_document("doc-1").unwrap().unwrap().coverage_truncated);
}

#[test]
fn replacing_the_raw_text_clears_the_coverage_it_described() {
    use crate::llm::MAX_PROMPT_DOC_CHARS;
    let store = open();
    let long = "x".repeat(MAX_PROMPT_DOC_CHARS * 2);
    store
        .insert_document("doc-1", &"a".repeat(64), None, "pdf", "kurz", None)
        .unwrap();
    store
        .save_extraction_with_coverage("doc-1", &sample_extraction(), 4)
        .unwrap();

    // A server scan replaces the text wholesale — the old reach says nothing
    // about the new content.
    store.update_raw_text("doc-1", &long).unwrap();
    assert!(store.get_document("doc-1").unwrap().unwrap().coverage_truncated);
}
