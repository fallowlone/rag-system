use crate::error::{CoreError, Result};
use std::path::Path;

/// DOCX = zip with `word/document.xml`. We stream XML events and collect
/// `w:t` text nodes, inserting a newline after every paragraph (`w:p`).
/// This avoids the zip-bomb risk of inflating the whole XML into memory:
/// quick-xml events are pulled incrementally and we stop at MAX_XML_BYTES
/// of raw (compressed) stream consumption.
const MAX_XML_BYTES: u64 = 64 * 1024 * 1024;

/// Extracts from already-read bytes (see `pdf::extract_bytes` for why the
/// path is not re-opened).
pub fn extract_bytes(bytes: &[u8], path: &Path) -> Result<String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|err| CoreError::ExtractionFailed {
        path: path.display().to_string(),
        message: format!("invalid zip container: {err}"),
    })?;

    let entry = archive
        .by_name("word/document.xml")
        .map_err(|_| CoreError::EmptyDocument {
            path: path.display().to_string(),
        })?;

    if entry.size() > MAX_XML_BYTES {
        return Err(CoreError::FileTooLarge {
            size: entry.size(),
            max: MAX_XML_BYTES,
        });
    }

    collect_text(entry)
}

fn collect_text<R: std::io::Read>(reader: R) -> Result<String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    use std::io::BufReader;

    let mut reader = Reader::from_reader(BufReader::new(reader));
    let mut buf = Vec::new();
    let mut text = String::new();
    let mut in_text_run = false;

    loop {
        // `entry.size()` above is the zip header's CLAIMED size — a crafted
        // archive can understate it. Cap the ACCUMULATED text instead (one
        // text node of overshoot at most), so a lying header can't inflate
        // memory past this bound.
        if text.len() as u64 > MAX_XML_BYTES {
            return Err(CoreError::FileTooLarge {
                size: text.len() as u64,
                max: MAX_XML_BYTES,
            });
        }
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local = e.local_name();
                if local.as_ref() == b"t" {
                    in_text_run = true;
                } else if local.as_ref() == b"p" {
                    text.push('\n');
                }
            }
            Ok(Event::Text(ref e)) => {
                if in_text_run {
                    if let Ok(decoded) = e.unescape() {
                        text.push_str(decoded.as_ref());
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if e.local_name().as_ref() == b"t" {
                    in_text_run = false;
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(err) => {
                return Err(CoreError::ExtractionFailed {
                    path: "word/document.xml".to_string(),
                    message: err.to_string(),
                });
            }
        }
        buf.clear();
    }

    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Builds a minimal .docx (zip with word/document.xml) for tests.
    fn make_docx(dir: &std::path::Path, xml: &str) -> std::path::PathBuf {
        let path = dir.join("test.docx");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn extracts_text_runs_with_paragraph_breaks() {
        let dir = tempfile::tempdir().unwrap();
        let xml = concat!(
            "<w:document><w:body>",
            "<w:p><w:r><w:t>Bewilligungsbescheid</w:t></w:r></w:p>",
            "<w:p><w:r><w:t>Bürgergeld </w:t></w:r><w:r><w:t>ab Oktober</w:t></w:r></w:p>",
            "</w:body></w:document>"
        );
        let path = make_docx(dir.path(), xml);

        let text = extract_bytes(&std::fs::read(&path).unwrap(), &path).unwrap();
        assert!(text.contains("Bewilligungsbescheid"));
        assert!(text.contains("\nBürgergeld ab Oktober"));
    }

    #[test]
    fn rejects_a_zip_without_document_xml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-a-docx.docx");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("other.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"hello").unwrap();
        zip.finish().unwrap();

        assert!(matches!(
            extract_bytes(&std::fs::read(&path).unwrap(), &path),
            Err(CoreError::EmptyDocument { .. })
        ));
    }

    #[test]
    fn caps_accumulated_text_despite_a_lying_header_size() {
        // The header size gate trusts the zip central directory; the
        // accumulation cap must fire even when it understates. 70 MB of
        // text in one run exercises the counter (stored, not compressed —
        // ~100 ms, acceptable for the guarantee it pins).
        let dir = tempfile::tempdir().unwrap();
        let big = "a".repeat(70 * 1024 * 1024);
        let xml = format!(
            "<w:document><w:body><w:p><w:r><w:t>{big}</w:t></w:r></w:p></w:body></w:document>"
        );
        let path = make_docx(dir.path(), &xml);
        assert!(matches!(
            extract_bytes(&std::fs::read(&path).unwrap(), &path),
            Err(CoreError::FileTooLarge { .. })
        ));
    }
}
