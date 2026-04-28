use super::error::ChunkerError;
use super::languages::typescript::{is_registration_statement, registration_chunk_kind};
use super::log_warn;
use super::policy::{LanguagePolicy, SemanticInfo};
use super::{
    exceeds_budget, file_module_symbol_name, non_whitespace_len, Chunk, ChunkConfig, ChunkKind,
    Granularity, SymbolKind, FILE_MODULE_CONTEXT_MAX_NON_WHITESPACE_CHARS,
};
use crate::hasher::xxhash_content;
use tree_sitter::{Node, Parser, Tree};

#[derive(Debug, Clone)]
struct PendingChunk {
    symbol_name: Option<String>,
    symbol_aliases: Vec<String>,
    symbol_kind: Option<SymbolKind>,
    chunk_kind: ChunkKind,
    delegate_target_name: Option<String>,
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

struct RustMacroRange {
    macro_start: usize,
    macro_end: usize,
    body_start: usize,
    body_end: usize,
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
            symbol_aliases: pending.symbol_aliases,
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

    fn range_non_whitespace_len(&self, start: usize, end: usize) -> usize {
        self.source
            .get(start..end)
            .map(non_whitespace_len)
            .unwrap_or(usize::MAX)
    }

    fn range_exceeds_budget(&self, start: usize, end: usize) -> bool {
        self.source
            .get(start..end)
            .map(|text| exceeds_budget(text, self.config))
            .unwrap_or(true)
    }

    fn range_exceeds_hard_max(&self, start: usize, end: usize) -> bool {
        self.range_non_whitespace_len(start, end) > self.config.max_chunk_chars_usize()
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

fn is_go_transparent_declaration_container(language: &str, node: Node<'_>) -> bool {
    language == "go"
        && matches!(
            node.kind(),
            "const_declaration" | "var_declaration" | "type_declaration"
        )
}

fn go_container_keyword(container_kind: &str) -> Option<&'static str> {
    match container_kind {
        "const_declaration" => Some("const"),
        "var_declaration" => Some("var"),
        "type_declaration" => Some("type"),
        _ => None,
    }
}

fn go_container_wrapper_start(text: &str, keyword: &str) -> Option<usize> {
    let start = text.rfind(keyword)?;
    let wrapper = &text[start..];
    let rest = wrapper[keyword.len()..].trim();
    if rest.is_empty() || rest == "(" {
        Some(start)
    } else {
        None
    }
}

fn try_absorb_go_declaration_prefix(
    ctx: &WalkerContext<'_>,
    start: usize,
    end: usize,
    chunks: &mut Vec<PendingChunk>,
    first_child: &mut PendingChunk,
) -> bool {
    if ctx.language != "go" || start >= end {
        return false;
    }

    let Ok(text) = ctx.slice(start, end) else {
        return false;
    };
    let keywords: &[&str] = match first_child.symbol_kind {
        Some(SymbolKind::Constant) => &["const", "var"],
        Some(SymbolKind::Type | SymbolKind::Struct | SymbolKind::Interface) => &["type"],
        _ => return false,
    };

    for keyword in keywords {
        if let Some(wrapper_offset) = go_container_wrapper_start(text, keyword) {
            let wrapper_start = start + wrapper_offset;
            if start < wrapper_start {
                emit_gap(ctx, start, wrapper_start, chunks);
            }
            first_child.start_byte = wrapper_start;
            return true;
        }
    }

    false
}

fn try_absorb_go_container_leading_gap(
    ctx: &WalkerContext<'_>,
    container: Node<'_>,
    start: usize,
    end: usize,
    chunks: &mut Vec<PendingChunk>,
    first_child: &mut PendingChunk,
) -> bool {
    if !is_go_transparent_declaration_container(ctx.language, container) || start >= end {
        return false;
    }

    let Some(keyword) = go_container_keyword(container.kind()) else {
        return false;
    };
    let Ok(text) = ctx.slice(start, end) else {
        return false;
    };
    let Some(wrapper_offset) = go_container_wrapper_start(text, keyword) else {
        return false;
    };

    let wrapper_start = start + wrapper_offset;
    if start < wrapper_start {
        emit_gap(ctx, start, wrapper_start, chunks);
    }

    first_child.start_byte = wrapper_start;
    true
}

fn try_absorb_go_container_trailing_gap(
    ctx: &WalkerContext<'_>,
    container: Node<'_>,
    start: usize,
    end: usize,
    chunks: &mut [PendingChunk],
) -> bool {
    if !is_go_transparent_declaration_container(ctx.language, container) || start >= end {
        return false;
    }

    let Ok(text) = ctx.slice(start, end) else {
        return false;
    };
    if text.trim() != ")" {
        return false;
    }

    let Some(last) = chunks.last_mut() else {
        return false;
    };
    last.end_byte = end;
    true
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
        if is_suppressed_js_constructor_method(ctx, child) {
            continue;
        }

        if classify(ctx.policy, child, ctx.source).is_some()
            || is_go_transparent_declaration_container(ctx.language, child)
        {
            results.push(child);
        } else {
            collect_split_children(ctx, child, results);
        }
    }
}

fn is_suppressed_js_constructor_method(ctx: &WalkerContext<'_>, node: Node<'_>) -> bool {
    if !is_js_like_language(ctx.language) || node.kind() != "method_definition" {
        return false;
    }

    node.child_by_field_name("name")
        .and_then(|name| ctx.slice(name.start_byte(), name.end_byte()).ok())
        .map(str::trim)
        == Some("constructor")
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
        symbol_aliases: Vec::new(),
        symbol_kind: Some(SymbolKind::Block),
        chunk_kind: ChunkKind::Code,
        delegate_target_name: None,
        granularity: Granularity::Fine,
        start_byte: start,
        end_byte: end,
    });
}

