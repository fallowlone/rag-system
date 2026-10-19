//! dokumente-core — the Rust core of the Dokumente macOS companion app.
//!
//! Pipeline: file → text extraction → (Phase 3: local llama.cpp extraction)
//! → encrypted SQLCipher store → sync outbox → NestJS backend `/app/v1`.
//! The raw document text NEVER leaves the device.

pub mod crypto;
pub mod error;
pub mod eval;
pub mod extraction;
pub mod llm;
pub mod store;
#[cfg(test)]
mod store_tests;
pub mod sync;
pub mod translate;
pub mod types;

use error::{CoreError, Result};
use sha2::{Digest, Sha256};
use std::path::Path;

/// sha256 hex of a file's bytes — the dedup key on both sides.
pub fn source_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Generates a random document id (UUID v4-shaped, no extra dependency).
pub fn new_document_id() -> String {
    let mut bytes = [0u8; 16];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    let hexed = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hexed[0..8],
        &hexed[8..12],
        &hexed[12..16],
        &hexed[16..20],
        &hexed[20..32]
    )
}

/// Reads a file, extracts text, and stores it as a `pending` document.
/// Returns Ok(None) when the source hash is already known (dedup — the
/// expensive local-model run is skipped).
///
/// Takes the shared store: the file read, hash, and text extraction all run
/// without holding the lock (Vision OCR can take minutes), which is locked
/// only for the dup check and the insert. A concurrent double-ingest of the
/// same file loses the insert race on the UNIQUE(source_hash) constraint —
/// that maps to Ok(None) too, since the row provably exists by then.
pub fn ingest_file(
    path: &Path,
    database: &std::sync::Mutex<store::Store>,
) -> Result<Option<store::DocumentRow>> {
    // One capped descriptor read (regular files only — pipes and /dev/*
    // never pass the gate): the hash and every downstream step work from
    // these bytes, so a file growing mid-ingest can't blow past the cap
    // between a stat and a later read.
    let bytes = extraction::read_capped(path, extraction::MAX_FILE_SIZE_BYTES)?;
    let hash = source_hash(&bytes);
    if database
        .lock()
        .map_err(|_| CoreError::LockPoisoned)?
        .has_source_hash(&hash)?
    {
        return Ok(None);
    }

    let extracted = extraction::extract_text(path)?;
    let id = new_document_id();
    let file_name = path.file_name().and_then(|n| n.to_str());

    let database = database.lock().map_err(|_| CoreError::LockPoisoned)?;
    match database.insert_document(
        &id,
        &hash,
        file_name,
        format!("{:?}", extracted.kind).to_lowercase().as_str(),
        &extracted.text,
        path.to_str(),
    ) {
        Ok(()) => database.get_document(&id),
        Err(CoreError::Store(rusqlite::Error::SqliteFailure(ffi, _)))
            if ffi.extended_code & 0xff == 19 =>
        {
            Ok(None)
        }
        Err(other) => Err(other),
    }
}

/// One discoverable file inside a user-picked folder.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FolderFile {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    /// False for extensions the extractor cannot read (see
    /// `extraction::detect_kind`) — the UI skips these with a count.
    pub supported: bool,
    /// True when the file exceeds `extraction::MAX_FILE_SIZE_BYTES` — the
    /// UI skips these with a count instead of failing per file.
    pub too_large: bool,
}

/// Result of scanning a user-picked folder for ingestable documents.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FolderScan {
    pub files: Vec<FolderFile>,
    /// True when the walk hit MAX_FOLDER_FILES — the UI tells the user the
    /// list is capped instead of silently dropping the rest.
    pub truncated: bool,
}

/// Hard caps for folder scans: recursion depth (symlink cycles are skipped
/// outright, this bounds legit nesting) and total file entries (the UI
/// ingests sequentially — an unbounded list would look hung).
pub const MAX_FOLDER_DEPTH: usize = 8;
pub const MAX_FOLDER_FILES: usize = 1000;

