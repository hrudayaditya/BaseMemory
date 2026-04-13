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
use std::cell::RefCell;
use tree_sitter::Parser;

pub const CHUNKER_VERSION: &str = env!("CHUNKER_VERSION");
pub(crate) const FILE_MODULE_CONTEXT_MAX_NON_WHITESPACE_CHARS: usize = 800;

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ChunkKind {
    Code,
    Test,
    Doc,
    Config,
    File,
}

#[napi(string_enum)]
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Interface,
    Struct,
    Type,
    Constant,
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
    /// Soft secondary token budget for split decisions. Set to 0 to disable it.
    pub target_token_budget: u32,
    /// Breaking change: measured in non-whitespace Unicode characters, not bytes.
    pub max_chunk_chars: u32,
    /// Breaking change: measured in non-whitespace Unicode characters, not bytes.
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

    pub fn effective_max_non_whitespace_chars_usize(&self) -> usize {
        let max_chars = self.max_chunk_chars_usize().max(1);
        if self.target_token_budget == 0 {
            return max_chars;
        }

        let max_by_tokens = (((self.target_token_budget as f64) * 4.0) / 1.4)
            .floor()
            .max(1.0) as usize;
        max_chars.min(max_by_tokens)
    }
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            target_token_budget: 512,
            max_chunk_chars: 2000,
            min_chunk_chars: 400,
            merge_small_siblings: true,
            attach_comments: true,
            emit_coarse_chunks: true,
        }
    }
}

pub(crate) fn non_whitespace_len(s: &str) -> usize {
    s.chars().filter(|c| !c.is_whitespace()).count()
}

pub(crate) fn estimate_token_count(non_whitespace_len: usize) -> usize {
    (((non_whitespace_len as f64 * 1.4) / 4.0).ceil()) as usize
}

