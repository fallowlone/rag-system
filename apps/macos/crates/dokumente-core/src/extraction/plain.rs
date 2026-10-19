use crate::error::{CoreError, Result};
use std::path::Path;

/// Sniffs already-read bytes (see `pdf::extract_bytes` for why the path is
/// not re-opened).
pub fn extract_bytes(bytes: &[u8], path: &Path) -> Result<String> {
    // NUL bytes never occur in text a user typed: their presence means
    // binary, and they would additionally poison the SQLite→Postgres path
    // (Postgres rejects \0 in text → backend 400 → doc parked failed with
    // no recovery). Reject outright, before any sniffing.
    // `looks_binary` alone also rejects (no FFFD required): non-UTF8-free
    // binaries (MZ+ASCII payload, latin-1) carry no replacement char but
    // are still garbage for inference. A few stray invalid sequences in
    // otherwise clean text still pass through as U+FFFD replacements.
    if bytes.contains(&0) || looks_binary(bytes) {
        return Err(CoreError::UnsupportedFileType {
            path: path.display().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

/// Heuristic: >10% non-printable bytes in the first 4 KB ⇒ binary, not text.
fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.is_empty() {
        return false;
    }
    let non_printable = sample
        .iter()
        .filter(|b| {
            let b = **b;
            b < 9 || (13..32).contains(&b)
        })
        .count();
    non_printable * 10 > sample.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &std::path::Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn rejects_nul_bytes_outright() {
        let dir = tempfile::tempdir().unwrap();
        // NULs would pass SQLite and die at Postgres (\0 rejected in text).
        let path = write(
            dir.path(),
            "nul.txt",
            b"text with \x00 nul inside and more text",
        );
        assert!(matches!(
            extract_bytes(&std::fs::read(&path).unwrap(), &path),
            Err(CoreError::UnsupportedFileType { .. })
        ));
    }

    #[test]
    fn rejects_binary_without_replacement_chars() {
        let dir = tempfile::tempdir().unwrap();
        // Pure ASCII + control bytes: valid UTF-8, so no U+FFFD — the old
        // FFFD-gated check passed this as "text". Still garbage for inference.
        let mut bytes = b"MZ-HEADER-PAYLOAD".to_vec();
        bytes.extend([0x01u8, 0x02, 0x03].iter().cycle().take(1500).copied());
        let path = write(dir.path(), "prog.txt", &bytes);
        assert!(matches!(
            extract_bytes(&std::fs::read(&path).unwrap(), &path),
            Err(CoreError::UnsupportedFileType { .. })
        ));
    }

    #[test]
    fn accepts_valid_text_with_umlauts_and_stray_invalid_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = "Bürgergeld für Müller, Äpfel und Öl.\n".as_bytes().to_vec();
        bytes.extend([0xff, 0xfe]); // stray invalid sequence → FFFD, kept
        let path = write(dir.path(), "ok.txt", &bytes);
        let text = extract_bytes(&std::fs::read(&path).unwrap(), &path).unwrap();
        assert!(text.contains("Bürgergeld"));
    }
}
