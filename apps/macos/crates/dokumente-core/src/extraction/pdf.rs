use crate::error::{CoreError, Result};
use std::path::Path;

/// Extracts from already-read bytes: the caller enforced the size cap on
/// the descriptor, so this never re-opens the path (no stat→read race,
/// no second unbounded read).
pub fn extract_bytes(bytes: &[u8], path: &Path) -> Result<String> {
    pdf_extract::extract_text_from_mem(bytes).map_err(|err| CoreError::ExtractionFailed {
        path: path.display().to_string(),
        message: err.to_string(),
    })
}
