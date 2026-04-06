use super::error::ChunkerError;
use super::log_warn;
use super::policy::{LanguagePolicy, SemanticInfo};
use super::{Chunk, ChunkConfig, ChunkKind, Granularity, SymbolKind};
use crate::hasher::xxhash_content;
use tree_sitter::{Node, Tree};

#[derive(Debug, Clone)]
struct PendingChunk {
    symbol_name: Option<String>,
    symbol_kind: Option<SymbolKind>,
    chunk_kind: ChunkKind,
    granularity: Granularity,
    start_byte: usize,
    end_byte: usize,
}

struct WalkerContext<'a> {
    file_path: &'a str,
    language: &'a str,
    source: &'a str,
    config: &'a ChunkConfig,
    policy: &'static LanguagePolicy,
    line_starts: Vec<usize>,
}

impl<'a> WalkerContext<'a> {
    fn line_for_byte(&self, byte: usize) -> u32 {
        match self.line_starts.binary_search(&byte) {
            Ok(index) => (index + 1) as u32,
            Err(index) => index as u32,
        }
    }

    fn slice(&self, start: usize, end: usize) -> Result<&str, ChunkerError> {
        self.source
            .get(start..end)
            .ok_or_else(|| ChunkerError::InvalidSlice {
                file_path: self.file_path.to_string(),
                start,
                end,
            })
    }

    fn is_whitespace_only(&self, start: usize, end: usize) -> bool {
        self.source
            .get(start..end)
            .map(|text| text.trim().is_empty())
            .unwrap_or(false)
    }

    fn finalize_chunk(&self, pending: PendingChunk) -> Result<Chunk, ChunkerError> {
        let text = self
            .slice(pending.start_byte, pending.end_byte)?
            .to_string();
        let end_line = if pending.end_byte == 0 {
            1
        } else {
            self.line_for_byte(pending.end_byte.saturating_sub(1))
                .max(1)
        };

        Ok(Chunk {
            file_path: self.file_path.to_string(),
            language: self.language.to_string(),
            symbol_name: pending.symbol_name,
            symbol_kind: pending.symbol_kind,
            chunk_kind: pending.chunk_kind,
            granularity: pending.granularity,
            start_byte: pending.start_byte as u32,
            end_byte: pending.end_byte as u32,
            start_line: self.line_for_byte(pending.start_byte).max(1),
            end_line,
            chunk_hash: xxhash_content(&text),
            text,
        })
    }
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

fn classify(policy: &'static LanguagePolicy, node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    (policy.classify_node)(node, source)
}

fn attached_start(ctx: &WalkerContext<'_>, node: Node<'_>) -> usize {
    if !ctx.config.attach_comments {
        return node.start_byte();
    }

    let mut start = node.start_byte();
    let mut cursor = node.prev_named_sibling();
    while let Some(sibling) = cursor {
        if !(ctx.policy.is_comment_kind)(sibling.kind()) {
            break;
        }
        start = sibling.start_byte();
        cursor = sibling.prev_named_sibling();
    }
    start
}

fn collect_split_children<'tree>(
    ctx: &WalkerContext<'_>,
    node: Node<'tree>,
    results: &mut Vec<Node<'tree>>,
) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if classify(ctx.policy, child, ctx.source).is_some() {
            results.push(child);
        } else {
            collect_split_children(ctx, child, results);
        }
    }
}

fn count_semantic_units(ctx: &WalkerContext<'_>, node: Node<'_>) -> usize {
    let mut count = usize::from(classify(ctx.policy, node, ctx.source).is_some());
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        count += count_semantic_units(ctx, child);
    }
    count
}

fn find_split_children<'tree>(ctx: &WalkerContext<'_>, node: Node<'tree>) -> Vec<Node<'tree>> {
    let mut children = Vec::new();
    collect_split_children(ctx, node, &mut children);
    children
}

fn emit_gap(ctx: &WalkerContext<'_>, start: usize, end: usize, chunks: &mut Vec<PendingChunk>) {
    if start >= end {
        return;
    }

    if ctx.is_whitespace_only(start, end) {
        if let Some(last) = chunks.last_mut() {
            last.end_byte = end;
        }
        return;
    }

    chunks.push(PendingChunk {
        symbol_name: None,
        symbol_kind: Some(SymbolKind::Block),
        chunk_kind: ChunkKind::Code,
        granularity: Granularity::Fine,
        start_byte: start,
        end_byte: end,
    });
}

