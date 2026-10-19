// Papierkram — macOS companion app for the rag-lawyer-bot.
//
// Thin IPC layer only: all logic lives in dokumente-core.
// Concurrency rules:
// - EVERY command doing IO/network/inference is async + spawn_blocking;
//   synchronous commands would run on the main thread and freeze the UI.
// - The llama.cpp extractor is !Send, so it lives permanently on a dedicated
//   actor thread fed by a channel (never moved between threads).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use dokumente_core::crypto::{KeychainProvider, KeyProvider, TOKEN_ACCOUNT};
use dokumente_core::error::CoreError;
use dokumente_core::llm::model_manager::{
    DownloadOutcome, HttpDownload, ModelManager, ModelSpec, QWEN3_4B_Q4, QWEN3_8B_Q4,
};
use dokumente_core::store::{DocumentRow, Store};
use dokumente_core::sync::{
    HttpTransport, PairingProposal, RemoteData, RemoteHint, SyncClient, SyncReport,
    SETTING_DEVICE_NAME, SETTING_SYNC_UPLOAD,
};
use dokumente_core::translate::{
    self, TRANSLATE_BASE_URL, TRANSLATE_REPO_REV,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Model downloads in flight right now, by spec name. Two concurrent
/// `download_model` runs share one tmp path (`.{name}.download`) and would
/// interleave bytes into it — both hash-fail safely, but only after wasting
/// gigabytes. First claimant wins; the loser gets a clear error instead.
static DOWNLOADS_IN_FLIGHT: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

/// 8B-class models need roughly this much total RAM (weights ~5 GB + Metal
/// buffers + headroom for the OS). Below it, refuse before downloading.
const MIN_RAM_FOR_LARGE_MODEL_BYTES: u64 = 12 * 1024 * 1024 * 1024;
/// Specs above this size count as "large" for the RAM gate.
const LARGE_MODEL_BYTES: u64 = 4_000_000_000;

fn try_claim_download(name: &str) -> bool {
    DOWNLOADS_IN_FLIGHT
        .lock()
        .map(|mut set| set.insert(name.to_string()))
        .unwrap_or(false)
}

fn release_download(name: &str) {
    if let Ok(mut set) = DOWNLOADS_IN_FLIGHT.lock() {
        set.remove(name);
    }
}

/// Llama.cpp surfaces OOM (Metal allocation, mmap, ggml alloc) as plain
/// strings — map the recognizable shapes to actionable guidance instead of
/// a generic extraction failure.
fn is_oom_shaped(message: &str) -> bool {
    let lower = message.to_lowercase();
    ["memory", "mmap", "alloc"].iter().any(|k| lower.contains(k))
}

/// Default backend for development; overridable from the UI (Settings).
const DEFAULT_BASE_URL: &str = "http://127.0.0.1:3000";

/// Cached ONNX translators by language pair, each behind its own lock so
/// loading/translating one pair never stalls another (see field docs).
type TranslatorCache = Arc<Mutex<HashMap<String, Arc<Mutex<Option<translate::Translator>>>>>>;

struct AppState {
    /// rusqlite's Connection is Send but not Sync — shared behind a Mutex,
    /// Arc so commands can move clones into blocking tasks ('static).
    store: Arc<Mutex<Store>>,
    keys: Arc<KeychainProvider>,
    base_url: Arc<Mutex<String>>,
    /// Loaded ONNX translators by pair ("de-en"), cached for the app
    /// lifetime — session build takes seconds, translate takes <1s. Each
    /// pair has its own lock behind the map so loading/translating one pair
    /// never stalls another; the map lock itself is only held for lookup.
    translators: TranslatorCache,
    /// Path of the store file quarantined at startup, if any (the previous
    /// DB could not be decrypted with the current keychain key — the app
    /// started fresh and the old file awaits manual recovery). Surfaced via
    /// `quarantine_status` so the UI can banner the data loss instead of
    /// showing a silently empty library. Set once at setup, never mutated.
    quarantine: Option<PathBuf>,
    /// Sender to the dedicated extractor thread (llama builds only).
    #[cfg(feature = "llama")]
    extract_tx: std::sync::mpsc::Sender<ExtractJob>,
}

#[cfg(feature = "llama")]
struct ExtractJob {
    document_id: String,
    source_hash: String,
    raw_text: String,
    small: bool,
    /// The extractor thread writes the result itself, so a caller that has
    /// stopped waiting cannot throw the work away. See `extract_document`.
    store: Arc<Mutex<Store>>,
    /// (extraction JSON, characters the run actually read). Coverage travels
    /// with the result because only the extractor knows it — a long document
    /// is read in bounded windows and one may fail mid-way.
    respond: tokio::sync::oneshot::Sender<std::result::Result<(String, i64), String>>,
}

/// Documents with an extraction queued or running.
///
/// `extract_document` gives up waiting after EXTRACT_TIMEOUT_SECS while the
/// thread keeps going, so without this a user who pressed "Analysieren" again
/// after a timeout queued a SECOND full inference behind the first — on the
/// slow machine that timed out in the first place, and A2 multi-pass made
/// those runs up to four times longer.
static EXTRACTIONS_IN_FLIGHT: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

fn try_claim_extraction(document_id: &str) -> bool {
    EXTRACTIONS_IN_FLIGHT
        .lock()
        .map(|mut set| set.insert(document_id.to_string()))
        .unwrap_or(false)
}

fn release_extraction(document_id: &str) {
    if let Ok(mut set) = EXTRACTIONS_IN_FLIGHT.lock() {
        set.remove(document_id);
    }
}

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_spec(small: bool) -> &'static ModelSpec {
    if small {
        &QWEN3_4B_Q4
    } else {
        &QWEN3_8B_Q4
    }
}

