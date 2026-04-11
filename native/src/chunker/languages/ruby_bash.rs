use super::super::policy::{extract_name_by_fields, node_text, LanguagePolicy, SemanticInfo};
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

fn is_ruby_dsl_method(name: &str) -> bool {
    matches!(
        name,
        "attr_accessor"
            | "attr_reader"
            | "attr_writer"
            | "include"
            | "extend"
            | "prepend"
            | "has_many"
            | "has_one"
            | "belongs_to"
            | "has_and_belongs_to_many"
            | "validates"
            | "validates_presence_of"
            | "validates_uniqueness_of"
            | "scope"
            | "before_action"
            | "after_action"
            | "around_action"
            | "before_save"
            | "after_save"
            | "before_create"
            | "after_create"
    )
}

fn is_ruby_class_or_module_body_call(node: Node<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };

    match parent.kind() {
        "class" | "module" => true,
        "body_statement" => parent
            .parent()
            .map(|grandparent| matches!(grandparent.kind(), "class" | "module"))
            .unwrap_or(false),
        _ => false,
    }
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
        "call" => {
            if !is_ruby_class_or_module_body_call(node) {
                return None;
            }

            let method = node.child_by_field_name("method")?;
            let method_name = node_text(method, source)?.trim();
            if !is_ruby_dsl_method(method_name) {
                return None;
            }

            Some(SemanticInfo {
                symbol_name: Some(method_name.to_string()),
                symbol_kind: Some(SymbolKind::Block),
                chunk_kind: ChunkKind::Code,
                coarse_eligible: false,
            })
        }
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
