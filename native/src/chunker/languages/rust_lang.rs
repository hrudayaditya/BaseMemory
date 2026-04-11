use super::super::policy::{
    extract_name_by_fields, first_named_child_of_kind, node_text, LanguagePolicy, SemanticInfo,
};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn rust_language() -> tree_sitter::Language {
    tree_sitter_rust::LANGUAGE.into()
}

fn is_comment_kind(kind: &str) -> bool {
    matches!(kind, "line_comment" | "block_comment" | "doc_comment")
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

fn classify_named_rust_item(
    node: Node<'_>,
    source: &str,
    symbol_kind: SymbolKind,
    coarse_eligible: bool,
) -> Option<SemanticInfo> {
    Some(SemanticInfo {
        symbol_name: extract_name_by_fields(node, source, &["name"]),
        symbol_kind: Some(symbol_kind),
        chunk_kind: ChunkKind::Code,
        coarse_eligible,
    })
}

fn impl_item_name(node: Node<'_>, source: &str) -> Option<String> {
    let type_name = node
        .child_by_field_name("type")
        .and_then(|child| node_text(child, source))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string);
    let trait_name = node
        .child_by_field_name("trait")
        .and_then(|child| node_text(child, source))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string);

    match (trait_name, type_name) {
        (Some(trait_name), Some(type_name)) => Some(format!("{trait_name} for {type_name}")),
        (None, Some(type_name)) => Some(type_name),
        (Some(trait_name), None) => Some(trait_name),
        (None, None) => first_named_child_of_kind(node, "type_identifier")
            .and_then(|child| node_text(child, source).map(str::trim))
            .filter(|text| !text.is_empty())
            .map(ToString::to_string),
    }
}

fn classify_rust_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "function_item" => Some(classify_rust_function(node, source)),
        "struct_item" => classify_named_rust_item(node, source, SymbolKind::Struct, true),
        "enum_item" => classify_named_rust_item(node, source, SymbolKind::Type, true),
        "trait_item" => classify_named_rust_item(node, source, SymbolKind::Interface, true),
        "mod_item" => classify_named_rust_item(node, source, SymbolKind::Module, true),
        "macro_definition" => classify_named_rust_item(node, source, SymbolKind::Function, false),
        "type_item" => classify_named_rust_item(node, source, SymbolKind::Type, false),
        "const_item" | "static_item" => {
            classify_named_rust_item(node, source, SymbolKind::Constant, false)
        }
        "impl_item" => Some(SemanticInfo {
            symbol_name: impl_item_name(node, source),
            symbol_kind: Some(SymbolKind::Block),
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