/// Setting key for the user's model-size choice ("1" = small 4B variant).
/// Written by `download_model`, read by `model_status` (when the caller
/// passes no explicit flag) and `extract_document`.
const SETTING_MODEL_SMALL: &str = "model_small";

/// Setting key for the opt-in server-side image scan ("1" = enabled).
/// Default OFF: raw document bytes must never leave the device unless the
/// user explicitly allows it. Read by `scan_image` (hard gate) and the UI
/// (toggle state + extract fallback).
const SETTING_SERVER_SCAN: &str = "server_scan_enabled";

/// The persisted model-size choice; false (8B) when never chosen or when
/// the store is momentarily unavailable — preserving current behavior.
fn stored_model_small(state: &AppState) -> bool {
    state
        .store
        .lock()
        .ok()
        .and_then(|store| store.get_setting(SETTING_MODEL_SMALL).ok().flatten())
        .is_some_and(|v| v == "1")
}

/// Serializes a document row for the React UI. Field names must stay in
/// sync with the `DocumentRow` interface in `apps/macos/ui/src/types.ts`
/// (snake_case, full `raw_text`/`extraction_json` — the detail modal needs
/// them; omitting them crashes DocumentsPage on `.slice()` of `undefined`).
fn row_to_json(row: &DocumentRow) -> serde_json::Value {
    serde_json::json!({
        "id": row.id,
        "source_hash": row.source_hash,
        "file_name": row.file_name,
        "kind": row.kind,
        "raw_text": row.raw_text,
        "extraction_json": row.extraction_json,
        "status": row.status,
        "error": row.error,
        "created_at": row.created_at,
        // Derived, not stored — see Store::DocumentRow. The UI banners it so
        // a partially-analysed document never reads as fully analysed.
        "coverage_truncated": row.coverage_truncated,
    })
}

/// Dedicated thread owning the !Send llama.cpp extractor. Jobs arrive over a
/// channel; the requested model variant loads lazily and is swapped when a
/// job asks for the other downloaded variant — the model is never moved
/// across threads, satisfying llama.cpp's threading rules.
#[cfg(feature = "llama")]
fn spawn_extractor_thread(models_dir: PathBuf) -> std::sync::mpsc::Sender<ExtractJob> {
    let (tx, rx) = std::sync::mpsc::channel::<ExtractJob>();
    std::thread::Builder::new()
        .name("llama-extractor".into())
        .spawn(move || {
            let mut loaded: Option<(
                &'static ModelSpec,
                dokumente_core::llm::runner::LlamaExtractor,
            )> = None;
            let manager = ModelManager::new(&HttpDownload, models_dir);
            while let Ok(job) = rx.recv() {
                let result = (|| -> std::result::Result<(String, i64), String> {
                    let spec = model_spec(job.small);
                    let same = loaded
                        .as_ref()
                        .is_some_and(|(s, _)| std::ptr::eq(*s, spec));
                    if !same {
                        if !manager.is_downloaded(spec) {
                            return Err(format!(
                                "model not downloaded ({})",
                                spec.name
                            ));
                        }
                        let path = manager.model_path(spec);
                        // Drop the resident model FIRST. Assigning after the
                        // load kept both in memory for the duration of it, and
                        // the swap that matters is 8B -> 4B on a ≤16 GB Mac —
                        // i.e. exactly the machine that just hit OOM and was
                        // told by the message below to fetch the small model.
                        // 5 GB + 2.5 GB + KV was the peak on the machine least
                        // able to afford it.
                        loaded = None;
                        let extractor =
                            dokumente_core::llm::runner::LlamaExtractor::load(&path).map_err(
                                |e| {
                                    let message = e.to_string();
                                    if is_oom_shaped(&message) {
                                        format!(
                                            "{message} — likely out of memory: on a ≤16 GB Mac download the small model variant instead"
                                        )
                                    } else {
                                        message
                                    }
                                },
                            )?;
                        loaded = Some((spec, extractor));
                    }
                    let extractor = loaded
                        .as_ref()
                        .map(|(_, e)| e)
                        .ok_or_else(|| String::from("model not loaded"))?;
                    let outcome = dokumente_core::llm::Extractor::extract(
                        extractor,
                        &job.source_hash,
                        &job.raw_text,
                    )
                    .map_err(|e| e.to_string())?;
                    let json = outcome.extraction.to_json().map_err(|e| e.to_string())?;
                    if let Some(reason) = &outcome.window_error {
                        // Was an eprintln! inside the library; the shell owns
                        // logging now. Coverage still reaches the UI as a
                        // banner via coverage_chars.
                        eprintln!("[dokumente] {}: {reason}", job.document_id);
                    }
                    // Persist HERE, not in the command. The command stops
                    // waiting after EXTRACT_TIMEOUT_SECS; it used to be the
                    // only writer, so an extraction that finished one second
                    // later was simply discarded — minutes of local inference
                    // on the slowest machines, thrown away, and the document
                    // left pending for the user to retry into the same wall.
                    let covered = outcome.covered_chars as i64;
                    {
                        let store = job
                            .store
                            .lock()
                            .map_err(|_| "store lock poisoned".to_string())?;
                        store
                            .save_extraction_with_coverage(&job.document_id, &json, covered)
                            .map_err(|e| e.to_string())?;
                    }
                    Ok((json, covered))
                })();
                if let Err(err) = &result {
                    // Deterministic failures park the document with a reason
                    // instead of leaving it pending for a byte-identical
                    // retry. Same literal as CoreError::ExtractionFailed's
                    // Display impl — keep in sync with error.rs.
                    if err.contains("extraction failed for truncated:") {
                        if let Ok(store) = job.store.lock() {
                            let _ = store.mark_failed(&job.document_id, err);
                        }
                    }
                }
                release_extraction(&job.document_id);
                let _ = job.respond.send(result);
            }
        })
        .expect("failed to spawn extractor thread");
    tx
}

