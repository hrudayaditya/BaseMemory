use super::super::policy::{extract_name_by_fields, LanguagePolicy, SemanticInfo};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn ruby_language() -> tree_sitter::Language {
    tree_sitter_ruby::LANGUAGE.into()
}

fn bash_language() -> tree_sitter::Language {
    tree_sitter_bash::LANGUAGE.into()
}

fn ruby_is_comment_kind(kind: &str) -> bool {
    kind == "comment"
}

fn bash_is_comment_kind(kind: &str) -> bool {
    kind == "comment"
}

fn classify_ruby_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "method" | "singleton_method" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Method),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        "class" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Class),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "module" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        _ => None,
    }
}

fn classify_bash_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "function_definition" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Function),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        _ => None,
    }
}

pub const RUBY_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "ruby",
    parser_language: ruby_language,
    classify_node: classify_ruby_node,
    is_comment_kind: ruby_is_comment_kind,
};

pub const BASH_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "bash",
    parser_language: bash_language,
    classify_node: classify_bash_node,
    is_comment_kind: bash_is_comment_kind,
};