fn is_js_like_language(language: &str) -> bool {
    matches!(language, "typescript" | "tsx" | "javascript" | "jsx")
}

fn supports_semantic_parent_header_gap(language: &str) -> bool {
    is_js_like_language(language) || language == "python"
}

fn is_python_function_symbol(symbol_kind: Option<SymbolKind>) -> bool {
    matches!(
        symbol_kind,
        Some(SymbolKind::Function) | Some(SymbolKind::Method) | Some(SymbolKind::Test)
    )
}

fn capped_python_header_end(ctx: &WalkerContext<'_>, start: usize, end: usize) -> usize {
    let max_chars = ctx.config.max_chunk_chars_usize().max(1);
    let Some(text) = ctx.source.get(start..end) else {
        return end;
    };

    let mut non_whitespace = 0usize;
    let mut boundary = start;
    for (offset, ch) in text.char_indices() {
        if !ch.is_whitespace() {
            non_whitespace += 1;
            if non_whitespace > max_chars {
                break;
            }
        }
        boundary = start + offset + ch.len_utf8();
    }

    boundary.max(start).min(end)
}

fn extract_display_name_target(node: Node<'_>, source: &str) -> Option<String> {
    if node.kind() != "expression_statement" {
        return None;
    }

    let assignment = {
        let mut cursor = node.walk();
        let assignment = node
            .named_children(&mut cursor)
            .find(|child| child.kind() == "assignment_expression");
        assignment
    }?;
    if assignment.kind() != "assignment_expression" {
        return None;
    }

    let left = assignment.child_by_field_name("left")?;
    if left.kind() != "member_expression" {
        return None;
    }

    let property = left.child_by_field_name("property")?;
    let property_name = source
        .get(property.start_byte()..property.end_byte())?
        .trim();
    if property_name != "displayName" {
        return None;
    }

    let object = left.child_by_field_name("object")?;
    if object.kind() != "identifier" {
        return None;
    }

    let object_name = source.get(object.start_byte()..object.end_byte())?.trim();
    if object_name.is_empty() {
        return None;
    }

    Some(object_name.to_string())
}

