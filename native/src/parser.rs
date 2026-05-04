use crate::chunker::{chunk_file, ChunkConfig, ChunkKind, Granularity, SymbolKind};
use crate::types::Language;
use crate::{CodeChunk, FileInput, ParsedFile};
use anyhow::{anyhow, Result};
use rayon::prelude::*;
use std::path::Path;

#[deprecated(
    note = "Lossy compatibility path: drops symbol_kind, chunk_kind, granularity, byte spans, and chunk_hash. Use chunk_file() directly instead. This will be removed in Phase 2."
)]
pub fn parse_file_internal(file_path: &str, content: &str) -> Result<Vec<CodeChunk>> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let language = Language::from_extension(ext);

    let chunks = chunk_file(
        file_path,
        language.as_str(),
        content,
        &ChunkConfig::default(),
    )
    .map_err(|err| anyhow!("Failed to chunk file {}: {}", file_path, err))?;

    Ok(chunks
        .into_iter()
        .filter(|chunk| chunk.granularity == Granularity::Fine)
        .map(map_chunk)
        .collect())
}

#[deprecated(
    note = "Lossy compatibility path: drops symbol_kind, chunk_kind, granularity, byte spans, and chunk_hash. Use chunk_file() directly instead. This will be removed in Phase 2."
)]
pub fn parse_files_parallel(files: Vec<FileInput>) -> Result<Vec<ParsedFile>> {
    let results: Vec<ParsedFile> = files
        .par_iter()
        .filter_map(|file| {
            let chunks = parse_file_internal(&file.path, &file.content).ok()?;
            let hash = crate::hasher::xxhash_content(&file.content);
            Some(ParsedFile {
                path: file.path.clone(),
                chunks,
                hash,
            })
        })
        .collect();

    Ok(results)
}

fn map_chunk(chunk: crate::chunker::Chunk) -> CodeChunk {
    let chunk_type = match chunk.symbol_kind {
        Some(SymbolKind::Function) | Some(SymbolKind::Test) => "function",
        Some(SymbolKind::Method) => "method",
        Some(SymbolKind::Class) => "class",
        Some(SymbolKind::Interface) => "interface",
        Some(SymbolKind::Struct) => "struct",
        Some(SymbolKind::Type) => "type",
        Some(SymbolKind::Module) => "module",
        Some(SymbolKind::Constant) | Some(SymbolKind::Block) | None => match chunk.chunk_kind {
            ChunkKind::Test => "function",
            ChunkKind::Code | ChunkKind::Doc | ChunkKind::Config | ChunkKind::File => "other",
        },
    }
    .to_string();

    CodeChunk {
        content: chunk.text,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        chunk_type,
        name: chunk.symbol_name,
        language: chunk.language,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typescript_chunks() {
        let content = r#"
export function validateEmail(email: string): boolean {
  return email.includes("@");
}

export async function fetchUser(id: number): Promise<User> {
  return await db.query(id);
}
"#;

        let chunks = parse_file_internal("test.ts", content).unwrap_or_else(|err| panic!("{err}"));

        assert!(chunks.len() >= 2);
        assert!(chunks
            .iter()
            .any(|chunk| chunk.name.as_deref() == Some("validateEmail")));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.name.as_deref() == Some("fetchUser")));
    }

    #[test]
    fn parses_python_tests() {
        let content = r#"
class TestMath:
    def test_add(self):
        assert 1 + 1 == 2
"#;

        let chunks = parse_file_internal("test.py", content).unwrap_or_else(|err| panic!("{err}"));

        assert!(chunks
            .iter()
            .any(|chunk| chunk.name.as_deref() == Some("test_add")));
    }

    #[test]
    fn falls_back_for_unknown_files() {
        let chunks = parse_file_internal("notes.txt", "alpha\nbeta\ngamma")
            .unwrap_or_else(|err| panic!("{err}"));

        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|chunk| chunk.chunk_type == "other"));
    }
}
