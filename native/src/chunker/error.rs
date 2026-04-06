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
}