fn try_attach_display_name_gap(
    ctx: &WalkerContext<'_>,
    container: Node<'_>,
    start: usize,
    end: usize,
    chunks: &mut Vec<PendingChunk>,
) -> bool {
    if !is_js_like_language(ctx.language) || start >= end {
        return false;
    }

    let Some(last) = chunks.last_mut() else {
        return false;
    };
    let Some(symbol_name) = last.symbol_name.as_deref() else {
        return false;
    };

    let mut found_attachment = false;
    let mut cursor = container.walk();
    for child in container.named_children(&mut cursor) {
        if child.start_byte() < start || child.end_byte() > end {
            continue;
        }

        if (ctx.policy.is_comment_kind)(child.kind()) {
            continue;
        }

        if let Some(target_name) = extract_display_name_target(child, ctx.source) {
            if target_name == symbol_name {
                if found_attachment {
                    return false;
                }
                found_attachment = true;
                continue;
            }
        }

        return false;
    }

    if !found_attachment {
        return false;
    }

    last.end_byte = end;
    true
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
            if current.symbol_name.is_some() || next.symbol_name.is_some() {
                break;
            }
            let current_len = ctx.range_non_whitespace_len(current.start_byte, current.end_byte);
            let next_len = ctx.range_non_whitespace_len(next.start_byte, next.end_byte);
            let combined_len = ctx.range_non_whitespace_len(current.start_byte, next.end_byte);

            let is_small = current_len + next_len < ctx.config.min_chunk_chars_usize();
            let is_gap_like = |chunk: &PendingChunk| {
                chunk.symbol_name.is_none()
                    && matches!(chunk.chunk_kind, ChunkKind::Code)
                    && matches!(chunk.symbol_kind, None | Some(SymbolKind::Block))
            };
            let is_mergeable = is_gap_like(&current)
                && is_gap_like(next)
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

fn is_gap_only_chunk(chunk: &PendingChunk) -> bool {
    chunk.symbol_name.is_none()
        && chunk.symbol_aliases.is_empty()
        && chunk.delegate_target_name.is_none()
        && matches!(chunk.chunk_kind, ChunkKind::Code)
        && matches!(chunk.symbol_kind, None | Some(SymbolKind::Block))
}

fn push_symbol_alias(aliases: &mut Vec<String>, alias: String) {
    if alias.is_empty() || aliases.iter().any(|existing| existing == &alias) {
        return;
    }
    aliases.push(alias);
}

fn merge_delegation_wrappers(chunks: &mut Vec<PendingChunk>) {
    if chunks.len() < 2 {
        return;
    }

    let mut index = 0usize;
    while index < chunks.len() {
        let Some(target_name) = chunks[index].delegate_target_name.clone() else {
            index += 1;
            continue;
        };

        let mut lookahead = index + 1;
        let mut merge_target_index = None;
        while lookahead < chunks.len() {
            if chunks[lookahead].symbol_name.is_some() {
                if chunks[lookahead].symbol_name.as_deref() == Some(target_name.as_str()) {
                    merge_target_index = Some(lookahead);
                }
                break;
            }

            if !is_gap_only_chunk(&chunks[lookahead]) {
                break;
            }

            lookahead += 1;
        }

        let Some(target_index) = merge_target_index else {
            index += 1;
            continue;
        };

        let wrapper_start = chunks[index].start_byte;
        let wrapper_symbol_name = chunks[index].symbol_name.clone();
        let wrapper_symbol_aliases = chunks[index].symbol_aliases.clone();
        let target_symbol_name = chunks[target_index].symbol_name.clone();
        chunks[target_index].start_byte = wrapper_start;
        chunks[target_index].symbol_name = wrapper_symbol_name;
        for alias in wrapper_symbol_aliases {
            push_symbol_alias(&mut chunks[target_index].symbol_aliases, alias);
        }
        if let Some(target_symbol_name) = target_symbol_name {
            push_symbol_alias(&mut chunks[target_index].symbol_aliases, target_symbol_name);
        }
        chunks.drain(index..target_index);
        index += 1;
    }
}

fn is_statement_container_kind(kind: &str) -> bool {
    kind.contains("body") || kind.contains("block") || kind == "declaration_list"
}

fn find_statement_container(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    let children: Vec<Node<'_>> = node.named_children(&mut cursor).collect();
    children.into_iter().rev().find(|child| {
        child.end_byte() == node.end_byte()
            && is_statement_container_kind(child.kind())
            && child.named_child_count() > 0
    })
}

fn split_oversized_leaf_node_by_statements(
    ctx: &WalkerContext<'_>,
    node: Node<'_>,
    template: &PendingChunk,
) -> Option<Vec<PendingChunk>> {
    let container = find_statement_container(node)?;
    let mut cursor = container.walk();
    let statements: Vec<Node<'_>> = container.named_children(&mut cursor).collect();
    if statements.len() < 2 {
        return None;
    }

    let mut chunks = Vec::new();
    let mut group_start = template.start_byte;
    let mut first_statement_index = 0usize;

    for (index, statement) in statements.iter().enumerate() {
        let candidate_end = statements
            .get(index + 1)
            .map(|next| next.start_byte())
            .unwrap_or(template.end_byte);

        if index > first_statement_index && ctx.range_exceeds_budget(group_start, candidate_end) {
            let chunk_kind = classify_statement_group_kind(
                ctx,
                &statements[first_statement_index..index],
                &template.chunk_kind,
            );
            chunks.push(PendingChunk {
                symbol_name: template.symbol_name.clone(),
                symbol_aliases: template.symbol_aliases.clone(),
                symbol_kind: if chunk_kind == ChunkKind::Config {
                    Some(SymbolKind::Block)
                } else {
                    template.symbol_kind.clone()
                },
                chunk_kind,
                delegate_target_name: template.delegate_target_name.clone(),
                granularity: template.granularity.clone(),
                start_byte: group_start,
                end_byte: statement.start_byte(),
            });
            group_start = statement.start_byte();
            first_statement_index = index;
        }
    }

    let final_chunk_kind =
        classify_statement_group_kind(ctx, &statements[first_statement_index..], &template.chunk_kind);
    let final_chunk = PendingChunk {
        symbol_name: template.symbol_name.clone(),
        symbol_aliases: template.symbol_aliases.clone(),
        symbol_kind: if final_chunk_kind == ChunkKind::Config {
            Some(SymbolKind::Block)
        } else {
            template.symbol_kind.clone()
        },
        chunk_kind: final_chunk_kind,
        delegate_target_name: template.delegate_target_name.clone(),
        granularity: template.granularity.clone(),
        start_byte: group_start,
        end_byte: template.end_byte,
    };

    chunks.push(final_chunk);

    if chunks.len() <= 1 {
        return None;
    }

    Some(chunks)
}

fn try_emit_semantic_parent_header_gap(
    ctx: &WalkerContext<'_>,
    node: Node<'_>,
    cursor: usize,
    first_start: usize,
    template: &PendingChunk,
    chunks: &mut Vec<PendingChunk>,
) -> Option<usize> {
    if !supports_semantic_parent_header_gap(ctx.language)
        || !chunks.is_empty()
        || template.symbol_name.is_none()
    {
        return None;
    }

    let header_end = if ctx.language == "python" {
        if !ctx.range_exceeds_hard_max(template.start_byte, template.end_byte) {
            return None;
        }

        match template.symbol_kind {
            Some(SymbolKind::Class) => {
                let header_text = ctx.slice(cursor, first_start).unwrap_or("");
                if !header_text.contains("class ") {
                    return None;
                }
                first_start
            }
            Some(SymbolKind::Function) | Some(SymbolKind::Method) | Some(SymbolKind::Test) => {
                let body_start = node.child_by_field_name("body")?.start_byte();
                if body_start <= cursor {
                    return None;
                }

                let header_end = capped_python_header_end(ctx, cursor, body_start);
                let header_text = ctx.slice(cursor, header_end).unwrap_or("");
                if !header_text.contains("def ") {
                    return None;
                }
                header_end
            }
            _ => return None,
        }
    } else {
        if template.symbol_kind != Some(SymbolKind::Class) {
            return None;
        }

        let header_text = ctx.slice(cursor, first_start).unwrap_or("");
        if !header_text.contains("class ") || header_text.contains("export class") {
            return None;
        }
        first_start
    };

    if header_end <= cursor {
        return None;
    }

    chunks.push(PendingChunk {
        symbol_name: template.symbol_name.clone(),
        symbol_aliases: template.symbol_aliases.clone(),
        symbol_kind: template.symbol_kind.clone(),
        chunk_kind: template.chunk_kind.clone(),
        delegate_target_name: template.delegate_target_name.clone(),
        granularity: Granularity::Fine,
        start_byte: cursor,
        end_byte: header_end,
    });
    Some(header_end)
}

fn classify_statement_group_kind(
    ctx: &WalkerContext<'_>,
    statements: &[Node<'_>],
    default_kind: &ChunkKind,
) -> ChunkKind {
    if *default_kind != ChunkKind::Code || !is_js_like_language(ctx.language) || statements.is_empty()
    {
        return default_kind.clone();
    }

    let mut saw_registration = false;
    for statement in statements {
        if is_registration_statement(*statement, ctx.source) {
            saw_registration = true;
            continue;
        }

        if statement.kind() == "return_statement" {
            continue;
        }

        return default_kind.clone();
    }

    if saw_registration {
        let group_text = ctx
            .slice(
                statements[0].start_byte(),
                statements
                    .last()
                    .map(|statement| statement.end_byte())
                    .unwrap_or(statements[0].end_byte()),
            )
            .unwrap_or("");
        registration_chunk_kind(group_text, default_kind)
    } else {
        default_kind.clone()
    }
}

fn build_semantic_chunk(
    ctx: &WalkerContext<'_>,
    node: Node<'_>,
    info: SemanticInfo,
) -> Vec<PendingChunk> {
    let node_start = attached_start(ctx, node);
    let node_end = node.end_byte();
    let split_children = find_split_children(ctx, node);
    let is_oversized = ctx.range_exceeds_budget(node_start, node_end);
    let is_hard_oversized = ctx.range_exceeds_hard_max(node_start, node_end);
    let should_prefer_children = info.coarse_eligible
        && !split_children.is_empty()
        && !(ctx.language == "python"
            && is_python_function_symbol(info.symbol_kind)
            && !is_hard_oversized);

    let template = PendingChunk {
        symbol_name: info.symbol_name,
        symbol_aliases: info.symbol_aliases,
        symbol_kind: info.symbol_kind,
        chunk_kind: info.chunk_kind,
        delegate_target_name: info.delegate_target_name,
        granularity: Granularity::Fine,
        start_byte: node_start,
        end_byte: node_end,
    };

    if !is_oversized && !should_prefer_children {
        return vec![PendingChunk {
            symbol_name: template.symbol_name,
            symbol_aliases: template.symbol_aliases,
            symbol_kind: template.symbol_kind,
            chunk_kind: template.chunk_kind,
            delegate_target_name: template.delegate_target_name,
            granularity: template.granularity,
            start_byte: template.start_byte,
            end_byte: template.end_byte,
        }];
    }

    if !info.coarse_eligible {
        if let Some(statement_chunks) =
            split_oversized_leaf_node_by_statements(ctx, node, &template)
        {
            return statement_chunks;
        }

        return vec![template];
    }

    if split_children.is_empty() {
        if let Some(statement_chunks) =
            split_oversized_leaf_node_by_statements(ctx, node, &template)
        {
            return statement_chunks;
        }

        return vec![template];
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
            } else if try_absorb_go_declaration_prefix(
                ctx,
                cursor,
                first_start,
                &mut chunks,
                &mut child_chunks[0],
            ) {
            } else if try_absorb_go_container_leading_gap(
                ctx,
                child,
                cursor,
                first_start,
                &mut chunks,
                &mut child_chunks[0],
            ) {
            } else if chunks.is_empty()
                && try_absorb_go_container_leading_gap(
                    ctx,
                    node,
                    cursor,
                    first_start,
                    &mut chunks,
                    &mut child_chunks[0],
                )
            {
            } else {
                if let Some(header_end) = try_emit_semantic_parent_header_gap(
                    ctx,
                    node,
                    cursor,
                    first_start,
                    &template,
                    &mut chunks,
                ) {
                    cursor = header_end;
                } else if !try_attach_display_name_gap(ctx, node, cursor, first_start, &mut chunks) {
                    emit_gap(ctx, cursor, first_start, &mut chunks);
                }
            }
        }

        child_chunks.retain(|chunk| chunk.end_byte > cursor);
        if child_chunks.is_empty() {
            continue;
        }
        if child_chunks[0].start_byte < cursor {
            child_chunks[0].start_byte = cursor;
        }

        let child_end = child_chunks
            .last()
            .map(|chunk| chunk.end_byte)
            .unwrap_or(first_start);

        chunks.extend(child_chunks);
        cursor = child_end;
    }

    if cursor < node_end {
        if !try_attach_display_name_gap(ctx, node, cursor, node_end, &mut chunks) {
            emit_gap(ctx, cursor, node_end, &mut chunks);
        }
    }

    merge_delegation_wrappers(&mut chunks);
    merge_small_siblings(ctx, &mut chunks);
    chunks
}

