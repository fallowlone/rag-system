//! Model management: downloading the GGUF model file with SHA-256
//! verification. The runner (llama.cpp) is behind the `llama` feature; the
//! manager itself has no native dependencies and is fully unit-tested.

use crate::error::{CoreError, Result};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// A pinned model release. `sha256` is the trust anchor: when set, a
/// downloaded file that does not match is deleted and rejected. `None`
/// means trust-on-first-use (the hash is computed, returned to the caller,
/// and should be pinned in code before shipping).
#[derive(Debug, Clone)]
pub struct ModelSpec {
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: Option<&'static str>,
    /// Expected size in bytes, for UI progress display.
    pub size_bytes: u64,
}

/// Primary: Qwen3-8B Instruct, Q4_K_M (~5 GB). Strong German
/// administrative-document comprehension, fits a 16 GB Mac.
/// Hash pinned 2026-09-05: local sha256 of the production download verified
/// byte-identical against the upstream `x-linked-etag` response header for
/// the URL below (two independent channels — file bytes + HF metadata).
pub const QWEN3_8B_Q4: ModelSpec = ModelSpec {
    name: "Qwen3-8B-Instruct-Q4_K_M",
    url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf",
    sha256: Some("d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785"),
    size_bytes: 5_027_783_488,
};

/// Fallback for ≤16 GB machines: Qwen3-4B Instruct, Q4_K_M (~2.5 GB).
/// Still unpinned (no verified local copy exists yet — do NOT invent a
/// hash; pin by downloading from the URL below and comparing the file's
/// sha256 against the upstream `x-linked-etag` response header, as was
/// done for QWEN3_8B_Q4 on 2026-09-05).
pub const QWEN3_4B_Q4: ModelSpec = ModelSpec {
    name: "Qwen3-4B-Instruct-Q4_K_M",
    url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
    sha256: None, // TODO(pin): see above
    size_bytes: 2_500_000_000,
};

/// A single pinned file inside a multi-file model distribution (e.g. one
/// ONNX pair: encoder/decoder/spm files). Same trust rule as ModelSpec: a
/// mismatching download is deleted and rejected.
#[derive(Debug, Clone)]
pub struct FileSpec {
    /// Path relative to the distribution root, e.g. "de-en/encoder_model.onnx".
    pub name: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

/// Free bytes available on the filesystem containing `dir` (statvfs).
/// None when the probe itself fails — callers fail open (a failed space
/// probe on an exotic filesystem must not block a download that would fit).
pub fn free_space_bytes(dir: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c_path = CString::new(dir.as_os_str().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
            return None;
        }
        Some(stat.f_bavail as u64 * stat.f_frsize as u64)
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        None
    }
}

/// Total physical RAM in bytes (macOS sysctl / Linux /proc). None when
/// unknown — callers fail open with the download allowed.
pub fn total_memory_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let mut size: u64 = 0;
        let mut len = std::mem::size_of::<u64>() as libc::size_t;
        if unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                &mut size as *mut u64 as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return None;
        }
        Some(size)
    }
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        let line = text.lines().find(|line| line.starts_with("MemTotal:"))?;
        let kibibytes: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kibibytes * 1024)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    None
}

/// Ensures `dir` can fit `need_bytes`, failing fast with a readable error
/// instead of dying at 99% of a multi-GB stream (whose tmp is then removed,
/// wasting every byte). Unknown free space fails open — see
/// `free_space_bytes`.
fn ensure_free_space(dir: &Path, need_bytes: u64, what: &str) -> Result<()> {
    if let Some(free) = free_space_bytes(dir) {
        if free < need_bytes {
            return Err(CoreError::Sync(format!(
                "not enough disk space for {what}: need {need_bytes} bytes, {free} available"
            )));
        }
    }
    Ok(())
}

/// A download reader plus the server-reported total size (Content-Length),
/// if available — drives progress reporting.
pub struct DownloadStream {
    pub reader: Box<dyn Read>,
    pub total: Option<u64>,
    /// The origin's own sha256 for this file, when it publishes one.
    ///
    /// Hugging Face returns it as `x-linked-etag` for LFS objects. It is a
    /// SECOND channel: independent of the bytes on the wire, so a truncated
    /// body, a corrupted mirror or a swapped object is caught even for a
    /// model this codebase has not pinned yet. Weaker than a compile-time
    /// pin — the origin could publish a matching digest for a bad file — so
    /// it upgrades trust-on-first-use, it does not replace pinning.
    pub upstream_sha256: Option<String>,
}

