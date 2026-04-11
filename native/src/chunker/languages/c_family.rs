use super::super::policy::{extract_name_by_fields, node_text, LanguagePolicy, SemanticInfo};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn csharp_language() -> tree_sitter::Language {
    tree_sitter_c_sharp::LANGUAGE.into()
}

fn c_language() -> tree_sitter::Language {
    tree_sitter_c::LANGUAGE.into()
}

fn cpp_language() -> tree_sitter::Language {
    tree_sitter_cpp::LANGUAGE.into()
}

fn is_comment_kind(kind: &str) -> bool {
    matches!(kind, "line_comment" | "block_comment" | "comment")
}

fn classify_csharp_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "method_declaration"
        | "constructor_declaration"
        | "property_declaration"
        | "indexer_declaration" => {
            Some(SemanticInfo {
                symbol_name: if node.kind() == "indexer_declaration" {
                    Some("this[]".to_string())
                } else {
                    extract_name_by_fields(node, source, &["name"])
                },
                symbol_kind: Some(SymbolKind::Method),
                chunk_kind: ChunkKind::Code,
                coarse_eligible: false,
            })
        }
        "namespace_declaration" | "file_scoped_namespace_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "class_declaration" | "record_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Class),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
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
        "struct_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Struct),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "global_statement" => Some(SemanticInfo {
            symbol_name: Some("<top-level>".to_string()),
            symbol_kind: Some(SymbolKind::Block),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        _ => None,
    }
}

fn classify_c_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "function_definition" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["declarator", "name"]),
            symbol_kind: Some(SymbolKind::Function),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        "struct_specifier" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Struct),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "enum_specifier" | "type_definition" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Type),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        _ => None,
    }
}

fn classify_cpp_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "function_definition" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["declarator", "name"]),
            symbol_kind: Some(SymbolKind::Function),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        "class_specifier" | "template_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Class),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "enum_specifier" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Type),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "struct_specifier" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Struct),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "namespace_definition" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]).or_else(|| {
                let mut cursor = node.walk();
                let namespace = node
                    .named_children(&mut cursor)
                    .find(|child| child.kind() == "namespace_identifier")
                    .and_then(|child| node_text(child, source).map(ToString::to_string));
                namespace
            }),
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        _ => None,
    }
}

pub const CSHARP_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "csharp",
    parser_language: csharp_language,
    classify_node: classify_csharp_node,
    is_comment_kind,
};

pub const C_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "c",
    parser_language: c_language,
    classify_node: classify_c_node,
    is_comment_kind,
};

pub const CPP_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "cpp",
    parser_language: cpp_language,
    classify_node: classify_cpp_node,
    is_comment_kind,
};