fn build_node_chunks(ctx: &WalkerContext<'_>, node: Node<'_>) -> Vec<PendingChunk> {
    if let Some(info) = classify(ctx.policy, node, ctx.source) {
        return build_semantic_chunk(ctx, node, info);
    }

    let split_children = find_split_children(ctx, node);
    if split_children.is_empty() {
        let template = PendingChunk {
            symbol_name: None,
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Block),
            chunk_kind: ChunkKind::Code,
            delegate_target_name: None,
            granularity: Granularity::Fine,
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
        };

        if ctx.range_exceeds_budget(template.start_byte, template.end_byte) {
            if let Some(statement_chunks) =
                split_oversized_leaf_node_by_statements(ctx, node, &template)
            {
                return statement_chunks;
            }
        }

        return vec![template];
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
            } else if try_absorb_go_declaration_prefix(
                ctx,
                cursor,
                first_start,
                &mut chunks,
                &mut child_chunks[0],
            ) {
            } else if try_absorb_go_container_leading_gap(
                ctx,
                child,
                cursor,
                first_start,
                &mut chunks,
                &mut child_chunks[0],
            ) {
            } else {
                if !try_attach_display_name_gap(ctx, node, cursor, first_start, &mut chunks) {
                    emit_gap(ctx, cursor, first_start, &mut chunks);
                }
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
        if !try_absorb_go_container_trailing_gap(ctx, node, cursor, node.end_byte(), &mut chunks)
            && !try_attach_display_name_gap(ctx, node, cursor, node.end_byte(), &mut chunks)
        {
            emit_gap(ctx, cursor, node.end_byte(), &mut chunks);
        }
    }

    merge_delegation_wrappers(&mut chunks);
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

