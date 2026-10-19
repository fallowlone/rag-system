use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("file too large: {size} bytes (max {max} bytes)")]
    FileTooLarge { size: u64, max: u64 },

    #[error("unsupported file type: {path}")]
    UnsupportedFileType { path: String },

    #[error("extraction failed for {path}: {message}")]
    ExtractionFailed { path: String, message: String },

    #[error("document is empty or contains no extractable text: {path}")]
    EmptyDocument { path: String },

    #[error("store error: {0}")]
    Store(#[from] rusqlite::Error),

    #[error("store lock poisoned by a previous panic")]
    LockPoisoned,

    #[error("keychain error: {0}")]
    Keychain(String),

    #[error("sync error: {0}")]
    Sync(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("translation error: {0}")]
    Translate(String),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, CoreError>;
