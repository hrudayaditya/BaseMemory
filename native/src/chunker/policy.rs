use super::{ChunkKind, SymbolKind};
use crate::chunker::languages::{
    BASH_POLICY, CPP_POLICY, CSHARP_POLICY, C_POLICY, GO_POLICY, JAVASCRIPT_POLICY, JAVA_POLICY,
    JSON_POLICY, JSX_POLICY, PHP_POLICY, PYTHON_POLICY, RUBY_POLICY, RUST_POLICY, TOML_POLICY,
    TSX_POLICY, TYPESCRIPT_POLICY, YAML_POLICY,
};
use tree_sitter::Node;

#[derive(Debug, Clone)]
pub struct SemanticInfo {
    pub symbol_name: Option<String>,
    pub symbol_aliases: Vec<String>,
    pub symbol_kind: Option<SymbolKind>,
    pub chunk_kind: ChunkKind,
    pub coarse_eligible: bool,
    pub delegate_target_name: Option<String>,
}

pub struct LanguagePolicy {
    pub language_name: &'static str,
    pub parser_language: fn() -> tree_sitter::Language,
    pub classify_node: for<'tree> fn(Node<'tree>, &str) -> Option<SemanticInfo>,
    pub is_comment_kind: fn(&str) -> bool,
}

pub fn get_policy(language: &str) -> Option<&'static LanguagePolicy> {
    match language.to_ascii_lowercase().as_str() {
        "typescript" | "ts" => Some(&TYPESCRIPT_POLICY),
        "tsx" => Some(&TSX_POLICY),
        "javascript" | "js" => Some(&JAVASCRIPT_POLICY),
        "jsx" => Some(&JSX_POLICY),
        "python" | "py" => Some(&PYTHON_POLICY),
        "rust" | "rs" => Some(&RUST_POLICY),
        "go" => Some(&GO_POLICY),
        "php" => Some(&PHP_POLICY),
        "java" => Some(&JAVA_POLICY),
        "csharp" | "cs" | "c#" => Some(&CSHARP_POLICY),
        "c" => Some(&C_POLICY),
        "cpp" | "c++" => Some(&CPP_POLICY),
        "ruby" | "rb" => Some(&RUBY_POLICY),
        "bash" | "sh" | "zsh" => Some(&BASH_POLICY),
        "json" => Some(&JSON_POLICY),
        "toml" => Some(&TOML_POLICY),
        "yaml" | "yml" => Some(&YAML_POLICY),
        _ => None,
    }
}

pub fn node_text<'a>(node: Node<'a>, source: &'a str) -> Option<&'a str> {
    source.get(node.start_byte()..node.end_byte())
}

pub fn first_named_child_of_kind<'tree>(node: Node<'tree>, kind: &str) -> Option<Node<'tree>> {
    let mut cursor = node.walk();
    let child = node
        .named_children(&mut cursor)
        .find(|item| item.kind() == kind);
    child
}

pub fn extract_name_by_fields(node: Node<'_>, source: &str, fields: &[&str]) -> Option<String> {
    for field in fields {
        if let Some(child) = node.child_by_field_name(field) {
            if let Some(name) = node_text(child, source) {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if matches!(
            child.kind(),
            "identifier" | "property_identifier" | "type_identifier" | "field_identifier" | "name"
        ) {
            if let Some(name) = node_text(child, source) {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    None
}

pub fn extract_string_literal(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "string" | "string_literal" | "interpreted_string_literal" | "raw_string_literal" => {
            let text = node_text(node, source)?.trim();
            Some(
                text.trim_matches('"')
                    .trim_matches('\'')
                    .trim_matches('`')
                    .to_string(),
            )
        }
        "template_string" | "template_literal" => {
            let text = node_text(node, source)?.trim();
            Some(text.trim_matches('`').to_string())
        }
        _ => None,
    }
}

pub fn has_descendant_kind(node: Node<'_>, kinds: &[&str]) -> bool {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if kinds.iter().any(|kind| child.kind() == *kind) {
            return true;
        }
        if has_descendant_kind(child, kinds) {
            return true;
        }
    }
    false
}