fn merge_small_siblings(ctx: &WalkerContext<'_>, chunks: &mut Vec<PendingChunk>) {
    if !ctx.config.merge_small_siblings || chunks.len() < 2 {
        return;
    }

    let mut merged = Vec::with_capacity(chunks.len());
    let mut index = 0usize;

    while index < chunks.len() {
        let mut current = chunks[index].clone();

        while index + 1 < chunks.len() {
            let next = &chunks[index + 1];
            let current_len = current.end_byte.saturating_sub(current.start_byte);
            let next_len = next.end_byte.saturating_sub(next.start_byte);
            let combined_len = next.end_byte.saturating_sub(current.start_byte);

            let is_small = current_len + next_len < ctx.config.min_chunk_chars_usize();
            let is_mergeable = current.symbol_name.is_none()
                && next.symbol_name.is_none()
                && combined_len <= ctx.config.max_chunk_chars_usize();

            if !is_small || !is_mergeable {
                break;
            }

            current.end_byte = next.end_byte;
            current.symbol_kind = Some(SymbolKind::Block);
            current.chunk_kind = ChunkKind::Code;
            index += 1;
        }

        merged.push(current);
        index += 1;
    }

    *chunks = merged;
}

fn build_semantic_chunk(
    ctx: &WalkerContext<'_>,
    node: Node<'_>,
    info: SemanticInfo,
) -> Vec<PendingChunk> {
    let node_start = attached_start(ctx, node);
    let node_end = node.end_byte();
    let node_len = node_end.saturating_sub(node_start);
    let split_children = find_split_children(ctx, node);
    let should_prefer_children = info.coarse_eligible && !split_children.is_empty();

    if node_len <= ctx.config.max_chunk_chars_usize() && !should_prefer_children {
        return vec![PendingChunk {
            symbol_name: info.symbol_name,
            symbol_kind: info.symbol_kind,
            chunk_kind: info.chunk_kind,
            granularity: Granularity::Fine,
            start_byte: node_start,
            end_byte: node_end,
        }];
    }

    if split_children.is_empty() {
        return vec![PendingChunk {
            symbol_name: info.symbol_name,
            symbol_kind: info.symbol_kind,
            chunk_kind: info.chunk_kind,
            granularity: Granularity::Fine,
            start_byte: node_start,
            end_byte: node_end,
        }];
    }

    let mut chunks = Vec::new();
    let mut cursor = node_start;

    for child in split_children {
        let child_chunks = build_node_chunks(ctx, child);
        if child_chunks.is_empty() {
            continue;
        }

        let mut child_chunks = child_chunks;
        let first_start = child_chunks[0].start_byte;

        if cursor < first_start {
            if ctx.is_whitespace_only(cursor, first_start) {
                child_chunks[0].start_byte = cursor;
            } else {
                emit_gap(ctx, cursor, first_start, &mut chunks);
            }
        }

        let child_end = child_chunks
            .last()
            .map(|chunk| chunk.end_byte)
            .unwrap_or(first_start);

        chunks.extend(child_chunks);
        cursor = child_end;
    }

    if cursor < node_end {
        emit_gap(ctx, cursor, node_end, &mut chunks);
    }

    merge_small_siblings(ctx, &mut chunks);
    chunks
}

fn floor_char_boundary(source: &str, mut index: usize) -> usize {
    if index >= source.len() {
        return source.len();
    }

    while index > 0 && !source.is_char_boundary(index) {
        index -= 1;
    }

    index
}

fn split_chunk_at_line_boundaries(
    ctx: &WalkerContext<'_>,
    chunk: &Chunk,
) -> Result<Vec<Chunk>, ChunkerError> {
    let max_len = ctx.config.max_chunk_chars_usize();
    if chunk.text.len() <= max_len || chunk.granularity != Granularity::Fine {
        return Ok(vec![chunk.clone()]);
    }

    log_warn(format!(
        "chunker force-split on line boundaries file_path={} language={} chunk_size={} max_chunk_chars={} symbol_name={}",
        ctx.file_path,
        ctx.language,
        chunk.text.len(),
        max_len,
        chunk.symbol_name.as_deref().unwrap_or("<anonymous>")
    ));

    let start = chunk.start_byte as usize;
    let end = chunk.end_byte as usize;
    let mut segments = Vec::new();
    let mut segment_start = start;

    while segment_start < end {
        let max_end = floor_char_boundary(ctx.source, (segment_start + max_len).min(end));
        let mut segment_end = ctx
            .line_starts
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
                file_path: ctx.file_path.to_string(),
                language: ctx.language.to_string(),
                chunk_len: chunk.text.len(),
                max_len,
            });
        }

        let pending = PendingChunk {
            symbol_name: chunk.symbol_name.clone(),
            symbol_kind: chunk.symbol_kind.clone(),
            chunk_kind: chunk.chunk_kind.clone(),
            granularity: Granularity::Fine,
            start_byte: segment_start,
            end_byte: segment_end,
        };

        let finalized = ctx.finalize_chunk(pending)?;
        if finalized.text.len() > max_len {
            return Err(ChunkerError::ChunkTooLarge {
                file_path: ctx.file_path.to_string(),
                language: ctx.language.to_string(),
                chunk_len: finalized.text.len(),
                max_len,
            });
        }

        segments.push(finalized);
        segment_start = segment_end;
    }

    Ok(segments)
}