fn file_module_header_end_byte(ctx: &WalkerContext<'_>, root: Node<'_>) -> Option<usize> {
    if ctx.range_non_whitespace_len(0, ctx.source.len())
        <= FILE_MODULE_CONTEXT_MAX_NON_WHITESPACE_CHARS
    {
        return None;
    }

    let mut best_end = None;
    for (node, _info) in top_level_semantic_nodes(ctx, root) {
        let candidate_end = node.end_byte();
        if ctx.range_non_whitespace_len(0, candidate_end)
            <= FILE_MODULE_CONTEXT_MAX_NON_WHITESPACE_CHARS
        {
            best_end = Some(candidate_end);
            continue;
        }
        break;
    }

    best_end
}

fn maybe_emit_file_module_header_chunk(
    ctx: &WalkerContext<'_>,
    root: Node<'_>,
    chunks: &mut Vec<Chunk>,
) -> Result<(), ChunkerError> {
    let Some(end_byte) = file_module_header_end_byte(ctx, root) else {
        return Ok(());
    };
    let Some(symbol_name) = file_module_symbol_name(ctx.file_path) else {
        return Ok(());
    };

    let candidate = ctx.finalize_chunk(PendingChunk {
        symbol_name: Some(symbol_name),
        symbol_aliases: Vec::new(),
        symbol_kind: Some(SymbolKind::Module),
        chunk_kind: ChunkKind::File,
        delegate_target_name: None,
        granularity: Granularity::Coarse,
        start_byte: 0,
        end_byte,
    })?;

    if chunks.iter().any(|chunk| {
        chunk.start_byte == candidate.start_byte
            && chunk.end_byte == candidate.end_byte
            && chunk.text == candidate.text
    }) {
        return Ok(());
    }

    chunks.push(candidate);
    Ok(())
}

