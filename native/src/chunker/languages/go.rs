use super::super::policy::{extract_name_by_fields, node_text, LanguagePolicy, SemanticInfo};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

const GO_TEST_PREFIXES: &[&str] = &["Test", "Benchmark", "Example"];

fn go_language() -> tree_sitter::Language {
    tree_sitter_go::LANGUAGE.into()
}

fn is_comment_kind(kind: &str) -> bool {
    kind == "comment"
}

fn classify_go_function(node: Node<'_>, source: &str, is_method: bool) -> SemanticInfo {
    let name = if is_method {
        classify_go_method_name(node, source)
            .or_else(|| extract_name_by_fields(node, source, &["name"]))
    } else {
        extract_name_by_fields(node, source, &["name"])
    };
    let is_test = name
        .as_deref()
        .map(|value| {
            GO_TEST_PREFIXES
                .iter()
                .any(|prefix| value.starts_with(prefix))
        })
        .unwrap_or(false);

    SemanticInfo {
        symbol_name: name,
        symbol_kind: Some(if is_test {
            SymbolKind::Test
        } else if is_method {
            SymbolKind::Method
        } else {
            SymbolKind::Function
        }),
        chunk_kind: if is_test {
            ChunkKind::Test
        } else {
            ChunkKind::Code
        },
        coarse_eligible: false,
    }
}

fn first_go_name(node: Node<'_>, source: &str) -> Option<String> {
    node.child_by_field_name("name")
        .and_then(|child| node_text(child, source))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn extract_go_receiver_type(node: Node<'_>, source: &str) -> Option<String> {
    let receiver_list = node.child_by_field_name("receiver")?;
    let parameter = receiver_list.named_child(0)?;
    let type_node = parameter.child_by_field_name("type")?;
    let type_text = node_text(type_node, source)?.trim();
    let receiver = type_text.trim_start_matches('*').trim();
    if receiver.is_empty() {
        return None;
    }

    Some(receiver.to_string())
}

fn classify_go_method_name(node: Node<'_>, source: &str) -> Option<String> {
    let method_name = extract_name_by_fields(node, source, &["name"])?;
    let receiver_type = extract_go_receiver_type(node, source)?;
    Some(format!("{receiver_type}.{method_name}"))
}

fn classify_go_type_spec(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let type_node = node.child_by_field_name("type")?;
    let symbol_kind = match type_node.kind() {
        "struct_type" => SymbolKind::Struct,
        "interface_type" => SymbolKind::Interface,
        _ => SymbolKind::Type,
    };

    Some(SemanticInfo {
        symbol_name: extract_name_by_fields(node, source, &["name"]),
        symbol_kind: Some(symbol_kind),
        chunk_kind: ChunkKind::Code,
        coarse_eligible: matches!(symbol_kind, SymbolKind::Struct | SymbolKind::Interface),
    })
}

fn classify_go_named_value_spec(
    node: Node<'_>,
    source: &str,
    symbol_kind: SymbolKind,
) -> Option<SemanticInfo> {
    Some(SemanticInfo {
        symbol_name: first_go_name(node, source),
        symbol_kind: Some(symbol_kind),
        chunk_kind: ChunkKind::Code,
        coarse_eligible: false,
    })
}

fn classify_go_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "function_declaration" => Some(classify_go_function(node, source, false)),
        "method_declaration" => Some(classify_go_function(node, source, true)),
        "const_declaration" | "var_declaration" | "type_declaration" => None,
        "const_spec" | "var_spec" => {
            classify_go_named_value_spec(node, source, SymbolKind::Constant)
        }
        "type_alias" => classify_go_named_value_spec(node, source, SymbolKind::Type),
        "type_spec" => classify_go_type_spec(node, source),
        _ => None,
    }
}

pub const GO_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "go",
    parser_language: go_language,
    classify_node: classify_go_node,
    is_comment_kind,
};