#[tauri::command]
async fn ingest_document(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let store = state.store.clone();
    // ingest_file locks the store only for the dup check and the insert —
    // the file read and Vision OCR (minutes) run unlocked, so other
    // commands never stall behind an ingest.
    tauri::async_runtime::spawn_blocking(move || {
        match dokumente_core::ingest_file(std::path::Path::new(&path), &store) {
            Ok(Some(row)) => {
                Ok(serde_json::json!({ "duplicate": false, "document": row_to_json(&row) }))
            }
            Ok(None) => Ok(serde_json::json!({ "duplicate": true, "document": null })),
            Err(err) => Err(err.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_folder_files(path: String) -> Result<serde_json::Value, String> {
    // Folder enumeration is plain fs IO — off the async runtime like every
    // other blocking command in this shell.
    tauri::async_runtime::spawn_blocking(move || {
        let scan = dokumente_core::list_folder_files(std::path::Path::new(&path))
            .map_err(|e| e.to_string())?;
        serde_json::to_value(&scan).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_documents(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        let rows = store.list_documents().map_err(|e| e.to_string())?;
        Ok(serde_json::Value::Array(rows.iter().map(row_to_json).collect()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs the local LLM extraction by handing the job to the dedicated
/// extractor thread (model load + inference happen there, off this runtime).
#[tauri::command]
async fn extract_document(
    document_id: String,
    #[cfg(feature = "llama")] state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "llama")]
    {
        let store = state.store.clone();
        let id_for_read = document_id.clone();
        let (source_hash, raw_text, small) = tauri::async_runtime::spawn_blocking(move || {
            let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
            let row = store
                .get_document(&id_for_read)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "document not found".to_string())?;
            let small = store
                .get_setting(SETTING_MODEL_SMALL)
                .ok()
                .flatten()
                .is_some_and(|v| v == "1");
            Ok::<_, String>((row.source_hash, row.raw_text, small))
        })
        .await
        .map_err(|e| e.to_string())??;

        // One extraction per document at a time. The wait below can expire
        // while the thread keeps working, and a user who retries after that
        // used to queue a second full inference behind the first.
        if !try_claim_extraction(&document_id) {
            return Err(
                "this document is already being analysed — the result appears when it finishes"
                    .to_string(),
            );
        }

        let (respond_tx, respond_rx) = tokio::sync::oneshot::channel();
        if let Err(err) = state.extract_tx.send(ExtractJob {
            document_id: document_id.clone(),
            source_hash,
            raw_text,
            small,
            store: state.store.clone(),
            respond: respond_tx,
        }) {
            // The claim is released by the thread on every path it reaches;
            // if the job never got there, release it here instead of leaking
            // the document id for the process lifetime.
            release_extraction(&document_id);
            let _ = err;
            return Err("extractor thread is gone".to_string());
        }

        // CPU-fallback inference is minutes-per-extraction and jobs are FIFO
        // on one extractor thread: bound the wait so one slow document can't
        // wedge the queue (and the UI spinner) forever. The thread keeps
        // working in the background — its result goes to the dropped
        // receiver and is ignored — so a later retry simply queues again.
        const EXTRACT_TIMEOUT_SECS: u64 = 600;
        // The wait is bounded so one slow document cannot wedge the UI
        // spinner, but it is ONLY a wait: the thread persists the result
        // itself, so a run that lands after this point is stored, not lost —
        // the document simply turns up analysed on the next refresh.
        let job_result = tokio::time::timeout(
            std::time::Duration::from_secs(EXTRACT_TIMEOUT_SECS),
            respond_rx,
        )
        .await
        .map_err(|_| {
            format!(
                "extraction is still running after {EXTRACT_TIMEOUT_SECS}s — it will finish in the background and the document updates itself; on a slow Mac try the small model variant"
            )
        })?
        .map_err(|_| "extractor dropped the job".to_string())?;
        // Both the save and the failure bookkeeping happen on the extractor
        // thread now — see spawn_extractor_thread. This only reports.
        let (_json, covered_chars) = job_result?;

        Ok(serde_json::json!({ "extracted": true, "coveredChars": covered_chars }))
    }
    #[cfg(not(feature = "llama"))]
    {
        let _ = document_id;
        let extractor = dokumente_core::llm::UnimplementedExtractor;
        match dokumente_core::llm::Extractor::extract(&extractor, "", "") {
            Ok(_) => unreachable!("UnimplementedExtractor never succeeds"),
            Err(err) => Err(err.to_string()),
        }
    }
}

/// Whether the chosen model file is present (fast size sanity check; full
/// SHA-256 verification runs once at download time, not per status call).
/// Without an explicit flag, reports the variant chosen at download time.
#[tauri::command]
async fn model_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    small: Option<bool>,
) -> Result<serde_json::Value, String> {
    let want_small = small.unwrap_or_else(|| stored_model_small(&state));
    tauri::async_runtime::spawn_blocking(move || {
        let dir = models_dir(&app)?;
        let manager = ModelManager::new(&HttpDownload, &dir);
        let spec = model_spec(want_small);
        Ok(serde_json::json!({
            "name": spec.name,
            "small": want_small,
            "downloaded": manager.is_downloaded(spec),
            "size_bytes": spec.size_bytes,
            "pinned": spec.sha256.is_some(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn download_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    small: Option<bool>,
    on_progress: tauri::ipc::Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let want_small = small.unwrap_or(false);
    let dir = models_dir(&app)?;
    let spec = model_spec(want_small);
    // Refuse a doomed 5 GB download up front instead of failing at load
    // time. Unknown RAM fails open (the machine might handle it).
    if spec.size_bytes > LARGE_MODEL_BYTES {
        if let Some(total) =
            dokumente_core::llm::model_manager::total_memory_bytes()
        {
            if total < MIN_RAM_FOR_LARGE_MODEL_BYTES {
                return Err("not enough RAM for the standard model on this Mac (needs ~12 GB total) — download the small variant instead".into());
            }
        }
    }
    if !try_claim_download(spec.name) {
        return Err("a download for this model is already in progress".into());
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let manager = ModelManager::new(&HttpDownload, &dir);
        manager.download_and_verify(spec, &mut |downloaded, total| {
            // Fire-and-forget: a dropped channel must not abort the download.
            let _ = on_progress.send(serde_json::json!({
                "downloaded": downloaded,
                "total": total,
            }));
        })
    })
    .await
    .map_err(|e| e.to_string());
    release_download(spec.name);
    let outcome = outcome?.map_err(|e| e.to_string())?;

    // Remember the choice only for a usable file, so extraction and status
    // follow the variant the user actually downloaded.
    if matches!(
        outcome,
        DownloadOutcome::Verified(_)
            | DownloadOutcome::UpstreamVerified { .. }
            | DownloadOutcome::Unpinned { .. }
    ) {
        if let Ok(store) = state.store.lock() {
            let _ = store.set_setting(SETTING_MODEL_SMALL, if want_small { "1" } else { "0" });
        }
    }

    match outcome {
        DownloadOutcome::Verified(path) => Ok(serde_json::json!({
            "status": "verified",
            "path": path.display().to_string(),
        })),
        DownloadOutcome::HashMismatch => Err("download failed: hash mismatch (file deleted)".into()),
        // No pin in code, but the bytes matched the digest the origin
        // published for them. Reported separately from bare TOFU so the
        // difference is visible rather than collapsed into "unpinned".
        DownloadOutcome::UpstreamVerified { path, sha256 } => Ok(serde_json::json!({
            "status": "upstream_verified",
            "path": path.display().to_string(),
            "sha256": sha256,
        })),
        DownloadOutcome::Unpinned { path, sha256 } => Ok(serde_json::json!({
            "status": "unpinned",
            "path": path.display().to_string(),
            // Surface the hash so it can be pinned in code before shipping.
            "sha256": sha256,
        })),
    }
}

fn resolve_base_url(state: &AppState, override_url: Option<String>) -> String {
    // SECURITY: the device token is sent as a Bearer header to this URL. A
    // tampered override must never be able to exfiltrate it to an arbitrary
    // scheme (file:, ws:, javascript:), AND a remote plain-HTTP origin must
    // not receive it at all — nothing in this repository terminates TLS, so
    // `http://` to anything but loopback puts a credential that grants full
    // access to /app/v1 on the wire in clear text. `base_url_allows_token`
    // owns that rule (and its tests) in dokumente-core.
    //
    // Falling back to the loopback default is deliberate: the request then
    // fails against a backend that is not there, which is a visible failure,
    // where sending the token anyway is an invisible one.
    let candidate = override_url.unwrap_or_else(|| {
        state
            .base_url
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
    });
    if dokumente_core::sync::base_url_allows_token(&candidate) {
        candidate
    } else {
        eprintln!(
            "[dokumente] refusing to send the device token to {candidate} — use https:// for a remote backend"
        );
        DEFAULT_BASE_URL.to_string()
    }
}

/// Reverse pairing, step 1: generate a DOK-###### code + proposal secret on
/// this device and register them server-side. The UI shows the code; the
/// user sends it to the Telegram bot. Returns the bare code, the display
/// form ("DOK-…"), the secret (kept in UI memory for the poll) and the TTL.
#[tauri::command]
async fn pair_propose(
    device_name: String,
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let base = resolve_base_url(&state, base_url);
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let proposal = PairingProposal::generate();
        client
            .propose_pairing(&proposal, &device_name)
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "code": proposal.code,
            "displayCode": proposal.display_code(),
            "secret": proposal.secret,
            "expiresIn": 60,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reverse pairing, step 2: single claim poll. On success the device token
/// is already in the keychain; the device name is persisted for the
/// "Paired as …" display.
#[tauri::command]
async fn pair_poll(
    code: String,
    secret: String,
    device_name: String,
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let base = resolve_base_url(&state, base_url);
    let store = state.store.clone();
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let proposal = PairingProposal { code, secret };
        let claimed = client
            .poll_pairing_claim(&proposal)
            .map_err(|e| e.to_string())?;
        if claimed {
            let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
            store
                .set_setting(SETTING_DEVICE_NAME, &device_name)
                .map_err(|e| e.to_string())?;
        }
        Ok(serde_json::json!({ "claimed": claimed }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Revokes the server session and wipes the local token.
#[tauri::command]
async fn unpair_device(
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let base = resolve_base_url(&state, base_url);
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    let store = state.store.clone();
    let keys = state.keys.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = client.unpair();
        // Everything under remote_* is the unpaired account's personal data,
        // and `sync_cursor` is a position in THEIR timeline: replayed after
        // pairing a different account it silently hides every row of theirs
        // older than that position. Both go with the token — so key off
        // whether the token is actually gone, not off a successful return:
        // `unpair` also wipes it when the server answers a non-2xx status,
        // and that path returns Err.
        let token_gone = keys
            .get(dokumente_core::crypto::TOKEN_ACCOUNT)
            .map(|t| t.is_none())
            .unwrap_or(false);
        if token_gone {
            let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
            store.clear_remote_cache().map_err(|e| e.to_string())?;
        }
        let unpaired = result.map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "unpaired": unpaired }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Public bot username for the "Open Telegram" deep link. Null when the
/// operator did not configure TELEGRAM_BOT_USERNAME — the UI then falls
/// back to copy-paste.
#[tauri::command]
async fn bot_username(
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let base = resolve_base_url(&state, base_url);
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let (status, response_body) = client
            .transport
            .get_json("/app/v1/meta", "")
            .map_err(|e| e.to_string())?;
        if status != 200 {
            return Err(format!("meta rejected (HTTP {status})"));
        }
        #[derive(serde::Deserialize)]
        struct MetaResponse {
            #[serde(rename = "botUsername", default)]
            bot_username: Option<String>,
        }
        let parsed: MetaResponse =
            serde_json::from_str(&response_body).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "botUsername": parsed.bot_username }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Translates one short string fully on-device (OPUS-MT ONNX pairs, EN
/// pivot for de<->ru). The pair + onnxruntime dylib download on first use
/// (pinned sha256, same channel as the Qwen models); sessions stay cached
/// in app state. No text leaves the device.
#[tauri::command]
async fn translate_text(
    text: String,
    from: String,
    to: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let dir = models_dir(&app)?;
    let translators = state.translators.clone();
    tauri::async_runtime::spawn_blocking(move || {
        translate_text_blocking(&text, &from, &to, &dir, &translators)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn translate_text_blocking(
    text: &str,
    from: &str,
    to: &str,
    models_dir: &Path,
    translators: &TranslatorCache,
) -> dokumente_core::error::Result<serde_json::Value> {
    let chain = translate::route_pair(from, to)?;
    // Bound worst-case CPU per call.
    let mut text: String = text.chars().take(translate::MAX_TRANSLATE_CHARS).collect();
    if chain.is_empty() {
        return Ok(serde_json::json!({ "text": text }));
    }
    let root = models_dir.join("translate");
    let base = format!("{TRANSLATE_BASE_URL}/{TRANSLATE_REPO_REV}");
    let manager = ModelManager::new(&HttpDownload, &root);
    // onnxruntime dylib first — no session builds without it.
    manager.download_files(&base, &root, &[translate::ORT_DYLIB], &mut |_, _| {})?;
    translate::ensure_ort(&translate::ort_dylib_path(&root))?;
    for pair in &chain {
        let Some(files) = translate::pair_files(pair) else {
            return Err(CoreError::Translate(format!("unknown pair: {pair}")));
        };
        manager.download_files(&base, &root, files, &mut |_, _| {})?;
        // Fast path under a short map lock; the expensive session load and
        // the inference itself run under the pair's own lock, so loading or
        // translating one pair never stalls another.
        let slot: Arc<Mutex<Option<translate::Translator>>> = {
            let mut cache = translators
                .lock()
                .map_err(|_| CoreError::Translate("translators lock poisoned".into()))?;
            cache
                .entry(pair.clone())
                .or_insert_with(|| Arc::new(Mutex::new(None::<translate::Translator>)))
                .clone()
        };
        {
            let mut guard = slot
                .lock()
                .map_err(|_| CoreError::Translate("translator lock poisoned".into()))?;
            if guard.is_none() {
                let translator = translate::Translator::load(&root, pair)?;
                *guard = Some(translator);
            }
            let translator = guard
                .as_mut()
                .expect("translator just loaded");
            text = translator.translate(&text)?;
        }
    }
    Ok(serde_json::json!({ "text": text }))
}

/// Everything the Settings pairing card needs in one round trip.
#[tauri::command]
async fn pairing_details(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let keys = state.keys.clone();
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let token = keys.get(TOKEN_ACCOUNT).map_err(|e| e.to_string())?;
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        let device_name = store
            .get_setting(SETTING_DEVICE_NAME)
            .map_err(|e| e.to_string())?;
        let upload = store
            .get_setting(SETTING_SYNC_UPLOAD)
            .map_err(|e| e.to_string())?;
        let server_scan = store
            .get_setting(SETTING_SERVER_SCAN)
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "paired": token.is_some(),
            "deviceName": device_name,
            "syncUploadEnabled": upload.as_deref() != Some("0"),
            "serverScanEnabled": server_scan.as_deref() == Some("1"),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The "Allow sync of structured summaries" checkbox.
#[tauri::command]
async fn set_sync_upload(
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        store
            .set_setting(SETTING_SYNC_UPLOAD, if enabled { "1" } else { "0" })
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "syncUploadEnabled": enabled }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The "Allow server-side image scan" checkbox. Default OFF — see
/// SETTING_SERVER_SCAN.
#[tauri::command]
async fn set_server_scan(
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        store
            .set_setting(SETTING_SERVER_SCAN, if enabled { "1" } else { "0" })
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "serverScanEnabled": enabled }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opt-in server-side transcription of a stored image document: re-reads
/// the original file, POSTs it to scan-image, and stores the returned text
/// as raw_text (status back to pending) so the normal local extract flow
/// picks it up. Hard-gated on the server-scan setting — raw bytes never
/// leave the device unless the user opted in.
#[tauri::command]
async fn scan_image(
    document_id: String,
    language: Option<String>,
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let base = resolve_base_url(&state, base_url);
    let store = state.store.clone();
    let id_for_read = document_id.clone();
    let image_b64 = tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        let enabled = store
            .get_setting(SETTING_SERVER_SCAN)
            .map_err(|e| e.to_string())?;
        if enabled.as_deref() != Some("1") {
            return Err(
                "server-side scan is disabled — enable it in Settings first".to_string(),
            );
        }
        let path = store
            .get_source_path(&id_for_read)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                "original file is no longer available for this document".to_string()
            })?;
        dokumente_core::sync::read_scan_image(std::path::Path::new(&path))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    let text = tauri::async_runtime::spawn_blocking(move || {
        client
            .scan_image_bytes(&image_b64, language.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    if text.trim().is_empty() {
        return Err("the server could not read any text in this image".to_string());
    }
    let store_for_write = state.store.clone();
    let text_for_store = text.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || {
        let store = store_for_write
            .lock()
            .map_err(|_| "store lock poisoned".to_string())?;
        store
            .update_raw_text(&document_id, &text_for_store)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    if !stored {
        return Err("document disappeared while scanning".to_string());
    }
    Ok(serde_json::json!({ "text": text }))
}

#[tauri::command]
async fn sync_now(
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<SyncReport, String> {
    let base = resolve_base_url(&state, base_url);
    let store = state.store.clone();
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        // push_pending locks only for the outbox snapshot and per-entry
        // marks — the network drain itself runs unlocked.
        client.push_pending(&store, 20).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn paired_status(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let keys = state.keys.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let token = keys.get(TOKEN_ACCOUNT).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "paired": token.is_some() }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Path of the store file quarantined at startup, if any. The UI banners
/// this (data loss is otherwise invisible behind a fresh empty library).
/// Plain field read off managed state — no blocking work, but async like
/// every other command so IPC never runs on the main thread.
#[tauri::command]
async fn quarantine_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    Ok(state
        .quarantine
        .clone()
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Deletes a document everywhere it exists. A document that reached the
/// server has a copy there — the summary, the extracted facts, the Sonnet
/// insights and the docvault vectors — and deleting only the local row left
/// all of it live AND re-rendered the document from the sync cache on the
/// next pull, so "delete" removed nothing the user could see for long.
///
/// Remote first, and fail closed: if the server copy cannot be removed, the
/// local row stays too and the error surfaces. Half-deleting toward the
/// state where the user's data survives only where they cannot see it is
/// the one outcome worth refusing.
#[tauri::command]
async fn delete_document(
    document_id: String,
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let base = resolve_base_url(&state, base_url);
    let client = SyncClient::new(Arc::new(HttpTransport::new(&base)), state.keys.clone());
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let remote_id = {
            let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
            store
                .remote_document_id(&document_id)
                .map_err(|e| e.to_string())?
        };
        // Lock released across the network call, like every other sync path.
        if let Some(remote_id) = remote_id.as_deref() {
            client
                .delete_remote_document(remote_id)
                .map_err(|e| e.to_string())?;
        }
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        let deleted = store.delete_document(&document_id).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "deleted": deleted,
            "remoteDeleted": remote_id.is_some(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Re-queues a parked document's failed outbox entries (status back to
/// pending, attempts reset) so it can reach the server on the next push.
/// Without this, a doc parked after 5× transient (or 1× 4xx) was lost to
/// the user with no recovery path. (UI button + banner land in step 3.)
#[tauri::command]
async fn requeue_failed_document(
    document_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        let revived = store
            .requeue_failed_document(&document_id)
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "requeued": revived }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_suggested_tasks(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        serde_json::to_value(store.list_suggested_tasks().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Confirms a suggested task: creates it on the backend (linked to the
/// server-side document) and only then marks it confirmed locally. On a
/// remote failure the claim is reverted so the user can retry.
#[tauri::command]
async fn confirm_suggested_task(
    id: i64,
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let base = resolve_base_url(&state, base_url);
    let store = state.store.clone();
    let keys = state.keys.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Atomically claim the task (concurrent confirms can't double-create).
        let claimed = {
            let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
            store
                .claim_suggested_task(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "task not found or already handled".to_string())?
        };

        let client = SyncClient::new(Arc::new(HttpTransport::new(&base)), keys);
        if let Err(err) = client.create_task(&claimed.title, &claimed.remote_document_id) {
            // Failed remotely — release the claim so the user can retry.
            if let Ok(store) = store.lock() {
                let _ = store.revert_suggested_task(id);
            }
            return Err(err.to_string());
        }
        // Consumed, not retained: confirmed rows would otherwise accumulate
        // forever (the list hides only dismissed ones). A failed delete is
        // non-fatal — the startup reset will revive it to pending.
        if let Ok(store) = store.lock() {
            let _ = store.consume_suggested_task(id);
        }
        Ok(serde_json::json!({ "confirmed": true, "taskId": id }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Dismisses a suggested task without creating it.
#[tauri::command]
async fn dismiss_suggested_task(
    id: i64,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        store
            .dismiss_suggested_task(id)
            .map(|dismissed| serde_json::json!({ "dismissed": dismissed }))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Performs a full incremental sync (all pages) and returns the merged
/// remote snapshot (documents/deadlines/tasks). No cursor arg — reads
/// stored cursor, advances it per page, returns full cache.
#[tauri::command]
async fn sync_pull(
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let base = resolve_base_url(&state, base_url);
    let store = state.store.clone();
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || -> std::result::Result<serde_json::Value, String> {
        // pull_and_apply locks only for the cursor read and per-page
        // applies — page fetches run unlocked; the final read is brief.
        let report = client
            .pull_and_apply(&store, 200)
            .map_err(|e| e.to_string())?;
        // Return merged snapshot plus whether the server restarted us from
        // scratch (resync wiped the local snapshot — the UI banners it so
        // the refresh doesn't pass as an ordinary delta).
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        let data = store.remote_data().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "data": data, "resynced": report.resynced }))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Returns the locally cached remote snapshot without hitting the network.
#[tauri::command]
async fn remote_data(state: tauri::State<'_, AppState>) -> Result<RemoteData, String> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|_| "store lock poisoned".to_string())?;
        store.remote_data().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Asks the backend chat (user facts + German laws). Non-streaming JSON —
/// the answer arrives as one string.
#[tauri::command]
async fn chat_ask(
    question: String,
    language: Option<String>,
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let base = resolve_base_url(&state, base_url);
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        client.ask_chat(&question, language.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Asks about ONE server-side document (retrieval scoped to its chunks).
/// Non-streaming JSON — the answer arrives as one string.
#[tauri::command]
async fn ask_document(
    document_id: String,
    question: String,
    language: Option<String>,
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let base = resolve_base_url(&state, base_url);
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        client.ask_document(&document_id, &question, language.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Marks a server-side deadline done (or reopens it). Async + blocking pool:
/// sync commands must not run on the main thread.
#[tauri::command]
async fn complete_deadline(
    deadline_id: String,
    completed: bool,
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let base = resolve_base_url(&state, base_url);
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        client.complete_deadline(&deadline_id, completed)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Moves a server-side task to a new status. The Tasks board could only
/// display work, never close it — every task had to be completed from another
/// surface for the board to catch up on the next pull.
#[tauri::command]
async fn update_task_status(
    task_id: String,
    status: String,
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let base = resolve_base_url(&state, base_url);
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        client.update_task_status(&task_id, &status)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// Fetches proactive cross-document hints (no local state involved).
#[tauri::command]
async fn fetch_hints(
    base_url: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RemoteHint>, String> {
    let base = resolve_base_url(&state, base_url);
    let client = SyncClient::new(
        Arc::new(HttpTransport::new(&base)),
        state.keys.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || client.fetch_hints())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Opens the encrypted store. If the file cannot be opened AND the current
/// keychain key does not decrypt it either (`verify_key` false — wrong key
/// after a dev rebuild changed the binary identity, or a corrupt file), the
/// unreadable file is renamed aside instead of bricking startup: the app
/// starts fresh and the old data stays recoverable by hand. Returns the
/// quarantine path alongside the store so the UI can banner the loss.
///
/// Fail-closed the other way: when the key DOES verify but the open still
/// failed (I/O error, schema problem), nothing is renamed — quarantining a
/// healthy-key database would destroy recoverable data to "fix" a transient.
fn open_store_or_quarantine(
    path: &std::path::Path,
    keys: &KeychainProvider,
) -> Result<(Store, Option<PathBuf>), String> {
    match Store::open(path, keys) {
        Ok(store) => Ok((store, None)),
        Err(err) => {
            if !err.to_string().contains("file is not a database") {
                return Err(format!("failed to open encrypted store: {err}"));
            }
            let key = keys.get_or_create_key().map_err(|e| e.to_string())?;
            if Store::verify_key(path, &key) {
                return Err(format!(
                    "store key verifies but open failed ({err}) — refusing to quarantine; inspect the file manually"
                ));
            }
            // Millis + PID: two crashes within one second (or two app
            // copies) must never collide on the quarantine name — the old
            // seconds-only stamp made the second rename fail and bricked
            // startup for exactly the users already having a bad day.
            let stamp_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let pid = std::process::id();
            let mut quarantined: Option<PathBuf> = None;
            for suffix in ["", "-wal", "-shm"] {
                let Some((src, dst)) = quarantine_paths(path, suffix, stamp_ms, pid) else {
                    continue;
                };
                if src.exists() {
                    std::fs::rename(&src, &dst).map_err(|e| {
                        format!("unreadable store could not be quarantined: {e}")
                    })?;
                    if suffix.is_empty() {
                        quarantined = Some(dst);
                    }
                }
            }
            let store = Store::open(path, keys)
                .map_err(|e| format!("failed to open fresh store after quarantine: {e}"))?;
            Ok((store, quarantined))
        }
    }
}

/// Computes the quarantine rename for one store sidecar file. Returns None
/// when the suffix is unknown (defensive — callers pass literals).
fn quarantine_paths(
    path: &std::path::Path,
    suffix: &str,
    stamp_ms: u128,
    pid: u32,
) -> Option<(PathBuf, PathBuf)> {
    if !["", "-wal", "-shm"].contains(&suffix) {
        return None;
    }
    let mut src = path.as_os_str().to_owned();
    src.push(suffix);
    let src = PathBuf::from(src);
    let mut dst = src.clone().into_os_string();
    dst.push(format!(".unreadable-{stamp_ms}-{pid}"));
    Some((src, PathBuf::from(dst)))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir: PathBuf = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;

            let keys = KeychainProvider::new();
            let (store, quarantine) =
                open_store_or_quarantine(&dir.join("dokumente.db"), &keys)?;
            // Revive suggestions stranded 'confirmed' by a crash between
            // claim and the remote POST (neither retryable nor dismissable
            // otherwise). Best-effort: a failure here must not block startup.
            match store.reset_confirmed_suggestions() {
                Ok(0) => {}
                Ok(n) => eprintln!("dokumente-app: revived {n} stranded confirmed suggestion(s) to pending"),
                Err(e) => eprintln!("dokumente-app: suggestion reset failed (non-fatal): {e}"),
            }

            app.manage(AppState {
                store: Arc::new(Mutex::new(store)),
                keys: Arc::new(keys),
                quarantine,
                base_url: Arc::new(Mutex::new(DEFAULT_BASE_URL.to_string())),
                translators: Arc::new(Mutex::new(HashMap::new())),
                #[cfg(feature = "llama")]
                extract_tx: spawn_extractor_thread(dir.join("models")),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ingest_document,
            list_folder_files,
            list_documents,
            extract_document,
            pair_propose,
            pair_poll,
            unpair_device,
            pairing_details,
            set_sync_upload,
            set_server_scan,
            scan_image,
            bot_username,
            translate_text,
            sync_now,
            sync_pull,
            remote_data,
            chat_ask,
            ask_document,
            complete_deadline,
            update_task_status,
            fetch_hints,
            paired_status,
            quarantine_status,
            delete_document,
            requeue_failed_document,
            model_status,
            download_model,
            list_suggested_tasks,
            confirm_suggested_task,
            dismiss_suggested_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running Papierkram");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row() -> DocumentRow {
        DocumentRow {
            id: "d1".to_string(),
            source_hash: "abc123".to_string(),
            file_name: Some("bescheid.pdf".to_string()),
            kind: "pdf".to_string(),
            raw_text: "Sehr geehrte Damen und Herren".to_string(),
            extraction_json: Some(r#"{"category":"jobcenter"}"#.to_string()),
            status: "pending".to_string(),
            error: None,
            created_at: "2026-09-04T10:00:00Z".to_string(),
            coverage_truncated: false,
        }
    }

    /// Locks the IPC contract with the React UI (`DocumentRow` in
    /// `apps/macos/ui/src/types.ts`). A drift here (e.g. camelCase keys or a
    /// missing `extraction_json`) crashes DocumentsPage on `.slice()` of
    /// `undefined` as soon as one real document exists.
    #[test]
    fn row_to_json_matches_ui_document_row_contract() {
        let v = row_to_json(&sample_row());
        for key in [
            "id",
            "source_hash",
            "file_name",
            "kind",
            "raw_text",
            "extraction_json",
            "status",
            "error",
            "created_at",
            "coverage_truncated",
        ] {
            assert!(v.get(key).is_some(), "missing key {key}");
        }
        assert_eq!(v["file_name"], "bescheid.pdf");
        assert_eq!(v["created_at"], "2026-09-04T10:00:00Z");
        // No legacy camelCase aliases may leak through.
        for key in ["sourceHash", "fileName", "createdAt", "hasExtraction", "textPreview"] {
            assert!(v.get(key).is_none(), "stale key {key}");
        }
    }

    #[test]
    fn row_to_json_handles_null_optionals() {
        let mut row = sample_row();
        row.file_name = None;
        row.extraction_json = None;
        let v = row_to_json(&row);
        assert!(v["file_name"].is_null());
        assert!(v["extraction_json"].is_null());
    }

    #[test]
    fn quarantine_paths_carry_ms_stamp_pid_and_sidecar() {
        let base = PathBuf::from("/data/dokumente.db");
        let (src, dst) = quarantine_paths(&base, "", 1_728_000_123_456, 4242).unwrap();
        assert_eq!(src, PathBuf::from("/data/dokumente.db"));
        assert_eq!(
            dst,
            PathBuf::from("/data/dokumente.db.unreadable-1728000123456-4242")
        );

        // Sidecars ride along with the same stamp.
        let (wsrc, wdst) = quarantine_paths(&base, "-wal", 7, 8).unwrap();
        assert_eq!(wsrc, PathBuf::from("/data/dokumente.db-wal"));
        assert_eq!(wdst, PathBuf::from("/data/dokumente.db-wal.unreadable-7-8"));

        // Distinct crashes never share a quarantine name.
        let (_, other) = quarantine_paths(&base, "", 1_728_000_123_457, 4242).unwrap();
        assert_ne!(dst, other);
    }

    #[test]
    fn quarantine_paths_rejects_unknown_suffix() {
        let base = PathBuf::from("/data/dokumente.db");
        assert!(quarantine_paths(&base, "-journal", 1, 1).is_none());
    }

    #[test]
    fn download_claim_is_single_flight_per_name() {
        assert!(try_claim_download("test-model-claim"));
        // Second claimant loses while the first holds it…
        assert!(!try_claim_download("test-model-claim"));
        // …a different model is unaffected…
        assert!(try_claim_download("other-model-claim"));
        release_download("other-model-claim");
        // …and release lets the first name through again.
        release_download("test-model-claim");
        assert!(try_claim_download("test-model-claim"));
        release_download("test-model-claim");
    }

    #[test]
    fn is_oom_shaped_matches_allocation_failures_only() {
        assert!(is_oom_shaped("ggml_metal: out of memory, tried to allocate 5 GB"));
        assert!(is_oom_shaped("mmap failed: Cannot allocate memory"));
        assert!(is_oom_shaped("MEMORY mapping error"));
        assert!(!is_oom_shaped("context creation failed: bad params"));
        assert!(!is_oom_shaped("model not downloaded (foo)"));
    }
}