fn find_brace_token_tree_range(ctx: &WalkerContext<'_>, node: Node<'_>) -> Option<RustMacroRange> {
    if ctx.language != "rust" || node.kind() != "macro_invocation" {
        return None;
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() != "token_tree" {
            continue;
        }
        let text = ctx.slice(child.start_byte(), child.end_byte()).ok()?;
        if text.len() >= 2 && text.starts_with('{') && text.ends_with('}') {
            return Some(RustMacroRange {
                macro_start: node.start_byte(),
                macro_end: node.end_byte(),
                body_start: child.start_byte() + 1,
                body_end: child.end_byte().saturating_sub(1),
            });
        }
    }

    None
}

fn collect_rust_macro_ranges(ctx: &WalkerContext<'_>, node: Node<'_>, depth: usize, out: &mut Vec<RustMacroRange>) {
    if depth > 2 {
        return;
    }

    if let Some(range) = find_brace_token_tree_range(ctx, node) {
        out.push(range);
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_rust_macro_ranges(ctx, child, depth + 1, out);
    }
}

fn ranges_overlap(start_a: usize, end_a: usize, start_b: usize, end_b: usize) -> bool {
    start_a < end_b && start_b < end_a
}

fn parse_named_rust_macro_body_chunks(
    ctx: &WalkerContext<'_>,
    range: &RustMacroRange,
) -> Option<Vec<Chunk>> {
    if range.body_start >= range.body_end {
        return None;
    }

    let interior = ctx.slice(range.body_start, range.body_end).ok()?;
    let mut parser = Parser::new();
    parser.set_language(&(ctx.policy.parser_language)()).ok()?;
    let tree = parser.parse(interior, None)?;
    if tree.root_node().has_error() {
        return None;
    }

    let inner_ctx = WalkerContext {
        file_path: ctx.file_path,
        language: ctx.language,
        source: interior,
        config: ctx.config,
        policy: ctx.policy,
        line_starts: build_line_index(interior),
    };

    let mut pending = build_node_chunks(&inner_ctx, tree.root_node());
    for chunk in &mut pending {
        chunk.start_byte += range.body_start;
        chunk.end_byte += range.body_start;
    }
    pending.sort_by_key(|chunk| (chunk.start_byte, chunk.end_byte, chunk.granularity as u8));

    let chunks = pending
        .into_iter()
        .map(|chunk| ctx.finalize_chunk(chunk))
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let named_chunks: Vec<Chunk> = chunks
        .into_iter()
        .filter(|chunk| chunk.symbol_name.is_some())
        .collect();
    if named_chunks.is_empty() {
        return None;
    }

    Some(named_chunks)
}