/// Recursively lists a user-picked folder for batch ingest. Sorted by path
/// for deterministic UI order. Hidden entries (dotfiles, e.g. .DS_Store)
/// and symlinks are skipped; unreadable entries are skipped, not fatal —
/// only a missing/unreadable ROOT fails. Never reads file contents.
pub fn list_folder_files(dir: &Path) -> Result<FolderScan> {
    let mut files: Vec<FolderFile> = Vec::new();
    let mut truncated = false;
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(dir.to_path_buf(), 0)];
    while let Some((path, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(err) if path.as_os_str() == dir.as_os_str() => return Err(err.into()),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let meta = match std::fs::symlink_metadata(&entry_path) {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }
            if meta.is_dir() {
                if depth < MAX_FOLDER_DEPTH {
                    stack.push((entry_path, depth + 1));
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            if files.len() >= MAX_FOLDER_FILES {
                truncated = true;
                continue;
            }
            let size = meta.len();
            files.push(FolderFile {
                path: entry_path.to_string_lossy().into_owned(),
                file_name: name_str.into_owned(),
                size_bytes: size,
                supported: extraction::detect_kind(&entry_path).is_some(),
                too_large: size > extraction::MAX_FILE_SIZE_BYTES,
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(FolderScan { files, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;
    use crypto::InMemoryProvider;

    #[test]
    fn source_hash_matches_known_sha256() {
        let hash = source_hash(b"hello");
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn document_ids_are_unique_and_uuid_shaped() {
        let a = new_document_id();
        let b = new_document_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert!(a.chars().filter(|c| *c == '-').count() == 4);
    }

    #[test]
    fn ingest_file_stores_pending_document_and_dedups() {
        let keys = InMemoryProvider::new();
        let database = std::sync::Mutex::new(store::Store::open_in_memory(&keys).unwrap());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bescheid.txt");
        std::fs::write(&path, "Bewilligungsbescheid Bürgergeld").unwrap();

        let first = ingest_file(&path, &database).unwrap();
        assert!(first.is_some());
        let row = first.unwrap();
        assert_eq!(row.status, "pending");
        assert_eq!(row.raw_text, "Bewilligungsbescheid Bürgergeld");
        assert_eq!(row.kind, "text");
        assert_eq!(row.source_hash.len(), 64);

        // Same content again → dedup, no second row.
        let second = ingest_file(&path, &database).unwrap();
        assert!(second.is_none());
        assert_eq!(database.lock().unwrap().list_documents().unwrap().len(), 1);
    }

    #[test]
    fn ingest_file_propagates_extraction_errors() {
        let keys = InMemoryProvider::new();
        let database = std::sync::Mutex::new(store::Store::open_in_memory(&keys).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("program.exe");
        std::fs::write(&path, b"MZ binary").unwrap();
        let err = ingest_file(&path, &database).unwrap_err();
        assert!(matches!(err, CoreError::UnsupportedFileType { .. }));
    }

    #[test]
    fn list_folder_files_finds_supported_files_recursively_sorted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("b.pdf"), b"%PDF").unwrap();
        std::fs::write(dir.path().join("a.txt"), b"text").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("c.docx"), b"docx").unwrap();
        // Unsupported, hidden and oversized entries are reported/skipped.
        std::fs::write(dir.path().join("run.exe"), b"MZ").unwrap();
        std::fs::write(dir.path().join(".DS_Store"), b"junk").unwrap();
        let big = std::fs::File::create(dir.path().join("big.pdf")).unwrap();
        big.set_len(extraction::MAX_FILE_SIZE_BYTES + 1).unwrap();
        drop(big);

        let scan = list_folder_files(dir.path()).unwrap();
        assert!(!scan.truncated);
        // Sorted by full path: a.txt, b.pdf, big.pdf, run.exe, sub/c.docx.
        let names: Vec<&str> = scan.files.iter().map(|f| f.file_name.as_str()).collect();
        assert_eq!(
            names,
            vec!["a.txt", "b.pdf", "big.pdf", "run.exe", "c.docx"]
        );
        let by_name = |n: &str| scan.files.iter().find(|f| f.file_name == n).unwrap();
        assert!(by_name("a.txt").supported && !by_name("a.txt").too_large);
        assert!(by_name("c.docx").supported);
        assert!(!by_name("run.exe").supported);
        assert!(by_name("big.pdf").supported && by_name("big.pdf").too_large);
        // Hidden dotfiles never surface.
        assert!(scan.files.iter().all(|f| f.file_name != ".DS_Store"));
    }

    #[test]
    fn list_folder_files_skips_symlinks_and_missing_root_fails() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("real.txt"), b"text").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("real.txt"), dir.path().join("link.txt"))
            .unwrap();

        let scan = list_folder_files(dir.path()).unwrap();
        assert!(scan.files.iter().all(|f| f.file_name != "link.txt"));
        assert!(scan.files.iter().any(|f| f.file_name == "real.txt"));

        let err = list_folder_files(&dir.path().join("nope")).unwrap_err();
        assert!(matches!(err, CoreError::Io(_)));
    }

    #[test]
    fn ingest_file_rejects_oversized_files_from_metadata() {
        let keys = InMemoryProvider::new();
        let database = std::sync::Mutex::new(store::Store::open_in_memory(&keys).unwrap());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.pdf");
        // Sparse file: stat reports a huge size without allocating it, so
        // this proves the rejection happens pre-read, not after loading.
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(extraction::MAX_FILE_SIZE_BYTES + 1).unwrap();
        drop(file);

        let err = ingest_file(&path, &database).unwrap_err();
        assert!(matches!(err, CoreError::FileTooLarge { .. }));
        assert!(database
            .lock()
            .unwrap()
            .list_documents()
            .unwrap()
            .is_empty());
    }
}
