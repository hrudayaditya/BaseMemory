use super::super::policy::{extract_name_by_fields, node_text, LanguagePolicy, SemanticInfo};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn java_language() -> tree_sitter::Language {
    tree_sitter_java::LANGUAGE.into()
}

fn is_comment_kind(kind: &str) -> bool {
    matches!(kind, "line_comment" | "block_comment" | "comment")
}

const JAVA_TEST_ANNOTATIONS: &[&str] = &[
    "Test",
    "ParameterizedTest",
    "RepeatedTest",
    "TestFactory",
    "TestTemplate",
    "BeforeEach",
    "AfterEach",
    "BeforeAll",
    "AfterAll",
    "Before",
    "After",
    "BeforeClass",
    "AfterClass",
];

fn annotation_terminal_name(node: Node<'_>, source: &str) -> Option<String> {
    let name = node.child_by_field_name("name")?;
    let text = node_text(name, source)?.trim();
    let terminal = text.rsplit('.').next()?.trim();
    if terminal.is_empty() {
        return None;
    }
    Some(terminal.to_string())
}

fn is_test_annotation_kind(kind: &str) -> bool {
    matches!(kind, "annotation" | "marker_annotation")
}

fn is_java_test_annotation_name(name: &str) -> bool {
    JAVA_TEST_ANNOTATIONS.iter().any(|candidate| *candidate == name)
}

fn has_test_annotation(node: Node<'_>, source: &str) -> bool {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        match child.kind() {
            kind if is_test_annotation_kind(kind) => {
                if let Some(name) = annotation_terminal_name(child, source) {
                    if is_java_test_annotation_name(&name) {
                        return true;
                    }
                }
            }
            "modifiers" => {
                let mut modifiers_cursor = child.walk();
                for modifier in child.named_children(&mut modifiers_cursor) {
                    if !is_test_annotation_kind(modifier.kind()) {
                        continue;
                    }

                    if let Some(name) = annotation_terminal_name(modifier, source) {
                        if is_java_test_annotation_name(&name) {
                            return true;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut prev = node.prev_named_sibling();
    while let Some(sibling) = prev {
        match sibling.kind() {
            kind if is_test_annotation_kind(kind) => {
                if let Some(name) = annotation_terminal_name(sibling, source) {
                    if is_java_test_annotation_name(&name) {
                        return true;
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

fn classify_java_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "method_declaration" | "constructor_declaration" => {
            let is_test = has_test_annotation(node, source);
            let symbol_name = extract_name_by_fields(node, source, &["name"]);
            if node.kind() == "constructor_declaration" {
                return None;
            }
            Some(SemanticInfo {
                symbol_name,
                symbol_aliases: Vec::new(),
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
                delegate_target_name: None,
            })
        }
        "class_declaration" | "annotation_type_declaration" | "record_declaration" => {
            Some(SemanticInfo {
                symbol_name: extract_name_by_fields(node, source, &["name"]),
                symbol_aliases: Vec::new(),
                symbol_kind: Some(SymbolKind::Class),
                chunk_kind: ChunkKind::Code,
                coarse_eligible: true,
                delegate_target_name: None,
            })
        }
        "enum_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Type),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "interface_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Interface),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "static_initializer" => Some(SemanticInfo {
            symbol_name: Some("<static_init>".to_string()),
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Block),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
            delegate_target_name: None,
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
