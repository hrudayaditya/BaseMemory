use super::super::policy::{extract_name_by_fields, LanguagePolicy, SemanticInfo};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn java_language() -> tree_sitter::Language {
    tree_sitter_java::LANGUAGE.into()
}

fn is_comment_kind(kind: &str) -> bool {
    matches!(kind, "line_comment" | "block_comment" | "comment")
}

fn classify_java_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "method_declaration" | "constructor_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Method),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        "class_declaration" | "annotation_type_declaration" | "record_declaration" => {
            Some(SemanticInfo {
                symbol_name: extract_name_by_fields(node, source, &["name"]),
                symbol_kind: Some(SymbolKind::Class),
                chunk_kind: ChunkKind::Code,
                coarse_eligible: true,
            })
        }
        "enum_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Type),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "interface_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Interface),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "static_initializer" => Some(SemanticInfo {
            symbol_name: Some("<static_init>".to_string()),
            symbol_kind: Some(SymbolKind::Block),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        _ => None,
    }
}

pub const JAVA_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "java",
    parser_language: java_language,
    classify_node: classify_java_node,
    is_comment_kind,
};
