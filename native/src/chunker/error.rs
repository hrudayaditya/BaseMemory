use thiserror::Error;

#[derive(Debug, Error)]
pub enum ChunkerError {
    #[error("failed to initialize parser for language {language}")]
    ParserUnavailable { language: String },

    #[error("failed to parse {file_path}")]
    ParseFailed { file_path: String },

    #[error("invalid utf-8 slice for {file_path} at bytes {start}..{end}")]
    InvalidSlice {
        file_path: String,
        start: usize,
        end: usize,
    },

    #[error("fine chunk coverage invariant failed for {file_path} ({language}): {details}")]
    CoverageInvariant {
        file_path: String,
        language: String,
        details: String,
    },

    #[error("chunk size invariant failed for {file_path} ({language}): chunk length {chunk_len} exceeds max {max_len}")]
    ChunkTooLarge {
        file_path: String,
        language: String,
        chunk_len: usize,
        max_len: usize,
    },
}
