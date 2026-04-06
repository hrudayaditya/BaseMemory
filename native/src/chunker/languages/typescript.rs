use super::super::policy::{
    classify_test_call, extract_name_by_fields, extract_string_literal, first_named_child_of_kind,
    has_descendant_kind, LanguagePolicy, SemanticInfo,
};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

const JS_TEST_CALLEES: &[&str] = &[
    "it",
    "test",
    "describe",
    "beforeEach",
    "afterEach",
    "beforeAll",
    "afterAll",
];

fn ts_language() -> tree_sitter::Language {
    tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}

fn tsx_language() -> tree_sitter::Language {
    tree_sitter_typescript::LANGUAGE_TSX.into()
}

fn js_language() -> tree_sitter::Language {
    tree_sitter_javascript::LANGUAGE.into()
}

fn is_comment_kind(kind: &str) -> bool {
    kind == "comment"
}

fn classify_export_statement(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "comment" {
            continue;
        }

        if let Some(info) = classify_ts_js_node(child, source) {
            return Some(info);
        }
    }
    None
}

fn classify_variable_declarator(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let value = node.child_by_field_name("value")?;
    let symbol_name = extract_name_by_fields(node, source, &["name"]);

    match value.kind() {
        "arrow_function" | "function" | "function_expression" => Some(SemanticInfo {
            symbol_name,
            symbol_kind: Some(SymbolKind::Function),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        "class" | "class_declaration" => Some(SemanticInfo {
            symbol_name,
            symbol_kind: Some(SymbolKind::Class),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        _ => None,
    }
}

fn classify_test_expression(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let call = if node.kind() == "expression_statement" {
        first_named_child_of_kind(node, "call_expression")
    } else if node.kind() == "call_expression" {
        Some(node)
    } else {
        None
    }?;

    if !classify_test_call(call, source, JS_TEST_CALLEES) {
        return None;
    }

    let label = call
        .child_by_field_name("arguments")
        .and_then(|arguments: Node<'_>| {
            let mut cursor = arguments.walk();
            let label = arguments
                .named_children(&mut cursor)
                .find_map(|arg| extract_string_literal(arg, source));
            label
        })
        .or_else(|| Some("test".to_string()));

    Some(SemanticInfo {
        symbol_name: label,
        symbol_kind: Some(SymbolKind::Test),
        chunk_kind: ChunkKind::Test,
        coarse_eligible: false,
    })
}

fn classify_ts_js_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "export_statement" => classify_export_statement(node, source),
        "function_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Function),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        "method_definition" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name", "property"]),
            symbol_kind: Some(SymbolKind::Method),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
        }),
        "class_declaration" | "abstract_class_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Class),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "interface_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Interface),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "variable_declarator" => classify_variable_declarator(node, source),
        "expression_statement" | "call_expression" => classify_test_expression(node, source),
        "lexical_declaration" if has_descendant_kind(node, &["variable_declarator"]) => None,
        _ => None,
    }
}

pub const TYPESCRIPT_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "typescript",
    parser_language: ts_language,
    classify_node: classify_ts_js_node,
    is_comment_kind,
};

pub const TSX_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "tsx",
    parser_language: tsx_language,
    classify_node: classify_ts_js_node,
    is_comment_kind,
};

pub const JAVASCRIPT_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "javascript",
    parser_language: js_language,
    classify_node: classify_ts_js_node,
    is_comment_kind,
};

pub const JSX_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "jsx",
    parser_language: js_language,
    classify_node: classify_ts_js_node,
    is_comment_kind,
};
