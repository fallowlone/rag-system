//! On-device OCR for scanned documents via the macOS Vision framework.
//!
//! A small Swift script (embedded, written to a temp file at call time) uses
//! PDFKit + VNRecognizeTextRequest to recognize German text in scanned PDFs
//! and images. Runs fully offline; the recognized text never leaves the
//! device. Requires the Swift interpreter (present with Xcode CLT).

use crate::error::{CoreError, Result};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const OCR_SWIFT: &str = include_str!("../../resources/ocr.swift");
const OCR_TIMEOUT: Duration = Duration::from_secs(300);
pub const DEFAULT_MAX_PAGES: u32 = 20;

/// True when the `swift` interpreter is on PATH (Xcode Command Line Tools).
fn swift_available() -> bool {
    Command::new("swift")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

/// Recognizes text in a scanned PDF or image. Returns the raw text (page
/// breaks as blank lines) or a descriptive error when OCR is unavailable or
/// found nothing.
pub fn recognize(path: &Path) -> Result<String> {
    if !swift_available() {
        return Err(CoreError::ExtractionFailed {
            path: path.display().to_string(),
            message: "scanned document detected, but on-device OCR is unavailable \
                      (the swift interpreter was not found — install the Xcode \
                      Command Line Tools)"
                .into(),
        });
    }

    // Materialize the embedded script into a UNIQUE temp file per call
    // (O_EXCL creation): a fixed path would race between parallel ingests
    // and is TOCTOU-prone. The file lives until the child exits, then is
    // deleted automatically on drop.
    let mut script = tempfile::Builder::new()
        .prefix("dokumente-ocr-")
        .suffix(".swift")
        .tempfile()
        .map_err(|err| CoreError::ExtractionFailed {
            path: path.display().to_string(),
            message: format!("OCR script staging failed: {err}"),
        })?;
    std::io::Write::write_all(&mut script, OCR_SWIFT.as_bytes()).map_err(|err| {
        CoreError::ExtractionFailed {
            path: path.display().to_string(),
            message: format!("OCR script staging failed: {err}"),
        }
    })?;

    let mut child = Command::new("swift")
        .arg(script.path())
        .arg(path)
        .arg(DEFAULT_MAX_PAGES.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| CoreError::ExtractionFailed {
            path: path.display().to_string(),
            message: format!("OCR process failed to start: {err}"),
        })?;

    let mut stdout = child.stdout.take().expect("stdout piped");
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });

    let deadline = Instant::now() + OCR_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CoreError::ExtractionFailed {
                    path: path.display().to_string(),
                    message: format!("OCR timed out after {} s", OCR_TIMEOUT.as_secs()),
                });
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(150)),
            Err(err) => {
                return Err(CoreError::ExtractionFailed {
                    path: path.display().to_string(),
                    message: format!("OCR process failed: {err}"),
                })
            }
        }
    };

    let output = reader.join().unwrap_or_default();

    if !status.success() && output.trim().is_empty() {
        return Err(CoreError::ExtractionFailed {
            path: path.display().to_string(),
            message: format!("scanned document detected, but OCR found no text (exit {status})"),
        });
    }

    Ok(output)
}