fn upgrade_rust_macro_anonymous_chunks(
    ctx: &WalkerContext<'_>,
    root: Node<'_>,
    chunks: Vec<Chunk>,
) -> Vec<Chunk> {
    if ctx.language != "rust" {
        return chunks;
    }

    let mut macro_ranges = Vec::new();
    collect_rust_macro_ranges(ctx, root, 0, &mut macro_ranges);
    if macro_ranges.is_empty() {
        return chunks;
    }

    let upgrades: Vec<(RustMacroRange, Vec<Chunk>)> = macro_ranges
        .into_iter()
        .filter_map(|range| parse_named_rust_macro_body_chunks(ctx, &range).map(|named| (range, named)))
        .collect();
    if upgrades.is_empty() {
        return chunks;
    }

    let mut upgraded = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        let is_upgradeable_anon = chunk.symbol_name.is_none()
            && chunk.chunk_kind == ChunkKind::Code
            && chunk.granularity == Granularity::Fine
            && chunk.symbol_kind == Some(SymbolKind::Block);
        let replaced = is_upgradeable_anon
            && upgrades.iter().any(|(range, named_chunks)| {
                ranges_overlap(
                    chunk.start_byte as usize,
                    chunk.end_byte as usize,
                    range.macro_start,
                    range.macro_end,
                ) && named_chunks.iter().any(|named| {
                    ranges_overlap(
                        chunk.start_byte as usize,
                        chunk.end_byte as usize,
                        named.start_byte as usize,
                        named.end_byte as usize,
                    )
                })
            });

        if !replaced {
            upgraded.push(chunk);
        }
    }

    for (_range, named_chunks) in upgrades {
        for named in named_chunks {
            let duplicate = upgraded.iter().any(|existing| {
                existing.start_byte == named.start_byte
                    && existing.end_byte == named.end_byte
                    && existing.granularity == named.granularity
                    && existing.symbol_name == named.symbol_name
            });
            if !duplicate {
                upgraded.push(named);
            }
        }
    }

    upgraded.sort_by_key(|chunk| (chunk.start_byte, chunk.end_byte, chunk.granularity as u8));
    upgraded
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
    let mut chunks =
        super::enforce_fine_chunk_max_size(file_path, language, source, config, chunks)?;
    chunks = upgrade_rust_macro_anonymous_chunks(&ctx, root, chunks);

    if config.emit_coarse_chunks {
        for (node, info) in top_level_semantic_nodes(&ctx, root) {
            if !info.coarse_eligible {
                continue;
            }

            let pending = PendingChunk {
                symbol_name: info.symbol_name,
                symbol_aliases: info.symbol_aliases,
                symbol_kind: info.symbol_kind,
                chunk_kind: info.chunk_kind,
                delegate_target_name: None,
                granularity: Granularity::Coarse,
                start_byte: attached_start(&ctx, node),
                end_byte: node.end_byte(),
            };
            chunks.push(ctx.finalize_chunk(pending)?);
        }

        maybe_emit_file_module_header_chunk(&ctx, root, &mut chunks)?;
    }

    chunks.sort_by(|a, b| {
        a.start_byte
            .cmp(&b.start_byte)
            .then_with(|| a.end_byte.cmp(&b.end_byte))
            .then_with(|| a.granularity.cmp(&b.granularity))
    });

    Ok(chunks)
}