/// Abstraction over the download so tests don't touch the network.
pub trait DownloadTransport {
    fn open(&self, url: &str) -> std::result::Result<DownloadStream, String>;
}

/// Production transport over ureq with a generous timeout for big files.
pub struct HttpDownload;

impl DownloadTransport for HttpDownload {
    fn open(&self, url: &str) -> std::result::Result<DownloadStream, String> {
        let response = ureq::get(url)
            .timeout(std::time::Duration::from_secs(600))
            .call()
            .map_err(|err| err.to_string())?;
        if response.status() != 200 {
            return Err(format!("HTTP {}", response.status()));
        }
        let total = response
            .header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok());
        let upstream_sha256 = response
            .header("x-linked-etag")
            .or_else(|| response.header("etag"))
            .and_then(parse_sha256_etag);
        Ok(DownloadStream {
            reader: Box::new(response.into_reader()),
            total,
            upstream_sha256,
        })
    }
}

/// Reads a sha256 out of an ETag header, or None.
///
/// Only a bare 64-character lowercase hex value counts. Hugging Face quotes
/// it (`"abc…"`) and may prefix a weak validator (`W/"abc…"`); a plain HTTP
/// ETag is an opaque server token — often an md5 or an inode stamp — and
/// treating one of those as a digest would reject every honest download.
pub fn parse_sha256_etag(raw: &str) -> Option<String> {
    let value = raw
        .trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .to_ascii_lowercase();
    let is_sha256 =
        value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit());
    is_sha256.then_some(value)
}

pub struct ModelManager<'a> {
    pub transport: &'a dyn DownloadTransport,
    /// Directory where verified models are stored.
    pub models_dir: PathBuf,
}

/// Outcome of a download-and-verify run.
#[derive(Debug, PartialEq, Eq)]
pub enum DownloadOutcome {
    /// File verified against the pinned hash and stored at the path.
    Verified(PathBuf),
    /// Pinned hash did not match — file deleted, nothing stored.
    HashMismatch,
    /// No hash pinned, but the origin published one and the bytes match it.
    /// Stronger than bare TOFU, weaker than a pin — see `upstream_sha256`.
    UpstreamVerified { path: PathBuf, sha256: String },
    /// No hash pinned: file stored, hash returned for pinning (TOFU).
    Unpinned { path: PathBuf, sha256: String },
}

impl<'a> ModelManager<'a> {
    pub fn new(transport: &'a dyn DownloadTransport, models_dir: impl Into<PathBuf>) -> Self {
        Self {
            transport,
            models_dir: models_dir.into(),
        }
    }

    pub fn model_path(&self, spec: &ModelSpec) -> PathBuf {
        self.models_dir.join(format!("{}.gguf", spec.name))
    }

    /// True when a file for the spec already exists (and, when pinned,
    /// matches the expected hash).
    /// Fast presence check: file exists with a plausible size. Deliberately
    /// does NOT hash — SHA-256 over multi-GB weights takes seconds and this
    /// is called on every status poll; full verification runs once at
    /// download time inside `download_and_verify`.
    pub fn is_downloaded(&self, spec: &ModelSpec) -> bool {
        let path = self.model_path(spec);
        match std::fs::metadata(&path) {
            Ok(meta) => {
                meta.len() > 0
                    && meta.len() >= spec.size_bytes / 2
                    && meta.len() <= spec.size_bytes * 3 / 2
            }
            Err(_) => false,
        }
    }

