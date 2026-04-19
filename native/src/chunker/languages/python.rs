use super::super::policy::{
    extract_name_by_fields, first_named_child_of_kind, node_text, LanguagePolicy, SemanticInfo,
};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn python_language() -> tree_sitter::Language {
    tree_sitter_python::LANGUAGE.into()
}

fn is_comment_kind(kind: &str) -> bool {
    kind == "comment"
}

fn is_python_docstring_literal(node: Node<'_>) -> bool {
    matches!(node.kind(), "string" | "concatenated_string")
}

fn is_python_docstring_statement(node: Node<'_>) -> bool {
    if node.kind() != "expression_statement" {
        return false;
    }

    let mut cursor = node.walk();
    let mut children = node.named_children(&mut cursor);
    let first = children.next();
    let second = children.next();

    matches!(first, Some(child) if is_python_docstring_literal(child)) && second.is_none()
}

fn has_function_leading_docstring(node: Node<'_>) -> bool {
    let Some(body) = node.child_by_field_name("body") else {
        return false;
    };

    let mut cursor = body.walk();
    let first = body.named_children(&mut cursor).next();
    matches!(first, Some(child) if is_python_docstring_statement(child))
}

fn python_identifier_text(node: Node<'_>, source: &str) -> Option<String> {
    if node.kind() != "identifier" {
        return None;
    }

    node_text(node, source)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn first_identifier_descendant(node: Node<'_>, source: &str) -> Option<String> {
    if let Some(name) = python_identifier_text(node, source) {
        return Some(name);
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if let Some(name) = first_identifier_descendant(child, source) {
            return Some(name);
        }
    }

    None
}

fn is_module_scope_assignment(node: Node<'_>) -> bool {
    let mut ancestor = node.parent();
    while let Some(parent) = ancestor {
        match parent.kind() {
            "expression_statement" => ancestor = parent.parent(),
            "module" => return true,
            _ => return false,
        }
    }

    false
}

fn classify_python_assignment(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    if !is_module_scope_assignment(node) {
        return None;
    }

    let left = node.child_by_field_name("left")?;
    let symbol_name = python_identifier_text(left, source)?;

    Some(SemanticInfo {
        symbol_name: Some(symbol_name),
        symbol_aliases: Vec::new(),
        symbol_kind: Some(SymbolKind::Constant),
        chunk_kind: ChunkKind::Code,
        coarse_eligible: false,
        delegate_target_name: None,
    })
}

fn classify_python_type_alias(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let left = node.child_by_field_name("left")?;
    let symbol_name = python_identifier_text(left, source)
        .or_else(|| {
            first_named_child_of_kind(left, "identifier")
                .and_then(|child| python_identifier_text(child, source))
        })
        .or_else(|| first_identifier_descendant(left, source))?;

    Some(SemanticInfo {
        symbol_name: Some(symbol_name),
        symbol_aliases: Vec::new(),
        symbol_kind: Some(SymbolKind::Type),
        chunk_kind: ChunkKind::Code,
        coarse_eligible: false,
        delegate_target_name: None,
    })
}

fn classify_python_docstring(node: Node<'_>) -> Option<SemanticInfo> {
    if !is_python_docstring_statement(node) {
        return None;
    }

    let parent = node.parent()?;
    match parent.kind() {
        "module" => {}
        "block" => match parent.parent().map(|ancestor| ancestor.kind()) {
            Some("function_definition") | Some("class_definition") => {}
            _ => return None,
        },
        "function_definition" | "class_definition" => {}
        _ => return None,
    }

    let mut prev = node.prev_named_sibling();
    while let Some(sibling) = prev {
        match sibling.kind() {
            "comment" | "decorator" => prev = sibling.prev_named_sibling(),
            _ => return None,
        }
    }

    Some(SemanticInfo {
        symbol_name: None,
        symbol_aliases: Vec::new(),
        symbol_kind: Some(SymbolKind::Block),
        chunk_kind: ChunkKind::Doc,
        coarse_eligible: false,
        delegate_target_name: None,
    })
}

fn classify_python_function(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let name = extract_name_by_fields(node, source, &["name"])?;
    let mut symbol_kind = SymbolKind::Function;
    let mut chunk_kind = ChunkKind::Code;
    let mut is_method = false;
    let mut is_in_test_class = false;
    let mut ancestor = node.parent();

    while let Some(parent) = ancestor {
        match parent.kind() {
            "class_definition" => {
                is_method = true;

                if let Some(class_name) = extract_name_by_fields(parent, source, &["name"]) {
                    if class_name.starts_with("Test") {
                        is_in_test_class = true;
                    }
                }
                break;
            }
            "decorated_definition" | "block" => {
                ancestor = parent.parent();
            }
            _ => break,
        }
    }

    if is_method {
        symbol_kind = SymbolKind::Method;
        if is_in_test_class {
            symbol_kind = SymbolKind::Test;
            chunk_kind = ChunkKind::Test;
        }
    }

    if name.starts_with("test_") {
        symbol_kind = SymbolKind::Test;
        chunk_kind = ChunkKind::Test;
    }

    if is_method && name == "__init__" {
        return None;
    }

    Some(SemanticInfo {
        symbol_name: Some(name),
        symbol_aliases: Vec::new(),
        symbol_kind: Some(symbol_kind),
        chunk_kind,
        coarse_eligible: has_function_leading_docstring(node),
        delegate_target_name: None,
    })
}

fn classify_python_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "function_definition" => classify_python_function(node, source),
        "class_definition" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Class),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "assignment" => classify_python_assignment(node, source),
        "type_alias_statement" => classify_python_type_alias(node, source),
        "expression_statement" => classify_python_docstring(node),
        "decorated_definition" => {
            let target = node
                .child_by_field_name("definition")
                .or_else(|| first_named_child_of_kind(node, "function_definition"))
                .or_else(|| first_named_child_of_kind(node, "class_definition"))?;
            classify_python_node(target, source)
        }
        _ => None,
    }
}

pub const PYTHON_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "python",
    parser_language: python_language,
    classify_node: classify_python_node,
    is_comment_kind,
};
