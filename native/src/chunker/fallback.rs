use super::{Chunk, ChunkConfig, ChunkKind, Granularity};
use crate::hasher::xxhash_content;

fn line_starts(source: &str) -> Vec<usize> {
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

pub fn chunk_by_lines(
    file_path: &str,
    language: &str,
    source: &str,
    config: &ChunkConfig,
) -> Vec<Chunk> {
    if source.is_empty() {
        return Vec::new();
    }

    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    if lines.is_empty() {
        return vec![Chunk {
            file_path: file_path.to_string(),
            language: language.to_string(),
            symbol_name: None,
            symbol_kind: None,
            chunk_kind: ChunkKind::Code,
            granularity: Granularity::Fine,
            start_byte: 0,
            end_byte: source.len() as u32,
            start_line: 1,
            end_line: 1,
            text: source.to_string(),
            chunk_hash: xxhash_content(source),
        }];
    }

    let starts = line_starts(source);
    let mut chunks = Vec::new();
    let mut start_line_index = 0usize;

    while start_line_index < lines.len() {
        let mut end_line_index = start_line_index;
        let mut char_count = 0usize;

        while end_line_index < lines.len() {
            let next_len = lines[end_line_index].len();
            if end_line_index > start_line_index
                && char_count + next_len > config.max_chunk_chars_usize()
            {
                break;
            }
            char_count += next_len;
            end_line_index += 1;
        }

        if end_line_index == start_line_index {
            end_line_index += 1;
        }

        let start_byte = starts[start_line_index];
        let end_byte = if end_line_index < starts.len() {
            starts[end_line_index]
        } else {
            source.len()
        };

        if let Some(text) = source.get(start_byte..end_byte) {
            chunks.push(Chunk {
                file_path: file_path.to_string(),
                language: language.to_string(),
                symbol_name: None,
                symbol_kind: None,
                chunk_kind: ChunkKind::Code,
                granularity: Granularity::Fine,
                start_byte: start_byte as u32,
                end_byte: end_byte as u32,
                start_line: line_for_byte(&starts, start_byte),
                end_line: line_for_byte(&starts, end_byte.saturating_sub(1)).max(1),
                text: text.to_string(),
                chunk_hash: xxhash_content(text),
            });
        }

        let emitted_lines = end_line_index.saturating_sub(start_line_index);
        let overlap_lines = ((emitted_lines as f32) * 0.12f32).round() as usize;
        let step = emitted_lines.saturating_sub(overlap_lines).max(1);
        start_line_index = start_line_index.saturating_add(step);
    }

    chunks
}