fn enforce_fine_chunk_max_size(
    ctx: &WalkerContext<'_>,
    chunks: Vec<Chunk>,
) -> Result<Vec<Chunk>, ChunkerError> {
    let mut result = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        if chunk.granularity == Granularity::Fine
            && chunk.text.len() > ctx.config.max_chunk_chars_usize()
        {
            result.extend(split_chunk_at_line_boundaries(ctx, &chunk)?);
        } else {
            result.push(chunk);
        }
    }
    Ok(result)
}

fn build_node_chunks(ctx: &WalkerContext<'_>, node: Node<'_>) -> Vec<PendingChunk> {
    if let Some(info) = classify(ctx.policy, node, ctx.source) {
        return build_semantic_chunk(ctx, node, info);
    }

    let split_children = find_split_children(ctx, node);
    if split_children.is_empty() {
        return vec![PendingChunk {
            symbol_name: None,
            symbol_kind: Some(SymbolKind::Block),
            chunk_kind: ChunkKind::Code,
            granularity: Granularity::Fine,
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
        }];
    }

    let mut chunks = Vec::new();
    let mut cursor = node.start_byte();

    for child in split_children {
        let child_chunks = build_node_chunks(ctx, child);
        if child_chunks.is_empty() {
            continue;
        }

        let mut child_chunks = child_chunks;
        let first_start = child_chunks[0].start_byte;

        if cursor < first_start {
            if ctx.is_whitespace_only(cursor, first_start) {
                child_chunks[0].start_byte = cursor;
            } else {
                emit_gap(ctx, cursor, first_start, &mut chunks);
            }
        }

        let child_end = child_chunks
            .last()
            .map(|chunk| chunk.end_byte)
            .unwrap_or(first_start);

        chunks.extend(child_chunks);
        cursor = child_end;
    }

    if cursor < node.end_byte() {
        emit_gap(ctx, cursor, node.end_byte(), &mut chunks);
    }

    merge_small_siblings(ctx, &mut chunks);
    chunks
}

fn top_level_semantic_nodes<'tree>(
    ctx: &WalkerContext<'_>,
    root: Node<'tree>,
) -> Vec<(Node<'tree>, SemanticInfo)> {
    let mut nodes = Vec::new();
    let mut cursor = root.walk();
    for child in root.named_children(&mut cursor) {
        if let Some(info) = classify(ctx.policy, child, ctx.source) {
            nodes.push((child, info));
        }
    }
    nodes
}

pub fn chunk_tree(
    file_path: &str,
    language: &str,
    source: &str,
    config: &ChunkConfig,
    policy: &'static LanguagePolicy,
    tree: &Tree,
) -> Result<Vec<Chunk>, ChunkerError> {
    if source.is_empty() {
        return Ok(Vec::new());
    }

    let ctx = WalkerContext {
        file_path,
        language,
        source,
        config,
        policy,
        line_starts: build_line_index(source),
    };

    let root = tree.root_node();
    let semantic_unit_count = count_semantic_units(&ctx, root);
    if semantic_unit_count == 0 {
        log_warn(format!(
            "chunker found no semantic units for supported language file_path={} language={} root_kind={}",
            file_path,
            language,
            root.kind()
        ));
    }

    let mut pending = build_node_chunks(&ctx, root);
    pending.sort_by_key(|chunk| (chunk.start_byte, chunk.end_byte, chunk.granularity as u8));

    let mut chunks = Vec::with_capacity(pending.len());
    for chunk in pending {
        chunks.push(ctx.finalize_chunk(chunk)?);
    }
    let mut chunks = enforce_fine_chunk_max_size(&ctx, chunks)?;

    if config.emit_coarse_chunks {
        for (node, info) in top_level_semantic_nodes(&ctx, root) {
            if !info.coarse_eligible {
                continue;
            }

            let pending = PendingChunk {
                symbol_name: info.symbol_name,
                symbol_kind: info.symbol_kind,
                chunk_kind: info.chunk_kind,
                granularity: Granularity::Coarse,
                start_byte: attached_start(&ctx, node),
                end_byte: node.end_byte(),
            };
            chunks.push(ctx.finalize_chunk(pending)?);
        }
    }

    chunks.sort_by(|a, b| {
        a.start_byte
            .cmp(&b.start_byte)
            .then_with(|| a.end_byte.cmp(&b.end_byte))
            .then_with(|| a.granularity.cmp(&b.granularity))
    });

    Ok(chunks)
}
