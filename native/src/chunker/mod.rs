pub mod error;
pub mod fallback;
pub mod languages;
pub mod policy;
pub mod walker;

use crate::hasher::xxhash_content;
use crate::types::Language;
use error::ChunkerError;
use fallback::chunk_by_lines;
use napi_derive::napi;
use policy::get_policy;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::sync::{Mutex, OnceLock};
use tree_sitter::Parser;

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ChunkKind {
    Code,
    Test,
    Doc,
    Config,
}

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Interface,
    Struct,
    Test,
    Module,
    Block,
}

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Granularity {
    Fine,
    Coarse,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkConfig {
    pub target_token_budget: u32,
    pub max_chunk_chars: u32,
    pub min_chunk_chars: u32,
    pub merge_small_siblings: bool,
    pub attach_comments: bool,
    pub emit_coarse_chunks: bool,
}

impl ChunkConfig {
    pub fn target_token_budget_usize(&self) -> usize {
        self.target_token_budget as usize
    }

    pub fn max_chunk_chars_usize(&self) -> usize {
        self.max_chunk_chars as usize
    }

    pub fn min_chunk_chars_usize(&self) -> usize {
        self.min_chunk_chars as usize
    }
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            target_token_budget: 1500,
            max_chunk_chars: 3000,
            min_chunk_chars: 200,
            merge_small_siblings: true,
            attach_comments: true,
            emit_coarse_chunks: true,
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub file_path: String,
    pub language: String,
    pub symbol_name: Option<String>,
    pub symbol_kind: Option<SymbolKind>,
    pub chunk_kind: ChunkKind,
    pub granularity: Granularity,
    pub start_byte: u32,
    pub end_byte: u32,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
    pub chunk_hash: String,
}

#[cfg(test)]
static TEST_LOGS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn emit_log(level: &str, message: String) {
    eprintln!("[chunker:{level}] {message}");

    #[cfg(test)]
    {
        if let Some(logs) = TEST_LOGS.get() {
            if let Ok(mut guard) = logs.lock() {
                guard.push(message);
            }
        }
    }
}

pub(crate) fn log_warn(message: String) {
    emit_log("warn", message);
}

pub(crate) fn log_debug(message: String) {
    emit_log("debug", message);
}

#[cfg(test)]
fn clear_captured_logs() {
    let logs = TEST_LOGS.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(mut guard) = logs.lock() {
        guard.clear();
    }
}

#[cfg(test)]
fn captured_logs() -> Vec<String> {
    TEST_LOGS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn normalize_language(file_path: &str, language: &str) -> String {
    if !language.trim().is_empty() {
        return Language::from_string(language).as_str().to_string();
    }

    std::path::Path::new(file_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(Language::from_extension)
        .unwrap_or(Language::Unknown)
        .as_str()
        .to_string()
}

fn ensure_non_empty_chunks(
    file_path: &str,
    language: &str,
    source_code: &str,
    mut chunks: Vec<Chunk>,
) -> Vec<Chunk> {
    if !chunks.is_empty() || source_code.is_empty() {
        return chunks;
    }

    log_debug(format!(
        "chunker zero-chunk safety net fired file_path={} language={} source_len={}",
        file_path,
        language,
        source_code.len()
    ));

    chunks.push(Chunk {
        file_path: file_path.to_string(),
        language: language.to_string(),
        symbol_name: None,
        symbol_kind: None,
        chunk_kind: ChunkKind::Code,
        granularity: Granularity::Fine,
        start_byte: 0,
        end_byte: source_code.len() as u32,
        start_line: 1,
        end_line: source_code.lines().count().max(1) as u32,
        text: source_code.to_string(),
        chunk_hash: xxhash_content(source_code),
    });

    chunks
}

fn build_line_index(source: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (idx, byte) in source.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(idx + 1);
        }
    }
    starts
}

fn line_for_byte(starts: &[usize], byte: usize) -> u32 {
    match starts.binary_search(&byte) {
        Ok(index) => (index + 1) as u32,
        Err(index) => index as u32,
    }
}

fn gap_fill_chunk(
    file_path: &str,
    language: &str,
    source_code: &str,
    line_starts: &[usize],
    start: usize,
    end: usize,
) -> Result<Chunk, ChunkerError> {
    let text = source_code
        .get(start..end)
        .ok_or_else(|| ChunkerError::InvalidSlice {
            file_path: file_path.to_string(),
            start,
            end,
        })?
        .to_string();

    log_debug(format!(
        "chunker gap-fill chunk emitted file_path={} language={} start_byte={} end_byte={} size={}",
        file_path,
        language,
        start,
        end,
        text.len()
    ));

    Ok(Chunk {
        file_path: file_path.to_string(),
        language: language.to_string(),
        symbol_name: None,
        symbol_kind: Some(SymbolKind::Block),
        chunk_kind: ChunkKind::Code,
        granularity: Granularity::Fine,
        start_byte: start as u32,
        end_byte: end as u32,
        start_line: line_for_byte(line_starts, start).max(1),
        end_line: if end == 0 {
            1
        } else {
            line_for_byte(line_starts, end.saturating_sub(1)).max(1)
        },
        chunk_hash: xxhash_content(&text),
        text,
    })
}

fn floor_char_boundary(source: &str, mut index: usize) -> usize {
    if index >= source.len() {
        return source.len();
    }

    while index > 0 && !source_code_is_char_boundary(source, index) {
        index -= 1;
    }

    index
}

fn source_code_is_char_boundary(source: &str, index: usize) -> bool {
    source.is_char_boundary(index)
}

fn split_range_to_max_sized_chunks(
    file_path: &str,
    language: &str,
    source_code: &str,
    line_starts: &[usize],
    start: usize,
    end: usize,
    base_chunk: &Chunk,
    max_len: usize,
) -> Result<Vec<Chunk>, ChunkerError> {
    let mut chunks = Vec::new();
    let mut segment_start = start;

    while segment_start < end {
        let max_end = floor_char_boundary(source_code, (segment_start + max_len).min(end));
        let mut segment_end = line_starts
            .iter()
            .copied()
            .take_while(|line_start| *line_start <= max_end)
            .filter(|line_start| *line_start > segment_start)
            .last()
            .unwrap_or(max_end);

        if segment_end <= segment_start {
            segment_end = max_end;
        }

        if segment_end <= segment_start {
            return Err(ChunkerError::ChunkTooLarge {
                file_path: file_path.to_string(),
                language: language.to_string(),
                chunk_len: end.saturating_sub(start),
                max_len,
            });
        }

        let text = source_code
            .get(segment_start..segment_end)
            .ok_or_else(|| ChunkerError::InvalidSlice {
                file_path: file_path.to_string(),
                start: segment_start,
                end: segment_end,
            })?
            .to_string();

        if text.len() > max_len {
            return Err(ChunkerError::ChunkTooLarge {
                file_path: file_path.to_string(),
                language: language.to_string(),
                chunk_len: text.len(),
                max_len,
            });
        }

        chunks.push(Chunk {
            file_path: file_path.to_string(),
            language: language.to_string(),
            symbol_name: base_chunk.symbol_name.clone(),
            symbol_kind: base_chunk.symbol_kind.clone(),
            chunk_kind: base_chunk.chunk_kind.clone(),
            granularity: Granularity::Fine,
            start_byte: segment_start as u32,
            end_byte: segment_end as u32,
            start_line: line_for_byte(line_starts, segment_start).max(1),
            end_line: if segment_end == 0 {
                1
            } else {
                line_for_byte(line_starts, segment_end.saturating_sub(1)).max(1)
            },
            chunk_hash: xxhash_content(&text),
            text,
        });

        segment_start = segment_end;
    }

    Ok(chunks)
}

fn enforce_fine_chunk_max_size(
    file_path: &str,
    language: &str,
    source_code: &str,
    config: &ChunkConfig,
    chunks: Vec<Chunk>,
) -> Result<Vec<Chunk>, ChunkerError> {
    let line_starts = build_line_index(source_code);
    let max_len = config.max_chunk_chars_usize();
    let mut result = Vec::with_capacity(chunks.len());

    for chunk in chunks {
        if chunk.granularity == Granularity::Fine && chunk.text.len() > max_len {
            result.extend(split_range_to_max_sized_chunks(
                file_path,
                language,
                source_code,
                &line_starts,
                chunk.start_byte as usize,
                chunk.end_byte as usize,
                &chunk,
                max_len,
            )?);
        } else {
            result.push(chunk);
        }
    }

    Ok(result)
}

#[cfg(debug_assertions)]
fn coverage_failure(
    file_path: &str,
    language: &str,
    details: String,
) -> Result<Vec<Chunk>, ChunkerError> {
    let error = ChunkerError::CoverageInvariant {
        file_path: file_path.to_string(),
        language: language.to_string(),
        details,
    };
    panic!("{error}");
}

#[cfg(not(debug_assertions))]
fn coverage_failure(
    file_path: &str,
    language: &str,
    details: String,
) -> Result<Vec<Chunk>, ChunkerError> {
    Err(ChunkerError::CoverageInvariant {
        file_path: file_path.to_string(),
        language: language.to_string(),
        details,
    })
}

fn enforce_fine_chunk_coverage(
    file_path: &str,
    language: &str,
    source_code: &str,
    config: &ChunkConfig,
    chunks: Vec<Chunk>,
) -> Result<Vec<Chunk>, ChunkerError> {
    if source_code.is_empty() {
        return Ok(chunks);
    }

    let line_starts = build_line_index(source_code);
    let mut fine_chunks: Vec<Chunk> = chunks
        .iter()
        .filter(|chunk| chunk.granularity == Granularity::Fine)
        .cloned()
        .collect();
    let coarse_chunks: Vec<Chunk> = chunks
        .into_iter()
        .filter(|chunk| chunk.granularity != Granularity::Fine)
        .collect();

    fine_chunks.sort_by(|a, b| {
        a.start_byte
            .cmp(&b.start_byte)
            .then_with(|| a.end_byte.cmp(&b.end_byte))
    });

    let mut covered_until = 0usize;
    let mut normalized = Vec::with_capacity(fine_chunks.len() + 2);

    for chunk in fine_chunks {
        let start = chunk.start_byte as usize;
        let end = chunk.end_byte as usize;

        if start < covered_until {
            return coverage_failure(
                file_path,
                language,
                format!(
                    "overlap detected: previous_end={} current_start={} current_end={}",
                    covered_until, start, end
                ),
            );
        }

        if start > covered_until {
            let gap_chunk = gap_fill_chunk(
                file_path,
                language,
                source_code,
                &line_starts,
                covered_until,
                start,
            )?;
            if gap_chunk.text.len() > config.max_chunk_chars_usize() {
                normalized.extend(split_range_to_max_sized_chunks(
                    file_path,
                    language,
                    source_code,
                    &line_starts,
                    covered_until,
                    start,
                    &gap_chunk,
                    config.max_chunk_chars_usize(),
                )?);
            } else {
                normalized.push(gap_chunk);
            }
        }

        covered_until = end;
        normalized.push(chunk);
    }

    if covered_until < source_code.len() {
        let gap_chunk = gap_fill_chunk(
            file_path,
            language,
            source_code,
            &line_starts,
            covered_until,
            source_code.len(),
        )?;
        if gap_chunk.text.len() > config.max_chunk_chars_usize() {
            normalized.extend(split_range_to_max_sized_chunks(
                file_path,
                language,
                source_code,
                &line_starts,
                covered_until,
                source_code.len(),
                &gap_chunk,
                config.max_chunk_chars_usize(),
            )?);
        } else {
            normalized.push(gap_chunk);
        }
    }

    let mut fine_only: Vec<&Chunk> = normalized
        .iter()
        .filter(|chunk| chunk.granularity == Granularity::Fine)
        .collect();
    fine_only.sort_by(|a, b| {
        a.start_byte
            .cmp(&b.start_byte)
            .then_with(|| a.end_byte.cmp(&b.end_byte))
    });

    let mut cursor = 0usize;
    for chunk in fine_only {
        let start = chunk.start_byte as usize;
        let end = chunk.end_byte as usize;

        if start != cursor {
            let details = if start < cursor {
                format!(
                    "overlap remained after normalization: previous_end={} current_start={} current_end={}",
                    cursor, start, end
                )
            } else {
                format!(
                    "gap remained after normalization: previous_end={} current_start={}",
                    cursor, start
                )
            };
            return coverage_failure(file_path, language, details);
        }

        cursor = end;
    }

    if cursor != source_code.len() {
        return coverage_failure(
            file_path,
            language,
            format!(
                "final coverage ended at {} but source length is {}",
                cursor,
                source_code.len()
            ),
        );
    }

    let mut result = normalized;
    result.extend(coarse_chunks);
    result.sort_by(|a, b| {
        a.start_byte
            .cmp(&b.start_byte)
            .then_with(|| a.end_byte.cmp(&b.end_byte))
            .then_with(|| a.granularity.cmp(&b.granularity))
    });
    Ok(result)
}

pub fn chunk_file(
    file_path: &str,
    language: &str,
    source_code: &str,
    config: &ChunkConfig,
) -> Result<Vec<Chunk>, ChunkerError> {
    let normalized_language = normalize_language(file_path, language);
    let Some(policy) = get_policy(&normalized_language) else {
        let chunks = chunk_by_lines(file_path, &normalized_language, source_code, config);
        let chunks = ensure_non_empty_chunks(file_path, &normalized_language, source_code, chunks);
        let chunks = enforce_fine_chunk_max_size(
            file_path,
            &normalized_language,
            source_code,
            config,
            chunks,
        )?;
        return enforce_fine_chunk_coverage(
            file_path,
            &normalized_language,
            source_code,
            config,
            chunks,
        );
    };

    let mut parser = Parser::new();
    let parser_language = (policy.parser_language)();
    parser
        .set_language(&parser_language)
        .map_err(|_| ChunkerError::ParserUnavailable {
            language: normalized_language.clone(),
        })?;

    let Some(tree) = parser.parse(source_code, None) else {
        log_warn(format!(
            "chunker parse error encountered file_path={} language={} error=parser returned no tree",
            file_path,
            normalized_language
        ));
        return Err(ChunkerError::ParseFailed {
            file_path: file_path.to_string(),
        });
    };

    if tree.root_node().has_error() {
        log_warn(format!(
            "chunker partial parse encountered file_path={} language={} error=tree contains syntax errors",
            file_path,
            policy.language_name
        ));
    }

    let chunks = walker::chunk_tree(
        file_path,
        policy.language_name,
        source_code,
        config,
        policy,
        &tree,
    )?;

    let chunks = ensure_non_empty_chunks(file_path, policy.language_name, source_code, chunks);
    let chunks =
        enforce_fine_chunk_max_size(file_path, policy.language_name, source_code, config, chunks)?;

    enforce_fine_chunk_coverage(file_path, policy.language_name, source_code, config, chunks)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fine_chunks(chunks: &[Chunk]) -> Vec<&Chunk> {
        chunks
            .iter()
            .filter(|chunk| chunk.granularity == Granularity::Fine)
            .collect()
    }

    #[test]
    fn attaches_leading_comments_to_typescript_function() {
        let source = r#"// explains foo
export function foo() {
  return 1;
}
"#;

        let chunks = chunk_file("test.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let function_chunk = chunks
            .iter()
            .find(|chunk| chunk.symbol_name.as_deref() == Some("foo"))
            .unwrap_or_else(|| panic!("missing foo chunk"));

        assert!(function_chunk.text.starts_with("// explains foo"));
        assert_eq!(function_chunk.chunk_hash.len(), 16);
    }

    #[test]
    fn detects_python_tests() {
        let source = r#"class TestMath:
    def test_add(self):
        assert 1 + 1 == 2
"#;

        let chunks = chunk_file("test.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let test_chunk = chunks
            .iter()
            .find(|chunk| chunk.symbol_name.as_deref() == Some("test_add"))
            .unwrap_or_else(|| panic!("missing test chunk"));

        assert_eq!(test_chunk.chunk_kind, ChunkKind::Test);
        assert_eq!(test_chunk.symbol_kind, Some(SymbolKind::Test));
    }

    #[test]
    fn falls_back_for_unknown_languages() {
        let source = "alpha\nbeta\ngamma\ndelta\n";
        let chunks = chunk_file(
            "notes.txt",
            "unknown",
            source,
            &ChunkConfig {
                max_chunk_chars: 8,
                ..ChunkConfig::default()
            },
        )
        .unwrap_or_else(|err| panic!("{err}"));

        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|chunk| chunk.symbol_kind.is_none()));
    }

    #[test]
    fn guarantees_at_least_one_chunk_for_unrecognized_non_empty_source() {
        let source = "plain text without a known language";
        let chunks = chunk_file("notes.unknown", "unknown", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(!chunks.is_empty());
        assert_eq!(chunks[0].start_byte, 0);
        assert_eq!(chunks[0].end_byte, source.len() as u32);
    }

    #[test]
    fn fine_chunks_cover_entire_source_for_supported_languages() {
        let source = r#"import { helper } from "./helper";

// comment
export function foo() {
  helper();
}

const bar = () => {
  return 2;
};
"#;

        let chunks = chunk_file("test.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let fine = fine_chunks(&chunks);

        let mut covered = vec![false; source.len()];
        for chunk in fine {
            for byte in chunk.start_byte as usize..chunk.end_byte as usize {
                covered[byte] = true;
            }
        }

        assert!(covered.into_iter().all(|byte| byte));
    }

    #[test]
    fn force_splits_massive_function_to_respect_max_chunk_chars() {
        let repeated = "  console.log('abcdefghijklmnopqrstuvwxyz');\n".repeat(120);
        let source = format!("export function huge() {{\n{}{}\n", repeated, "}");

        let chunks = chunk_file(
            "huge.ts",
            "typescript",
            &source,
            &ChunkConfig {
                max_chunk_chars: 200,
                min_chunk_chars: 20,
                ..ChunkConfig::default()
            },
        )
        .unwrap_or_else(|err| panic!("{err}"));

        let fine = fine_chunks(&chunks);
        assert!(fine.len() > 1);
        assert!(fine.iter().all(|chunk| chunk.text.len() <= 200));
    }

    #[test]
    fn fine_chunk_byte_ranges_cover_source_exactly_without_overlap() {
        let source = r#"import { helper } from "./helper";

export function alpha() {
  helper();
}

export function beta() {
  helper();
}
"#;

        let chunks = chunk_file("multi.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let fine = fine_chunks(&chunks);
        let mut seen = vec![0u8; source.len()];
        for chunk in fine {
            for byte in chunk.start_byte as usize..chunk.end_byte as usize {
                seen[byte] = seen[byte].saturating_add(1);
            }
        }

        assert!(seen.into_iter().all(|count| count == 1));
    }

    #[test]
    fn logs_when_no_semantic_units_are_found_for_supported_language() {
        clear_captured_logs();

        let source = r#"import { helper } from "./helper";
const answer = 42;
"#;

        let _ = chunk_file(
            "no-semantic-log.ts",
            "typescript",
            source,
            &ChunkConfig::default(),
        )
        .unwrap_or_else(|err| panic!("{err}"));

        let logs = captured_logs();
        assert!(logs.iter().any(|entry| {
            entry.contains("chunker found no semantic units")
                && entry.contains("file_path=no-semantic-log.ts")
                && entry.contains("language=typescript")
        }));
    }
}
