use super::super::policy::{
    extract_name_by_fields, first_named_child_of_kind, node_text, LanguagePolicy, SemanticInfo,
};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn json_language() -> tree_sitter::Language {
    tree_sitter_json::LANGUAGE.into()
}

fn toml_language() -> tree_sitter::Language {
    tree_sitter_toml_ng::LANGUAGE.into()
}

fn yaml_language() -> tree_sitter::Language {
    tree_sitter_yaml::LANGUAGE.into()
}

fn json_is_comment_kind(_kind: &str) -> bool {
    false
}

fn toml_yaml_is_comment_kind(kind: &str) -> bool {
    kind == "comment"
}

fn classify_json_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "pair" => Some(SemanticInfo {
            symbol_name: first_named_child_of_kind(node, "string").and_then(|key| {
                node_text(key, source).map(|text| text.trim_matches('"').to_string())
            }),
            symbol_kind: Some(SymbolKind::Block),
            chunk_kind: ChunkKind::Config,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        "object" | "array" => Some(SemanticInfo {
            symbol_name: None,
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Config,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        _ => None,
    }
}

fn classify_toml_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "table" | "table_array_element" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Config,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "pair" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["key"]),
            symbol_kind: Some(SymbolKind::Block),
            chunk_kind: ChunkKind::Config,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        _ => None,
    }
}

fn classify_yaml_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "block_mapping_pair" | "flow_pair" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["key"]).or_else(|| {
                let mut cursor = node.walk();
                let key = node
                    .named_children(&mut cursor)
                    .next()
                    .and_then(|child| node_text(child, source).map(|text| text.trim().to_string()));
                key
            }),
            symbol_kind: Some(SymbolKind::Block),
            chunk_kind: ChunkKind::Config,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        "block_sequence" | "flow_sequence" | "block_mapping" | "flow_mapping" => {
            Some(SemanticInfo {
                symbol_name: None,
                symbol_kind: Some(SymbolKind::Module),
                chunk_kind: ChunkKind::Config,
                coarse_eligible: true,
                delegate_target_name: None,
            })
        }
        _ => None,
    }
}

pub const JSON_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "json",
    parser_language: json_language,
    classify_node: classify_json_node,
    is_comment_kind: json_is_comment_kind,
};

pub const TOML_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "toml",
    parser_language: toml_language,
    classify_node: classify_toml_node,
    is_comment_kind: toml_yaml_is_comment_kind,
};

pub const YAML_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "yaml",
    parser_language: yaml_language,
    classify_node: classify_yaml_node,
    is_comment_kind: toml_yaml_is_comment_kind,
};
