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

const CSHARP_TEST_ATTRIBUTES: &[&str] = &[
    "Fact",
    "Theory",
    "Test",
    "TestCase",
    "TestCaseSource",
    "SetUp",
    "TearDown",
    "TestMethod",
    "DataTestMethod",
];

fn csharp_attribute_terminal_name(node: Node<'_>, source: &str) -> Option<String> {
    let name = node.child_by_field_name("name")?;
    let text = node_text(name, source)?.trim();
    let terminal = text.rsplit('.').next()?.trim();
    let terminal = terminal.trim_end_matches("Attribute");
    if terminal.is_empty() {
        return None;
    }
    Some(terminal.to_string())
}

fn is_csharp_test_attribute_name(name: &str) -> bool {
    CSHARP_TEST_ATTRIBUTES
        .iter()
        .any(|candidate| *candidate == name)
}

fn has_test_attribute_csharp(node: Node<'_>, source: &str) -> bool {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() != "attribute_list" {
            continue;
        }

        let mut attr_cursor = child.walk();
        for attr in child.named_children(&mut attr_cursor) {
            if attr.kind() != "attribute" {
                continue;
            }

            if let Some(name) = csharp_attribute_terminal_name(attr, source) {
                if is_csharp_test_attribute_name(&name) {
                    return true;
                }
            }
        }
    }

    let mut prev = node.prev_named_sibling();
    while let Some(sibling) = prev {
        match sibling.kind() {
            "attribute_list" => {
                let mut attr_cursor = sibling.walk();
                for attr in sibling.named_children(&mut attr_cursor) {
                    if attr.kind() != "attribute" {
                        continue;
                    }

                    if let Some(name) = csharp_attribute_terminal_name(attr, source) {
                        if is_csharp_test_attribute_name(&name) {
                            return true;
                        }
                    }
                }
                prev = sibling.prev_named_sibling();
            }
            kind if is_comment_kind(kind) => {
                prev = sibling.prev_named_sibling();
            }
            _ => return false,
        }
    }

    false
}

fn classify_csharp_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "method_declaration" | "constructor_declaration" => {
            let is_test = has_test_attribute_csharp(node, source);
            Some(SemanticInfo {
                symbol_name: extract_name_by_fields(node, source, &["name"]),
                symbol_kind: Some(if is_test {
                    SymbolKind::Test
                } else {
                    SymbolKind::Method
                }),
                chunk_kind: if is_test {
                    ChunkKind::Test
                } else {
                    ChunkKind::Code
                },
                coarse_eligible: false,
            })
        }
        "property_declaration" | "indexer_declaration" => Some(SemanticInfo {
            symbol_name: if node.kind() == "indexer_declaration" {
                Some("this[]".to_string())
            } else {
                extract_name_by_fields(node, source, &["name"])
            },
            symbol_kind: Some(SymbolKind::Method),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
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
