//! Text extraction from local documents. The raw file never leaves the
//! process — only the extracted text (and later, the local model's structured
//! extraction of it) is stored in the encrypted DB.

mod docx;
mod ocr;
mod pdf;
mod plain;

use crate::error::{CoreError, Result};
use std::path::Path;

/// Hard cap on input size — mirrors the Telegram path's PDF limit (10 MB)
/// plus headroom for larger office documents.
pub const MAX_FILE_SIZE_BYTES: u64 = 50 * 1024 * 1024;

/// Rough cap on extracted text before the local model sees it (chars).
pub const MAX_TEXT_CHARS: usize = 120_000;

/// Reads at most `max + 1` bytes, rejecting non-regular files first. A
/// stat-then-read gate is TOCTOU (the file can grow between the two calls)
/// and useless against special files (`/dev/zero` stats size 0, then
/// `read` blocks/OOMs) — open the descriptor, check the type, and let the
/// byte count itself enforce the cap.
pub(crate) fn read_capped(path: &Path, max: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    if !file.metadata()?.file_type().is_file() {
        return Err(CoreError::UnsupportedFileType {
            path: path.display().to_string(),
        });
    }
    let mut buf = Vec::new();
    file.take(max + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > max {
        return Err(CoreError::FileTooLarge {
            size: buf.len() as u64,
            max,
        });
    }
    Ok(buf)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceKind {
    Pdf,
    Docx,
    Text,
    Image,
}

#[derive(Debug)]
pub struct ExtractedText {
    pub kind: SourceKind,
    pub text: String,
}

/// Detects the source kind from the file extension.
pub fn detect_kind(path: &Path) -> Option<SourceKind> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;

    match ext.as_str() {
        "pdf" => Some(SourceKind::Pdf),
        "docx" => Some(SourceKind::Docx),
        "txt" | "md" => Some(SourceKind::Text),
        "png" | "jpg" | "jpeg" | "heic" | "tiff" => Some(SourceKind::Image),
        _ => None,
    }
}

/// Extracts plain text from a local document. One capped descriptor read up
/// front (see `read_capped`) — text extractors work from those bytes and
/// never re-open the path. Only the OCR branch takes the path (Vision
/// opens the file itself).
pub fn extract_text(path: &Path) -> Result<ExtractedText> {
    let bytes = read_capped(path, MAX_FILE_SIZE_BYTES)?;

    let kind = detect_kind(path).ok_or_else(|| CoreError::UnsupportedFileType {
        path: path.display().to_string(),
    })?;

    let text = match kind {
        SourceKind::Pdf => {
            let text = pdf::extract_bytes(&bytes, path)?;
            if normalize_whitespace(&text).trim().is_empty() {
                // No text layer — this is a scan. Fall back to on-device OCR
                // (Vision) before giving up.
                ocr::recognize(path)?
            } else {
                text
            }
        }
        SourceKind::Docx => docx::extract_bytes(&bytes, path)?,
        SourceKind::Text => plain::extract_bytes(&bytes, path)?,
        SourceKind::Image => ocr::recognize(path)?,
    };

    let text = normalize_whitespace(&text);
    if text.trim().is_empty() {
        return Err(CoreError::EmptyDocument {
            path: path.display().to_string(),
        });
    }

    Ok(ExtractedText {
        kind,
        text: text.chars().take(MAX_TEXT_CHARS).collect(),
    })
}

/// Collapses PDF-extraction artifacts: runs of spaces and stray control
/// characters, while preserving paragraph breaks.
fn normalize_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_was_space = false;
    for ch in text.chars() {
        match ch {
            '\n' | '\r' => {
                if !last_was_space {
                    out.push('\n');
                }
                last_was_space = true;
            }
            '\t' | ' ' | '\u{00a0}' => {
                if !last_was_space {
                    out.push(' ');
                }
                last_was_space = true;
            }
            c if c.is_control() => {
                // drop other control chars (pdf-extract emits form feeds etc.)
            }
            c => {
                out.push(c);
                last_was_space = false;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_kind_maps_extensions() {
        assert_eq!(
            detect_kind(Path::new("/tmp/Bescheid.PDF")),
            Some(SourceKind::Pdf)
        );
        assert_eq!(
            detect_kind(Path::new("vertrag.docx")),
            Some(SourceKind::Docx)
        );
        assert_eq!(
            detect_kind(Path::new("notizen.txt")),
            Some(SourceKind::Text)
        );
        assert_eq!(detect_kind(Path::new("scan.jpg")), Some(SourceKind::Image));
        assert_eq!(detect_kind(Path::new("data.exe")), None);
    }

    #[test]
    fn extract_text_rejects_oversized_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        // Sparse file: stat reports a huge size without allocating it.
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_FILE_SIZE_BYTES + 1).unwrap();
        drop(file);

        let err = extract_text(&path).unwrap_err();
        assert!(matches!(err, CoreError::FileTooLarge { .. }));
    }

    #[test]
    fn extract_text_rejects_unknown_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.zip");
        std::fs::write(&path, b"PK\x03\x04").unwrap();
        let err = extract_text(&path).unwrap_err();
        assert!(matches!(err, CoreError::UnsupportedFileType { .. }));
    }

    #[test]
    fn extract_plain_text_normalizes_whitespace_and_rejects_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.txt");
        std::fs::write(&path, "Bürgergeld\n\n\nAntrag   gestellt.\u{000c}").unwrap();

        let extracted = extract_text(&path).unwrap();
        // Runs of whitespace (incl. blank lines) collapse to a single break.
        assert_eq!(extracted.text, "Bürgergeld\nAntrag gestellt.");

        let empty = dir.path().join("empty.txt");
        std::fs::write(&empty, "   \n\t  ").unwrap();
        assert!(matches!(
            extract_text(&empty),
            Err(CoreError::EmptyDocument { .. })
        ));
    }

    #[test]
    fn extract_text_truncates_to_max_chars() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long.txt");
        std::fs::write(&path, "x".repeat(MAX_TEXT_CHARS + 100)).unwrap();
        let extracted = extract_text(&path).unwrap();
        assert_eq!(extracted.text.chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn read_capped_rejects_non_regular_files() {
        // /dev/null stats size 0 — a stat gate would pass it, then block
        // reading forever. The descriptor type check rejects it up front.
        let err = read_capped(Path::new("/dev/null"), MAX_FILE_SIZE_BYTES).unwrap_err();
        assert!(
            matches!(err, CoreError::UnsupportedFileType { .. }),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn read_capped_enforces_the_cap_on_content_not_stat() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("growing.bin");
        std::fs::write(&path, vec![b'x'; 100]).unwrap();
        let err = read_capped(&path, 10).unwrap_err();
        assert!(matches!(err, CoreError::FileTooLarge { size: 11, max: 10 }));
        assert_eq!(read_capped(&path, 100).unwrap().len(), 100);
    }
}
