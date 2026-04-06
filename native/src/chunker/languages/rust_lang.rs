use super::super::policy::{
    extract_name_by_fields, first_named_child_of_kind, node_text, LanguagePolicy, SemanticInfo,
};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn rust_language() -> tree_sitter::Language {
    tree_sitter_rust::LANGUAGE.into()
}

fn is_comment_kind(kind: &str) -> bool {
    matches!(kind, "line_comment" | "block_comment")
}

fn has_test_attribute(node: Node<'_>, source: &str) -> bool {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() != "attribute_item" {
            continue;
        }

        if let Some(text) = node_text(child, source) {
            if text.contains("#[test]") || text.contains("#[tokio::test]") {
                return true;
            }
        }
    }

    false
}

fn classify_rust_function(node: Node<'_>, source: &str) -> SemanticInfo {
    let mut symbol_kind = SymbolKind::Function;
    let mut chunk_kind = ChunkKind::Code;

    if let Some(parent) = node.parent() {
        if matches!(
            parent.kind(),
            "impl_item" | "trait_item" | "declaration_list"
        ) {
            if let Some(grandparent) = parent.parent() {
                if matches!(grandparent.kind(), "impl_item" | "trait_item") {
                    symbol_kind = SymbolKind::Method;
                }
            } else {
                symbol_kind = SymbolKind::Method;
            }
        }
    }

    if has_test_attribute(node, source) {
        symbol_kind = SymbolKind::Test;
        chunk_kind = ChunkKind::Test;
    }

    SemanticInfo {
        symbol_name: extract_name_by_fields(node, source, &["name"]),
        symbol_kind: Some(symbol_kind),
        chunk_kind,
        coarse_eligible: false,
    }
}

fn classify_rust_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "function_item" => Some(classify_rust_function(node, source)),
        "struct_item" | "enum_item" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Struct),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "trait_item" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Interface),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "mod_item" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "impl_item" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["type", "trait"]).or_else(|| {
                first_named_child_of_kind(node, "type_identifier")
                    .and_then(|child| node_text(child, source).map(ToString::to_string))
            }),
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        _ => None,
    }
}

pub const RUST_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "rust",
    parser_language: rust_language,
    classify_node: classify_rust_node,
    is_comment_kind,
};
