use super::super::policy::{
    extract_name_by_fields, first_named_child_of_kind, node_text, LanguagePolicy, SemanticInfo,
};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn php_language() -> tree_sitter::Language {
    tree_sitter_php::LANGUAGE_PHP.into()
}

fn is_comment_kind(kind: &str) -> bool {
    kind == "comment"
}

fn extract_php_variable_name(node: Node<'_>, source: &str) -> Option<String> {
    let name = first_named_child_of_kind(node, "name")
        .and_then(|child| node_text(child, source))
        .map(str::trim)?;
    let stripped = name.trim_start_matches('$').trim();
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

fn classify_php_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "function_definition" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Function),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        "method_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Method),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        "class_declaration" | "trait_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Class),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "enum_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Type),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "interface_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Interface),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "const_declaration" => None,
        "const_element" => Some(SemanticInfo {
            symbol_name: first_named_child_of_kind(node, "name")
                .and_then(|child| node_text(child, source))
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(ToString::to_string),
            symbol_kind: Some(SymbolKind::Constant),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        "assignment_expression" => {
            let right = node.child_by_field_name("right")?;
            if right.kind() != "arrow_function" {
                return None;
            }

            let left = node.child_by_field_name("left")?;
            if left.kind() != "variable_name" {
                return None;
            }

            Some(SemanticInfo {
                symbol_name: extract_php_variable_name(left, source),
                symbol_kind: Some(SymbolKind::Function),
                chunk_kind: ChunkKind::Code,
                coarse_eligible: false,
                delegate_target_name: None,
            })
        }
        _ => None,
    }
}

pub const PHP_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "php",
    parser_language: php_language,
    classify_node: classify_php_node,
    is_comment_kind,
};