    /// Downloads the model to a temp file, hashes it while streaming, and
    /// only then atomically renames it into place. A mismatching or aborted
    /// download never leaves a usable model file behind.
    /// `on_progress` is called after every chunk with (bytes downloaded so
    /// far, server-reported total when known). Errors inside the callback do
    /// not abort the download.
    pub fn download_and_verify(
        &self,
        spec: &ModelSpec,
        on_progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<DownloadOutcome> {
        std::fs::create_dir_all(&self.models_dir)?;
        ensure_free_space(&self.models_dir, spec.size_bytes, spec.name)?;

        let final_path = self.model_path(spec);
        let tmp_path = self.models_dir.join(format!(".{}.download", spec.name));

        // Hygiene: if a previous attempt was interrupted (app closed mid-
        // download), remove the stale partial before starting fresh so no
        // leftover bytes can ever leak into the new download.
        let _ = std::fs::remove_file(&tmp_path);

        self.fetch_url_to(spec.url, &tmp_path, &final_path, spec.sha256, on_progress)
    }

    /// Downloads every file of a multi-file distribution (e.g. one ONNX
    /// pair) that is not already present with a plausible size, verifying
    /// each sha256. Returns the number of files fetched. A hash mismatch
    /// deletes the partial and fails the whole set.
    pub fn download_files(
        &self,
        base_url: &str,
        dir: &Path,
        files: &[FileSpec],
        on_progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<usize> {
        std::fs::create_dir_all(dir)?;
        let mut fetched = 0;
        for file in files {
            let final_path = dir.join(file.name);
            if let Some(parent) = final_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if file_present(&final_path, file.size_bytes) {
                continue;
            }
            ensure_free_space(dir, file.size_bytes, file.name)?;
            let tmp_path = dir.join(format!(".{}.download", file.name.replace('/', "_")));
            let _ = std::fs::remove_file(&tmp_path);
            let url = format!("{}/{}", base_url.trim_end_matches('/'), file.name);
            match self.fetch_url_to(&url, &tmp_path, &final_path, Some(file.sha256), on_progress)? {
                DownloadOutcome::Verified(_)
                | DownloadOutcome::UpstreamVerified { .. }
                | DownloadOutcome::Unpinned { .. } => {
                    fetched += 1;
                }
                DownloadOutcome::HashMismatch => {
                    return Err(CoreError::Sync(format!(
                        "download failed: hash mismatch for {} (file deleted)",
                        file.name
                    )));
                }
            }
        }
        Ok(fetched)
    }

    /// Streams `url` into `tmp_path`, hashes on the fly, and atomically
    /// renames to `final_path` on success. Shared core of the single- and
    /// multi-file downloaders.
    fn fetch_url_to(
        &self,
        url: &str,
        tmp_path: &Path,
        final_path: &Path,
        expected_sha: Option<&str>,
        on_progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<DownloadOutcome> {
        let stream = self.transport.open(url).map_err(CoreError::Sync)?;
        let mut reader = stream.reader;
        let total = stream.total;
        let upstream_sha = stream.upstream_sha256;
        let mut downloaded: u64 = 0;

        let file = std::fs::File::create(tmp_path)?;
        let mut writer = std::io::BufWriter::new(file);
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 1024 * 256]; // 256 KB chunks — big file, few syscalls

        let digest = loop {
            let read = reader.read(&mut buffer).map_err(|err| {
                let _ = std::fs::remove_file(tmp_path);
                CoreError::Sync(format!("download interrupted: {err}"))
            })?;
            if read == 0 {
                break hasher.finalize();
            }
            hasher.update(&buffer[..read]);
            std::io::Write::write_all(&mut writer, &buffer[..read]).map_err(|err| {
                let _ = std::fs::remove_file(tmp_path);
                CoreError::Io(err)
            })?;
            downloaded += read as u64;
            on_progress(downloaded, total);
        };
        drop(writer);

        let hash = hex::encode(digest);
        // A pinned hash is the strongest anchor and always wins. Falling back
        // to the origin's own digest matters for a model that is not pinned
        // yet: without it those bytes were accepted unconditionally.
        let anchor = expected_sha
            .map(|pinned| (pinned.to_string(), true))
            .or_else(|| upstream_sha.map(|up| (up, false)));

        if let Some((expected, _)) = &anchor {
            if &hash != expected {
                let _ = std::fs::remove_file(tmp_path);
                return Ok(DownloadOutcome::HashMismatch);
            }
        }

        std::fs::rename(tmp_path, final_path)?;
        Ok(match anchor {
            Some((_, true)) => DownloadOutcome::Verified(final_path.to_path_buf()),
            Some((_, false)) => DownloadOutcome::UpstreamVerified {
                path: final_path.to_path_buf(),
                sha256: hash,
            },
            None => DownloadOutcome::Unpinned {
                path: final_path.to_path_buf(),
                sha256: hash,
            },
        })
    }
}

/// Presence check mirroring `is_downloaded`: exists with plausible size.
/// Deliberately NOT hashing — full verification runs at download time.
pub fn file_present(path: &Path, size_bytes: u64) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => {
            meta.len() > 0 && meta.len() >= size_bytes / 2 && meta.len() <= size_bytes * 3 / 2
        }
        Err(_) => false,
    }
}
