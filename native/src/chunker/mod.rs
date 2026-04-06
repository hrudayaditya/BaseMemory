pub mod error;
pub mod fallback;
pub mod languages;
pub mod policy;
pub mod walker;

use crate::types::Language;
use error::ChunkerError;
use fallback::chunk_by_lines;
use napi_derive::napi;
use policy::get_policy;
use serde::{Deserialize, Serialize};
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

pub fn chunk_file(
    file_path: &str,
    language: &str,
    source_code: &str,
    config: &ChunkConfig,
) -> Result<Vec<Chunk>, ChunkerError> {
    let normalized_language = normalize_language(file_path, language);
    let Some(policy) = get_policy(&normalized_language) else {
        return Ok(chunk_by_lines(
            file_path,
            &normalized_language,
            source_code,
            config,
        ));
    };

    let mut parser = Parser::new();
    let parser_language = (policy.parser_language)();
    parser
        .set_language(&parser_language)
        .map_err(|_| ChunkerError::ParserUnavailable {
            language: normalized_language.clone(),
        })?;

    let Some(tree) = parser.parse(source_code, None) else {
        return Err(ChunkerError::ParseFailed {
            file_path: file_path.to_string(),
        });
    };

    walker::chunk_tree(
        file_path,
        policy.language_name,
        source_code,
        config,
        policy,
        &tree,
    )
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
}