pub(crate) fn exceeds_budget(text: &str, config: &ChunkConfig) -> bool {
    let nw = non_whitespace_len(text);
    if nw > config.max_chunk_chars_usize() {
        return true;
    }

    if config.target_token_budget > 0 {
        let estimated_tokens = estimate_token_count(nw);
        if estimated_tokens > config.target_token_budget_usize() {
            return true;
        }
    }

    false
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
thread_local! {
    static TEST_LOGS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn emit_log(level: &str, message: String) {
    eprintln!("[chunker:{level}] {message}");

    #[cfg(test)]
    {
        TEST_LOGS.with(|logs| logs.borrow_mut().push(message));
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
    TEST_LOGS.with(|logs| logs.borrow_mut().clear());
}

#[cfg(test)]
fn captured_logs() -> Vec<String> {
    TEST_LOGS.with(|logs| logs.borrow().clone())
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

pub(crate) fn file_module_symbol_name(file_path: &str) -> Option<String> {
    let stem = std::path::Path::new(file_path)
        .file_stem()?
        .to_str()?
        .trim();
    if stem.is_empty() {
        return None;
    }
    Some(stem.to_string())
}

fn append_small_file_module_chunk(
    file_path: &str,
    language: &str,
    source_code: &str,
    chunks: &mut Vec<Chunk>,
) {
    if language == "unknown"
        || source_code.is_empty()
        || non_whitespace_len(source_code) > FILE_MODULE_CONTEXT_MAX_NON_WHITESPACE_CHARS
    {
        return;
    }

    let Some(symbol_name) = file_module_symbol_name(file_path) else {
        return;
    };

    let line_starts = build_line_index(source_code);
    let candidate = Chunk {
        file_path: file_path.to_string(),
        language: language.to_string(),
        symbol_name: Some(symbol_name),
        symbol_kind: Some(SymbolKind::Module),
        chunk_kind: ChunkKind::File,
        granularity: Granularity::Coarse,
        start_byte: 0,
        end_byte: source_code.len() as u32,
        start_line: 1,
        end_line: line_for_byte(&line_starts, source_code.len().saturating_sub(1)).max(1),
        text: source_code.to_string(),
        chunk_hash: xxhash_content(source_code),
    };

    if chunks.iter().any(|chunk| {
        chunk.start_byte == candidate.start_byte
            && chunk.end_byte == candidate.end_byte
            && chunk.text == candidate.text
    }) {
        return;
    }

    chunks.push(candidate);
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

fn find_budget_char_split_end(
    file_path: &str,
    language: &str,
    source_code: &str,
    start: usize,
    end: usize,
    config: &ChunkConfig,
) -> Result<usize, ChunkerError> {
    let text = source_code
        .get(start..end)
        .ok_or_else(|| ChunkerError::InvalidSlice {
            file_path: file_path.to_string(),
            start,
            end,
        })?;

    let mut split_end = start;
    let mut non_whitespace = 0usize;
    let max_non_whitespace = config.effective_max_non_whitespace_chars_usize();

    for (offset, ch) in text.char_indices() {
        if !ch.is_whitespace() && non_whitespace + 1 > max_non_whitespace {
            break;
        }
        if !ch.is_whitespace() {
            non_whitespace += 1;
        }
        split_end = start + offset + ch.len_utf8();
    }

    if split_end > start {
        return Ok(split_end);
    }

    Err(ChunkerError::ChunkTooLarge {
        file_path: file_path.to_string(),
        language: language.to_string(),
        chunk_len: non_whitespace_len(text),
        max_len: max_non_whitespace,
    })
}

pub(crate) fn split_range_to_max_sized_chunks(
    file_path: &str,
    language: &str,
    source_code: &str,
    line_starts: &[usize],
    start: usize,
    end: usize,
    base_chunk: &Chunk,
    config: &ChunkConfig,
) -> Result<Vec<Chunk>, ChunkerError> {
    let mut chunks = Vec::new();
    let mut segment_start = start;
    let max_len = config.effective_max_non_whitespace_chars_usize();
    let chunk_non_whitespace = non_whitespace_len(&base_chunk.text);
    let estimated_tokens = estimate_token_count(chunk_non_whitespace);

    log_warn(format!(
        "chunker force-split on line boundaries file_path={} language={} chunk_non_whitespace_chars={} estimated_tokens={} max_chunk_chars={} target_token_budget={} symbol_name={}",
        file_path,
        language,
        chunk_non_whitespace,
        estimated_tokens,
        config.max_chunk_chars,
        config.target_token_budget,
        base_chunk.symbol_name.as_deref().unwrap_or("<anonymous>")
    ));

    while segment_start < end {
        let mut segment_end = None;
        let mut candidate_boundaries: Vec<usize> = line_starts
            .iter()
            .copied()
            .take_while(|line_start| *line_start <= end)
            .filter(|line_start| *line_start > segment_start)
            .collect();
        if candidate_boundaries.last().copied() != Some(end) {
            candidate_boundaries.push(end);
        }

        for boundary in candidate_boundaries {
            let text = source_code.get(segment_start..boundary).ok_or_else(|| {
                ChunkerError::InvalidSlice {
                    file_path: file_path.to_string(),
                    start: segment_start,
                    end: boundary,
                }
            })?;
            if exceeds_budget(text, config) {
                break;
            }
            segment_end = Some(boundary);
        }

        let segment_end = if let Some(boundary) = segment_end {
            boundary
        } else {
            find_budget_char_split_end(
                file_path,
                language,
                source_code,
                segment_start,
                end,
                config,
            )?
        };

        let text = source_code
            .get(segment_start..segment_end)
            .ok_or_else(|| ChunkerError::InvalidSlice {
                file_path: file_path.to_string(),
                start: segment_start,
                end: segment_end,
            })?
            .to_string();

        if exceeds_budget(&text, config) {
            return Err(ChunkerError::ChunkTooLarge {
                file_path: file_path.to_string(),
                language: language.to_string(),
                chunk_len: non_whitespace_len(&text),
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

pub(crate) fn enforce_fine_chunk_max_size(
    file_path: &str,
    language: &str,
    source_code: &str,
    config: &ChunkConfig,
    chunks: Vec<Chunk>,
) -> Result<Vec<Chunk>, ChunkerError> {
    let line_starts = build_line_index(source_code);
    let mut result = Vec::with_capacity(chunks.len());

    for chunk in chunks {
        if chunk.granularity == Granularity::Fine && exceeds_budget(&chunk.text, config) {
            result.extend(split_range_to_max_sized_chunks(
                file_path,
                language,
                source_code,
                &line_starts,
                chunk.start_byte as usize,
                chunk.end_byte as usize,
                &chunk,
                config,
            )?);
        } else {
            result.push(chunk);
        }
    }

    Ok(result)
}

fn single_fallback_chunk(file_path: &str, language: &str, source_code: &str) -> Vec<Chunk> {
    let line_starts = build_line_index(source_code);
    let end_byte = source_code.len();

    ensure_non_empty_chunks(
        file_path,
        language,
        source_code,
        vec![Chunk {
            file_path: file_path.to_string(),
            language: language.to_string(),
            symbol_name: None,
            symbol_kind: None,
            chunk_kind: ChunkKind::Code,
            granularity: Granularity::Fine,
            start_byte: 0,
            end_byte: end_byte as u32,
            start_line: 1,
            end_line: line_for_byte(&line_starts, end_byte.saturating_sub(1)).max(1),
            text: source_code.to_string(),
            chunk_hash: xxhash_content(source_code),
        }],
    )
}

fn coverage_failure(
    file_path: &str,
    language: &str,
    source_code: &str,
    config: &ChunkConfig,
    details: String,
) -> Result<Vec<Chunk>, ChunkerError> {
    log_warn(format!(
        "chunker coverage invariant encountered file_path={} language={} details={}",
        file_path, language, details
    ));

    let fallback_chunks = chunk_by_lines(file_path, language, source_code, config);
    let fallback_chunks =
        ensure_non_empty_chunks(file_path, language, source_code, fallback_chunks);
    enforce_fine_chunk_max_size(file_path, language, source_code, config, fallback_chunks)
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
                source_code,
                config,
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
            if exceeds_budget(&gap_chunk.text, config) {
                normalized.extend(split_range_to_max_sized_chunks(
                    file_path,
                    language,
                    source_code,
                    &line_starts,
                    covered_until,
                    start,
                    &gap_chunk,
                    config,
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
        if exceeds_budget(&gap_chunk.text, config) {
            normalized.extend(split_range_to_max_sized_chunks(
                file_path,
                language,
                source_code,
                &line_starts,
                covered_until,
                source_code.len(),
                &gap_chunk,
                config,
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
            return coverage_failure(file_path, language, source_code, config, details);
        }

        cursor = end;
    }

    if cursor != source_code.len() {
        return coverage_failure(
            file_path,
            language,
            source_code,
            config,
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
        let mut chunks = enforce_fine_chunk_coverage(
            file_path,
            &normalized_language,
            source_code,
            config,
            chunks,
        )?;
        append_small_file_module_chunk(file_path, &normalized_language, source_code, &mut chunks);
        return Ok(chunks);
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
        return Ok(single_fallback_chunk(
            file_path,
            policy.language_name,
            source_code,
        ));
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
    let mut chunks =
        enforce_fine_chunk_coverage(file_path, policy.language_name, source_code, config, chunks)?;
    append_small_file_module_chunk(file_path, policy.language_name, source_code, &mut chunks);
    Ok(chunks)
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

    fn named_fine_chunk<'a>(chunks: &'a [Chunk], name: &str) -> &'a Chunk {
        chunks
            .iter()
            .find(|chunk| {
                chunk.symbol_name.as_deref() == Some(name) && chunk.granularity == Granularity::Fine
            })
            .unwrap_or_else(|| panic!("missing fine chunk for {name}"))
    }

    fn named_chunk<'a>(chunks: &'a [Chunk], name: &str) -> &'a Chunk {
        chunks
            .iter()
            .find(|chunk| chunk.symbol_name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("missing chunk for {name}"))
    }

    fn file_chunk<'a>(chunks: &'a [Chunk], name: &str) -> &'a Chunk {
        chunks
            .iter()
            .find(|chunk| {
                chunk.chunk_kind == ChunkKind::File && chunk.symbol_name.as_deref() == Some(name)
            })
            .unwrap_or_else(|| panic!("missing file chunk for {name}"))
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
    fn keeps_decorated_module_level_python_functions_as_functions() {
        let source = r#"@app.route("/")
def index():
    return "ok"
"#;

        let chunks = chunk_file("app.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let function_chunk = named_fine_chunk(&chunks, "index");

        assert_eq!(function_chunk.symbol_kind, Some(SymbolKind::Function));
        assert_eq!(function_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn keeps_module_level_pytest_fixtures_as_functions() {
        let source = r#"@pytest.fixture
def my_fixture():
    return 1
"#;

        let chunks = chunk_file("fixture.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let fixture_chunk = named_fine_chunk(&chunks, "my_fixture");

        assert_eq!(fixture_chunk.symbol_kind, Some(SymbolKind::Function));
        assert_eq!(fixture_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn keeps_decorated_class_methods_as_methods() {
        let source = r#"class Example:
    @classmethod
    def foo(cls):
        return cls
"#;

        let chunks = chunk_file("example.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let method_chunk = named_fine_chunk(&chunks, "foo");

        assert_eq!(method_chunk.symbol_kind, Some(SymbolKind::Method));
        assert_eq!(method_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn attaches_rust_doc_comments_to_function_chunks() {
        let source = r#"/// This is a doc comment
fn foo() {}
"#;

        let chunks = chunk_file("lib.rs", "rust", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let function_chunk = named_fine_chunk(&chunks, "foo");

        assert!(function_chunk.text.starts_with("/// This is a doc comment"));
        assert_eq!(function_chunk.symbol_kind, Some(SymbolKind::Function));
    }

    #[test]
    fn attaches_rust_doc_comments_to_struct_chunks() {
        let source = r#"/// Shared config
struct Config {
    enabled: bool,
}
"#;

        let chunks = chunk_file("lib.rs", "rust", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let struct_chunk = named_fine_chunk(&chunks, "Config");

        assert!(struct_chunk.text.starts_with("/// Shared config"));
        assert_eq!(struct_chunk.symbol_kind, Some(SymbolKind::Struct));
    }

    #[test]
    fn captures_rust_macro_definitions() {
        let source = r#"macro_rules! my_macro {
    () => {};
}
"#;

        let chunks = chunk_file("lib.rs", "rust", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let macro_chunk = named_fine_chunk(&chunks, "my_macro");

        assert_eq!(macro_chunk.symbol_kind, Some(SymbolKind::Function));
        assert_eq!(macro_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_rust_type_aliases() {
        let source = r#"type Meters = f64;
"#;

        let chunks = chunk_file("lib.rs", "rust", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let type_chunk = named_fine_chunk(&chunks, "Meters");

        assert_eq!(type_chunk.symbol_kind, Some(SymbolKind::Type));
        assert_eq!(type_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_rust_const_items() {
        let source = r#"const MAX: usize = 1024;
"#;

        let chunks = chunk_file("lib.rs", "rust", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let const_chunk = named_fine_chunk(&chunks, "MAX");

        assert_eq!(const_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(const_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_rust_static_items() {
        let source = r#"static INSTANCE: Lazy<Config> = Lazy::new(Config::default);
"#;

        let chunks = chunk_file("lib.rs", "rust", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let static_chunk = named_fine_chunk(&chunks, "INSTANCE");

        assert_eq!(static_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(static_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn keeps_rust_enums_typed_as_type_symbols() {
        let source = r#"enum Direction {
    North,
    South,
}
"#;

        let chunks = chunk_file("lib.rs", "rust", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let enum_chunk = named_fine_chunk(&chunks, "Direction");

        assert_eq!(enum_chunk.symbol_kind, Some(SymbolKind::Type));
        assert_eq!(enum_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn classifies_inherent_rust_impls_as_blocks() {
        let source = r#"impl MyStruct {
    fn run(&self) {}
}
"#;

        let chunks = chunk_file("lib.rs", "rust", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let impl_chunk = named_chunk(&chunks, "MyStruct");

        assert_eq!(impl_chunk.symbol_kind, Some(SymbolKind::Block));
        assert_eq!(impl_chunk.chunk_kind, ChunkKind::Code);
        assert_eq!(impl_chunk.granularity, Granularity::Coarse);

        let method_chunk = named_fine_chunk(&chunks, "run");
        assert_eq!(method_chunk.symbol_kind, Some(SymbolKind::Method));
    }

    #[test]
    fn classifies_trait_rust_impls_as_blocks_and_includes_trait_name() {
        let source = r#"impl Display for MyStruct {
    fn fmt(&self) {}
}
"#;

        let chunks = chunk_file("lib.rs", "rust", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let impl_chunk = named_chunk(&chunks, "Display for MyStruct");

        assert_eq!(impl_chunk.symbol_kind, Some(SymbolKind::Block));
        assert_eq!(impl_chunk.chunk_kind, ChunkKind::Code);
        assert_eq!(impl_chunk.granularity, Granularity::Coarse);
    }

    #[test]
    fn captures_go_const_specs() {
        let source = r#"package demo

const A = 1
"#;

        let chunks = chunk_file("demo.go", "go", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let const_chunk = named_fine_chunk(&chunks, "A");

        assert_eq!(const_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(const_chunk.chunk_kind, ChunkKind::Code);
        assert!(const_chunk.text.contains("const A = 1"));
    }

    #[test]
    fn captures_grouped_go_const_specs_without_anonymous_wrapper_gap_chunks() {
        let source = r#"package demo

const (
    A = 1
    B = 2
)
"#;

        let chunks = chunk_file("demo.go", "go", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let a_chunk = named_fine_chunk(&chunks, "A");
        let b_chunk = named_fine_chunk(&chunks, "B");

        assert_eq!(a_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(b_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert!(!chunks.iter().any(|chunk| {
            chunk.symbol_name.is_none()
                && chunk.granularity == Granularity::Fine
                && chunk.text.contains("const (")
        }));
        assert!(!chunks.iter().any(|chunk| {
            chunk.symbol_name.is_none()
                && chunk.granularity == Granularity::Fine
                && chunk.text.trim() == ")"
        }));
    }

    #[test]
    fn captures_go_package_level_vars() {
        let source = r#"package demo

var x int = 0
"#;

        let chunks = chunk_file("demo.go", "go", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let var_chunk = named_fine_chunk(&chunks, "x");

        assert_eq!(var_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(var_chunk.chunk_kind, ChunkKind::Code);
        assert!(var_chunk.text.contains("var x int = 0"));
    }

    #[test]
    fn captures_go_type_aliases() {
        let source = r#"package demo

type MyAlias = string
"#;

        let chunks = chunk_file("demo.go", "go", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let alias_chunk = named_fine_chunk(&chunks, "MyAlias");

        assert_eq!(alias_chunk.symbol_kind, Some(SymbolKind::Type));
        assert_eq!(alias_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn qualifies_go_pointer_receiver_methods() {
        let source = r#"package demo

type MyStruct struct{}

func (s *MyStruct) DoThing() {}
"#;

        let chunks = chunk_file("demo.go", "go", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let method_chunk = named_fine_chunk(&chunks, "MyStruct.DoThing");

        assert_eq!(method_chunk.symbol_kind, Some(SymbolKind::Method));
        assert_eq!(method_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn qualifies_go_value_receiver_methods() {
        let source = r#"package demo

type MyStruct struct{}

func (s MyStruct) Value() int { return 1 }
"#;

        let chunks = chunk_file("demo.go", "go", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let method_chunk = named_fine_chunk(&chunks, "MyStruct.Value");

        assert_eq!(method_chunk.symbol_kind, Some(SymbolKind::Method));
        assert_eq!(method_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_grouped_go_type_declarations_without_anonymous_wrapper_gap_chunks() {
        let source = r#"package demo

type (
    X struct{}
    Y = string
)
"#;

        let chunks = chunk_file("demo.go", "go", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let x_chunk = named_fine_chunk(&chunks, "X");
        let y_chunk = named_fine_chunk(&chunks, "Y");

        assert_eq!(x_chunk.symbol_kind, Some(SymbolKind::Struct));
        assert_eq!(y_chunk.symbol_kind, Some(SymbolKind::Type));
        assert!(!chunks.iter().any(|chunk| {
            chunk.symbol_name.is_none()
                && chunk.granularity == Granularity::Fine
                && chunk.text.contains("type (")
        }));
        assert!(!chunks.iter().any(|chunk| {
            chunk.symbol_name.is_none()
                && chunk.granularity == Granularity::Fine
                && chunk.text.trim() == ")"
        }));
    }

    #[test]
    fn captures_module_level_python_assignments_as_constants() {
        let source = r#"BASE_URL = "https://api.example.com"
"#;

        let chunks = chunk_file("settings.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let constant_chunk = named_fine_chunk(&chunks, "BASE_URL");

        assert_eq!(constant_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(constant_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn ignores_python_assignments_inside_function_bodies() {
        let source = r#"def build():
    BASE_URL = "https://api.example.com"
    return BASE_URL
"#;

        let chunks = chunk_file("settings.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(!chunks
            .iter()
            .any(|chunk| chunk.symbol_name.as_deref() == Some("BASE_URL")));
    }

    #[test]
    fn captures_python_all_exports_as_constants() {
        let source = r#"__all__ = ["A", "B"]
"#;

        let chunks = chunk_file("exports.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let all_chunk = named_fine_chunk(&chunks, "__all__");

        assert_eq!(all_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(all_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_python_type_alias_statements() {
        let source = r#"type Vector = list[float]
"#;

        let chunks = chunk_file("types.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let alias_chunk = named_fine_chunk(&chunks, "Vector");

        assert_eq!(alias_chunk.symbol_kind, Some(SymbolKind::Type));
        assert_eq!(alias_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_module_level_python_docstrings_as_doc_chunks() {
        let source = r#""""This module does X."""

VALUE = 1
"#;

        let chunks = chunk_file("module.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let doc_chunk = chunks
            .iter()
            .find(|chunk| {
                chunk.chunk_kind == ChunkKind::Doc && chunk.granularity == Granularity::Fine
            })
            .unwrap_or_else(|| panic!("missing module doc chunk"));

        assert_eq!(doc_chunk.symbol_kind, Some(SymbolKind::Block));
        assert!(doc_chunk.text.contains("This module does X."));
    }

    #[test]
    fn captures_function_level_python_docstrings_as_doc_chunks() {
        let source = r#"def render():
    """Render docs."""
    return "ok"
"#;

        let chunks = chunk_file("example.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let doc_chunk = chunks
            .iter()
            .find(|chunk| {
                chunk.chunk_kind == ChunkKind::Doc
                    && chunk.granularity == Granularity::Fine
                    && chunk.text.contains("Render docs.")
            })
            .unwrap_or_else(|| panic!("missing function doc chunk"));

        assert_eq!(doc_chunk.symbol_kind, Some(SymbolKind::Block));
    }

    #[test]
    fn captures_class_level_python_docstrings_as_doc_chunks() {
        let source = r#"class Example:
    """Class docs."""

    def run(self):
        return 1
"#;

        let chunks = chunk_file("example.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let doc_chunk = chunks
            .iter()
            .find(|chunk| {
                chunk.chunk_kind == ChunkKind::Doc
                    && chunk.granularity == Granularity::Fine
                    && chunk.text.contains("Class docs.")
            })
            .unwrap_or_else(|| panic!("missing class doc chunk"));

        assert_eq!(doc_chunk.symbol_kind, Some(SymbolKind::Block));
    }

    #[test]
    fn does_not_treat_non_leading_python_strings_as_doc_chunks() {
        let source = r#"def run():
    value = 1
    "not a docstring"
    return value
"#;

        let chunks = chunk_file("example.py", "python", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(!chunks.iter().any(|chunk| {
            chunk.chunk_kind == ChunkKind::Doc && chunk.text.contains("not a docstring")
        }));
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
    fn measures_non_whitespace_length_correctly() {
        assert_eq!(non_whitespace_len("  fn foo() { }  "), 9);
    }

    #[test]
    fn uses_non_whitespace_length_for_budget_checks() {
        let config = ChunkConfig {
            target_token_budget: 0,
            max_chunk_chars: 2000,
            ..ChunkConfig::default()
        };

        assert!(exceeds_budget(&"a ".repeat(2001), &config));
        assert!(!exceeds_budget(&"a ".repeat(1999), &config));
    }

    #[test]
    fn uses_estimated_token_budget_as_soft_secondary_limit() {
        let config = ChunkConfig {
            target_token_budget: 512,
            max_chunk_chars: 2000,
            ..ChunkConfig::default()
        };

        assert_eq!(estimate_token_count(1400), 490);
        assert_eq!(estimate_token_count(1800), 630);
        assert!(!exceeds_budget(&"a".repeat(1400), &config));
        assert!(exceeds_budget(&"a".repeat(1800), &config));
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
        assert!(fine.iter().all(|chunk| !exceeds_budget(
            &chunk.text,
            &ChunkConfig {
                max_chunk_chars: 200,
                min_chunk_chars: 20,
                ..ChunkConfig::default()
            }
        )));
    }

    #[test]
    fn statement_splits_large_functions_at_statement_boundaries() {
        let source = format!(
            "export function huge() {{\n  const first = \"{}\";\n  const second = \"{}\";\n  const third = \"{}\";\n  const fourth = \"{}\";\n  const fifth = \"{}\";\n}}\n",
            "a".repeat(70),
            "b".repeat(70),
            "c".repeat(70),
            "d".repeat(70),
            "e".repeat(70),
        );
        let config = ChunkConfig {
            target_token_budget: 0,
            max_chunk_chars: 120,
            min_chunk_chars: 20,
            ..ChunkConfig::default()
        };

        let chunks = chunk_file("huge.ts", "typescript", &source, &config)
            .unwrap_or_else(|err| panic!("{err}"));

        let fine: Vec<&Chunk> = fine_chunks(&chunks)
            .into_iter()
            .filter(|chunk| chunk.symbol_name.as_deref() == Some("huge"))
            .collect();

        assert!(fine.len() > 1);
        assert!(fine.iter().skip(1).all(|chunk| {
            let trimmed = chunk.text.trim_start();
            trimmed.starts_with("const second")
                || trimmed.starts_with("const third")
                || trimmed.starts_with("const fourth")
                || trimmed.starts_with("const fifth")
        }));
    }

    #[test]
    fn falls_back_to_line_splitting_for_single_enormous_statements() {
        clear_captured_logs();

        let repeated = "    \"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\",\n".repeat(24);
        let source = format!(
            "export function huge() {{\n  const value = [\n{}  ].join(\"\");\n}}\n",
            repeated
        );
        let config = ChunkConfig {
            target_token_budget: 0,
            max_chunk_chars: 120,
            min_chunk_chars: 20,
            ..ChunkConfig::default()
        };

        let chunks = chunk_file("huge.ts", "typescript", &source, &config)
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(fine_chunks(&chunks).len() > 1);
        assert!(captured_logs()
            .iter()
            .any(|message| message.contains("chunker force-split on line boundaries")));
    }

    #[test]
    fn falls_back_to_line_splitting_when_no_statement_body_is_identified() {
        clear_captured_logs();

        let repeated = (0..18)
            .map(|index| format!("  key{}: \"{}\"", index, "x".repeat(40)))
            .collect::<Vec<_>>()
            .join(",\n");
        let source = format!("export const BIG = {{\n{}\n}};\n", repeated);
        let config = ChunkConfig {
            target_token_budget: 0,
            max_chunk_chars: 120,
            min_chunk_chars: 20,
            ..ChunkConfig::default()
        };

        let chunks = chunk_file("big.ts", "typescript", &source, &config)
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(fine_chunks(&chunks).len() > 1);
        assert!(captured_logs()
            .iter()
            .any(|message| message.contains("chunker force-split on line boundaries")));
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

        let source = r#"import "./setup";
import "./polyfills";
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

    #[test]
    fn captures_exported_tool_constants_by_binding_name() {
        let source = r#"import { tool, type ToolDefinition } from "@opencode-ai/plugin";

export const find_similar: ToolDefinition = tool({
  description: "Find code similar to a given snippet.",
  args: {
    code: z.string().describe("The code snippet to find similar code for"),
  },
  async execute(args) {
    return args.code;
  },
});

export const codebase_search: ToolDefinition = tool({
  description: "Search codebase by meaning.",
  args: {
    query: z.string().describe("Natural language description of what code you're looking for."),
  },
  async execute(args) {
    return args.query;
  },
});
"#;

        let chunks = chunk_file("tools.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let find_similar = chunks
            .iter()
            .find(|chunk| {
                chunk.symbol_name.as_deref() == Some("find_similar")
                    && chunk.granularity == Granularity::Fine
            })
            .unwrap_or_else(|| panic!("missing find_similar chunk"));
        assert_eq!(find_similar.symbol_kind, Some(SymbolKind::Function));
        assert_eq!(find_similar.chunk_kind, ChunkKind::Code);
        assert!(find_similar.text.contains("export const find_similar"));

        let codebase_search = chunks
            .iter()
            .find(|chunk| {
                chunk.symbol_name.as_deref() == Some("codebase_search")
                    && chunk.granularity == Granularity::Fine
            })
            .unwrap_or_else(|| panic!("missing codebase_search chunk"));
        assert_eq!(codebase_search.symbol_kind, Some(SymbolKind::Function));
        assert_eq!(codebase_search.chunk_kind, ChunkKind::Code);
        assert!(codebase_search
            .text
            .contains("export const codebase_search"));

        assert!(!chunks.iter().any(|chunk| {
            chunk.symbol_name.as_deref() == Some("The code snippet to find similar code for")
                || chunk.symbol_name.as_deref()
                    == Some("Natural language description of what code you're looking for.")
        }));
    }

    #[test]
    fn does_not_treat_fluent_describe_calls_as_tests() {
        let source = r#"const schema = z.string().describe("schema description");
"#;

        let chunks = chunk_file("schema.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(!chunks
            .iter()
            .any(|chunk| chunk.chunk_kind == ChunkKind::Test));
        assert!(!chunks
            .iter()
            .any(|chunk| chunk.symbol_name.as_deref() == Some("schema description")));
    }

    #[test]
    fn captures_plain_exported_constants_without_module_fallback() {
        let source = r#"export const MAX_RETRIES = 3;
export const config = { key: "value" };
"#;

        let chunks = chunk_file(
            "constants.ts",
            "typescript",
            source,
            &ChunkConfig::default(),
        )
        .unwrap_or_else(|err| panic!("{err}"));

        let retries_chunk = named_fine_chunk(&chunks, "MAX_RETRIES");
        assert_eq!(retries_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(retries_chunk.chunk_kind, ChunkKind::Code);

        let config_chunk = named_fine_chunk(&chunks, "config");
        assert_eq!(config_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(config_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn still_detects_bare_describe_test_blocks() {
        let source = r#"describe("math helpers", () => {
  it("adds", () => {
    expect(1 + 1).toBe(2);
  });
});
"#;

        let chunks = chunk_file(
            "math.test.ts",
            "typescript",
            source,
            &ChunkConfig::default(),
        )
        .unwrap_or_else(|err| panic!("{err}"));

        let describe_chunk = chunks
            .iter()
            .find(|chunk| chunk.symbol_name.as_deref() == Some("math helpers"))
            .unwrap_or_else(|| panic!("missing describe test chunk"));
        assert_eq!(describe_chunk.chunk_kind, ChunkKind::Test);
        assert_eq!(describe_chunk.symbol_kind, Some(SymbolKind::Test));
    }

    #[test]
    fn captures_typescript_type_alias_declarations() {
        let source = r#"export type ButtonProps = {
  label: string;
  disabled?: boolean;
};
"#;

        let chunks = chunk_file("types.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let alias_chunk = named_fine_chunk(&chunks, "ButtonProps");
        assert_eq!(alias_chunk.symbol_kind, Some(SymbolKind::Type));
        assert_eq!(alias_chunk.chunk_kind, ChunkKind::Code);
        assert!(alias_chunk.text.contains("type ButtonProps"));
    }

    #[test]
    fn captures_typescript_enum_declarations() {
        let source = r#"export enum ButtonSize {
  Sm = "sm",
  Lg = "lg",
}
"#;

        let chunks = chunk_file("enum.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let enum_chunk = named_fine_chunk(&chunks, "ButtonSize");
        assert_eq!(enum_chunk.symbol_kind, Some(SymbolKind::Type));
        assert_eq!(enum_chunk.chunk_kind, ChunkKind::Code);
        assert!(chunks.iter().any(|chunk| {
            chunk.symbol_name.as_deref() == Some("ButtonSize")
                && chunk.granularity == Granularity::Coarse
        }));
    }

    #[test]
    fn captures_typescript_internal_modules() {
        let source = r#"namespace Accordion {
  export const Root = 1;
}
"#;

        let chunks = chunk_file(
            "namespace.ts",
            "typescript",
            source,
            &ChunkConfig::default(),
        )
        .unwrap_or_else(|err| panic!("{err}"));

        let namespace_chunk = chunks
            .iter()
            .find(|chunk| chunk.symbol_name.as_deref() == Some("Accordion"))
            .unwrap_or_else(|| panic!("missing Accordion namespace chunk"));
        assert_eq!(namespace_chunk.symbol_kind, Some(SymbolKind::Module));
        assert_eq!(namespace_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_export_clause_names() {
        let source = r#"export { Accordion, AccordionItem } from "./accordion";
"#;

        let chunks = chunk_file("barrel.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let export_chunk = named_fine_chunk(&chunks, "export{Accordion,AccordionItem}");
        assert_eq!(export_chunk.symbol_kind, Some(SymbolKind::Module));
    }

    #[test]
    fn truncates_long_export_clause_names() {
        let source = r#"export { Accordion, AccordionItem, AccordionTrigger, AccordionContent, AccordionHeader } from "./accordion";
"#;

        let chunks = chunk_file("barrel.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let export_chunk = named_fine_chunk(
            &chunks,
            "export{Accordion,AccordionItem,AccordionTrigger,...}",
        );
        assert_eq!(export_chunk.symbol_kind, Some(SymbolKind::Module));
    }

    #[test]
    fn classifies_forward_ref_wrappers_as_functions() {
        let source = r#"const Accordion = React.forwardRef((props, ref) => {
  return null;
});
"#;

        let chunks = chunk_file("component.tsx", "tsx", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let component_chunk = named_fine_chunk(&chunks, "Accordion");
        assert_eq!(component_chunk.symbol_kind, Some(SymbolKind::Function));
    }

    #[test]
    fn classifies_memo_wrappers_as_functions() {
        let source = r#"const MemoThing = React.memo(function MemoThingInner() {
  return null;
});
"#;

        let chunks = chunk_file("component.tsx", "tsx", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let memo_chunk = named_fine_chunk(&chunks, "MemoThing");
        assert_eq!(memo_chunk.symbol_kind, Some(SymbolKind::Function));
    }

    #[test]
    fn captures_member_expression_component_aliases() {
        let source = r#"const Accordion = AccordionPrimitive.Root;
"#;

        let chunks = chunk_file("component.tsx", "tsx", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let alias_chunk = named_fine_chunk(&chunks, "Accordion");
        assert_eq!(alias_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(alias_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn synthesizes_name_for_anonymous_default_exports() {
        let source = r#"export default () => {
  return 1;
};
"#;

        let chunks = chunk_file("default.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let default_chunk = named_fine_chunk(&chunks, "<default>");
        assert_eq!(default_chunk.symbol_kind, Some(SymbolKind::Function));
        assert_eq!(default_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn attaches_display_name_assignments_to_previous_component_chunk() {
        let source = r#"const AccordionItem = React.forwardRef((props, ref) => {
  return null;
});
AccordionItem.displayName = AccordionPrimitive.Item.displayName;
"#;

        let chunks = chunk_file("component.tsx", "tsx", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let component_chunk = named_fine_chunk(&chunks, "AccordionItem");
        assert!(component_chunk.text.contains("AccordionItem.displayName ="));
        assert!(!chunks
            .iter()
            .any(|chunk| { chunk.symbol_name.is_none() && chunk.text.contains("displayName") }));
    }

    #[test]
    fn captures_commonjs_exports_in_javascript() {
        let source = r#"module.exports = createApi();
exports.helper = helper;
"#;

        let chunks = chunk_file("index.js", "javascript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let module_exports = named_fine_chunk(&chunks, "<module.exports>");
        assert_eq!(module_exports.symbol_kind, Some(SymbolKind::Module));

        let helper_export = named_fine_chunk(&chunks, "helper");
        assert_eq!(helper_export.symbol_kind, Some(SymbolKind::Module));
    }

    #[test]
    fn classifies_exported_string_constants() {
        let source = r#"export const BASE_URL = "https://api.example.com";
"#;

        let chunks = chunk_file("config.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let constant_chunk = named_fine_chunk(&chunks, "BASE_URL");
        assert_eq!(constant_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(constant_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn classifies_exported_numeric_constants() {
        let source = r#"export const MAX_RETRIES = 3;
"#;

        let chunks = chunk_file("config.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let constant_chunk = named_fine_chunk(&chunks, "MAX_RETRIES");
        assert_eq!(constant_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(constant_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn classifies_nullish_coalescing_config_constants() {
        let source = r#"export const API_BASE_URL =
  import.meta.env.VITE_API_URL ?? "http://localhost:3001";
"#;

        let chunks = chunk_file("config.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let constant_chunk = named_fine_chunk(&chunks, "API_BASE_URL");
        assert_eq!(constant_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(constant_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn preserves_small_named_chunks_below_min_threshold() {
        let source = r#"export const X = "value";
"#;
        let config = ChunkConfig {
            target_token_budget: 512,
            max_chunk_chars: 2000,
            min_chunk_chars: 400,
            merge_small_siblings: true,
            attach_comments: true,
            emit_coarse_chunks: true,
        };

        let chunks = chunk_file("small-constant.ts", "typescript", source, &config)
            .unwrap_or_else(|err| panic!("{err}"));

        let fine: Vec<&Chunk> = fine_chunks(&chunks);
        assert_eq!(fine.len(), 1);
        assert_eq!(fine[0].symbol_name.as_deref(), Some("X"));
        assert_eq!(fine[0].symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(fine[0].chunk_kind, ChunkKind::Code);
        assert!(non_whitespace_len(&fine[0].text) < config.min_chunk_chars_usize());
    }

    #[test]
    fn emits_file_module_chunk_for_small_files() {
        let source = r#"export const ARCTIC_QUERY_PREFIX = "prefix";
export const VOYAGE_DEFAULT_MODEL_ID = "voyage-code-2";
"#;

        let chunks = chunk_file("provider.ts", "typescript", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let module_chunk = file_chunk(&chunks, "provider");
        assert_eq!(module_chunk.symbol_kind, Some(SymbolKind::Module));
        assert_eq!(module_chunk.granularity, Granularity::Coarse);
        assert_eq!(module_chunk.start_line, 1);
        assert_eq!(module_chunk.end_line, 2);
        assert_eq!(module_chunk.text, source);

        let arctic_chunk = named_fine_chunk(&chunks, "ARCTIC_QUERY_PREFIX");
        let voyage_chunk = named_fine_chunk(&chunks, "VOYAGE_DEFAULT_MODEL_ID");
        assert_eq!(arctic_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(voyage_chunk.symbol_kind, Some(SymbolKind::Constant));
    }

    #[test]
    fn does_not_emit_file_module_chunk_for_large_files_without_small_header() {
        let repeated = "  total += input.length;\n".repeat(120);
        let source = format!(
            "export function giant(input: string) {{\n  let total = 0;\n{repeated}  return total;\n}}\n"
        );

        let chunks = chunk_file("giant.ts", "typescript", &source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(!chunks.iter().any(|chunk| chunk.chunk_kind == ChunkKind::File));
    }

    #[test]
    fn emits_file_module_header_chunk_for_large_files_with_small_constant_preamble() {
        let repeated = "export function helper(value: string) { return value.repeat(4); }\n".repeat(80);
        let source = format!(
            "export const ARCTIC_QUERY_PREFIX = \"prefix\";\nexport const VOYAGE_DEFAULT_MODEL_ID = \"voyage-code-2\";\n{repeated}"
        );

        let chunks = chunk_file("provider.ts", "typescript", &source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let module_chunk = file_chunk(&chunks, "provider");
        assert_eq!(module_chunk.symbol_kind, Some(SymbolKind::Module));
        assert_eq!(module_chunk.granularity, Granularity::Coarse);
        assert!(module_chunk.text.contains("ARCTIC_QUERY_PREFIX"));
        assert!(module_chunk.text.contains("VOYAGE_DEFAULT_MODEL_ID"));
        assert!(module_chunk.end_line < source.lines().count() as u32);
        assert!(non_whitespace_len(&module_chunk.text) <= FILE_MODULE_CONTEXT_MAX_NON_WHITESPACE_CHARS);
    }

    #[test]
    fn preserves_small_unnamed_import_only_files_as_fallback_chunks() {
        let source = r#"import "./setup";
"#;
        let config = ChunkConfig {
            target_token_budget: 512,
            max_chunk_chars: 2000,
            min_chunk_chars: 400,
            merge_small_siblings: true,
            attach_comments: true,
            emit_coarse_chunks: true,
        };

        let chunks = chunk_file("imports.ts", "typescript", source, &config)
            .unwrap_or_else(|err| panic!("{err}"));

        let fine: Vec<&Chunk> = fine_chunks(&chunks);
        assert_eq!(fine.len(), 1);
        assert_eq!(fine[0].symbol_name, None);
        assert_eq!(fine[0].chunk_kind, ChunkKind::Code);
        assert!(fine[0].text.contains("import \"./setup\";"));
        assert!(non_whitespace_len(&fine[0].text) < config.min_chunk_chars_usize());
    }

    #[test]
    fn classifies_default_exported_object_literals_as_constants() {
        let source = r#"export default {
  theme: {},
};
"#;

        let chunks = chunk_file(
            "tailwind.config.ts",
            "typescript",
            source,
            &ChunkConfig::default(),
        )
        .unwrap_or_else(|err| panic!("{err}"));

        let default_chunk = named_fine_chunk(&chunks, "<default>");
        assert_eq!(default_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(default_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn classifies_default_exported_satisfies_objects_as_constants() {
        let source = r#"export default {
  theme: {},
} satisfies Config;
"#;

        let chunks = chunk_file(
            "tailwind.config.ts",
            "typescript",
            source,
            &ChunkConfig::default(),
        )
        .unwrap_or_else(|err| panic!("{err}"));

        let default_chunk = named_fine_chunk(&chunks, "<default>");
        assert_eq!(default_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(default_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn classifies_commonjs_object_literal_exports_as_constants() {
        let source = r#"module.exports = {
  plugins: [],
};
"#;

        let chunks = chunk_file(
            "postcss.config.js",
            "javascript",
            source,
            &ChunkConfig::default(),
        )
        .unwrap_or_else(|err| panic!("{err}"));

        let default_chunk = named_fine_chunk(&chunks, "<module.exports>");
        assert_eq!(default_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(default_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_java_records() {
        let source = r#"record Point(int x, int y) {}
"#;

        let chunks = chunk_file("Point.java", "java", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let record_chunk = named_fine_chunk(&chunks, "Point");
        assert_eq!(record_chunk.symbol_kind, Some(SymbolKind::Class));
        assert_eq!(record_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_java_static_initializers() {
        let source = r#"class Config {
  static { config = loadConfig(); }
}
"#;

        let chunks = chunk_file("Config.java", "java", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let init_chunk = named_fine_chunk(&chunks, "<static_init>");
        assert_eq!(init_chunk.symbol_kind, Some(SymbolKind::Block));
        assert_eq!(init_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_csharp_file_scoped_namespaces() {
        let source = r#"namespace Foo.Bar;

public class Example {}
"#;

        let chunks = chunk_file("Program.cs", "csharp", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let namespace_chunk = named_chunk(&chunks, "Foo.Bar");
        assert_eq!(namespace_chunk.symbol_kind, Some(SymbolKind::Module));
        assert_eq!(namespace_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_csharp_top_level_statements() {
        let source = r#"Console.WriteLine("hello");
"#;

        let chunks = chunk_file("Program.cs", "csharp", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let top_level_chunk = named_fine_chunk(&chunks, "<top-level>");
        assert_eq!(top_level_chunk.symbol_kind, Some(SymbolKind::Block));
        assert_eq!(top_level_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_csharp_indexers() {
        let source = r#"public class Items {
  public string this[int index] { get; set; }
}
"#;

        let chunks = chunk_file("Items.cs", "csharp", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let indexer_chunk = named_fine_chunk(&chunks, "this[]");
        assert_eq!(indexer_chunk.symbol_kind, Some(SymbolKind::Method));
        assert_eq!(indexer_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_ruby_attr_accessor_dsl_calls_inside_classes() {
        let source = r#"class User
  attr_accessor :name, :email
end
"#;

        let chunks = chunk_file("user.rb", "ruby", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let attr_chunk = named_fine_chunk(&chunks, "attr_accessor");
        assert_eq!(attr_chunk.symbol_kind, Some(SymbolKind::Block));
        assert_eq!(attr_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_ruby_association_dsl_calls_inside_classes() {
        let source = r#"class User
  has_many :posts
end
"#;

        let chunks = chunk_file("user.rb", "ruby", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let association_chunk = named_fine_chunk(&chunks, "has_many");
        assert_eq!(association_chunk.symbol_kind, Some(SymbolKind::Block));
        assert_eq!(association_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn ignores_ruby_dsl_calls_inside_method_bodies() {
        let source = r#"class User
  def configure
    has_many :posts
  end
end
"#;

        let chunks = chunk_file("user.rb", "ruby", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(!chunks
            .iter()
            .any(|chunk| chunk.symbol_name.as_deref() == Some("has_many")));
    }

    #[test]
    fn captures_ruby_include_calls_inside_classes() {
        let source = r#"class User
  include Comparable
end
"#;

        let chunks = chunk_file("user.rb", "ruby", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let include_chunk = named_fine_chunk(&chunks, "include");
        assert_eq!(include_chunk.symbol_kind, Some(SymbolKind::Block));
        assert_eq!(include_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_php_constants() {
        let source = r#"<?php
const FOO = 1;
"#;

        let chunks = chunk_file("constants.php", "php", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let const_chunk = named_fine_chunk(&chunks, "FOO");
        assert_eq!(const_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(const_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn captures_grouped_php_constants_without_anonymous_wrapper_gap_chunks() {
        let source = r#"<?php
const A = 1, B = 2;
"#;

        let chunks = chunk_file("constants.php", "php", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let a_chunk = named_fine_chunk(&chunks, "A");
        let b_chunk = named_fine_chunk(&chunks, "B");
        assert_eq!(a_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert_eq!(b_chunk.symbol_kind, Some(SymbolKind::Constant));
        assert!(!chunks.iter().any(|chunk| {
            chunk.symbol_name.is_none()
                && chunk.granularity == Granularity::Fine
                && chunk.text.contains("const A = 1, B = 2;")
        }));
    }

    #[test]
    fn captures_php_arrow_functions_assigned_to_variables() {
        let source = r#"<?php
$myFn = fn($x) => $x * 2;
"#;

        let chunks = chunk_file("functions.php", "php", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        let function_chunk = named_fine_chunk(&chunks, "myFn");
        assert_eq!(function_chunk.symbol_kind, Some(SymbolKind::Function));
        assert_eq!(function_chunk.chunk_kind, ChunkKind::Code);
    }

    #[test]
    fn ignores_php_arrow_functions_passed_as_arguments() {
        let source = r#"<?php
array_map(fn($x) => $x, $arr);
"#;

        let chunks = chunk_file("functions.php", "php", source, &ChunkConfig::default())
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(!chunks.iter().any(|chunk| {
            chunk.symbol_name.as_deref() == Some("fn")
                || chunk.text.contains("fn($x) => $x") && chunk.symbol_name.is_some()
        }));
    }
}
