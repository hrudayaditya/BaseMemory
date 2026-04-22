use super::super::policy::{
    extract_name_by_fields, extract_string_literal, first_named_child_of_kind, has_descendant_kind,
    node_text, LanguagePolicy, SemanticInfo,
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

fn simple_declarator_name(node: Node<'_>, source: &str) -> Option<String> {
    let name = node.child_by_field_name("name")?;
    if name.kind() != "identifier" {
        return None;
    }

    node_text(name, source)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn identifier_text(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "identifier" | "property_identifier" => node_text(node, source)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string),
        _ => None,
    }
}

fn member_expression_property_name(node: Node<'_>, source: &str) -> Option<String> {
    let property = node.child_by_field_name("property")?;
    node_text(property, source)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn member_expression_object_text(node: Node<'_>, source: &str) -> Option<String> {
    let object = node.child_by_field_name("object")?;
    node_text(object, source)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn unwrap_transparent_expression(mut node: Node<'_>) -> Node<'_> {
    loop {
        let next = match node.kind() {
            "parenthesized_expression" => {
                let mut cursor = node.walk();
                let child = node.named_children(&mut cursor).next();
                child
            }
            "as_expression" | "satisfies_expression" | "non_null_expression" => node
                .child_by_field_name("expression")
                .or_else(|| node.child_by_field_name("left"))
                .or_else(|| {
                    let mut cursor = node.walk();
                    let child = node.named_children(&mut cursor).next();
                    child
                }),
            "type_assertion" => node.child_by_field_name("expression").or_else(|| {
                let mut cursor = node.walk();
                let child = node.named_children(&mut cursor).last();
                child
            }),
            _ => None,
        };

        if let Some(next) = next {
            node = next;
            continue;
        }

        return node;
    }
}

fn classify_constant_expression(node: Node<'_>, source: &str) -> Option<bool> {
    let node = unwrap_transparent_expression(node);

    match node.kind() {
        "string" | "string_literal" | "template_string" | "template_literal" | "number"
        | "true" | "false" | "null" => Some(false),
        "object" | "array" => Some(true),
        "identifier" => node_text(node, source)
            .map(str::trim)
            .filter(|text| *text == "undefined")
            .map(|_| false),
        "member_expression" | "subscript_expression" | "meta_property" | "new_expression" => {
            Some(false)
        }
        "unary_expression" => {
            let mut cursor = node.walk();
            let child = node.named_children(&mut cursor).next()?;
            classify_constant_expression(child, source)
        }
        "binary_expression" | "ternary_expression" => {
            let mut coarse_eligible = false;
            let mut saw_child = false;
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                coarse_eligible |= classify_constant_expression(child, source)?;
                saw_child = true;
            }

            saw_child.then_some(coarse_eligible)
        }
        _ => None,
    }
}

fn classify_call_wrapper(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let symbol_name = simple_declarator_name(node, source)?;
    let value = node.child_by_field_name("value")?;
    if value.kind() != "call_expression" {
        return None;
    }

    let function = value.child_by_field_name("function")?;
    let symbol_kind = match function.kind() {
        "member_expression" => match member_expression_property_name(function, source).as_deref() {
            Some("createContext") | Some("createStore") => SymbolKind::Block,
            Some("forwardRef") | Some("memo") | Some("lazy") => SymbolKind::Function,
            _ => SymbolKind::Function,
        },
        "identifier" => SymbolKind::Function,
        _ => SymbolKind::Function,
    };

    Some(SemanticInfo {
        symbol_name: Some(symbol_name),
        symbol_aliases: Vec::new(),
        symbol_kind: Some(symbol_kind),
        chunk_kind: ChunkKind::Code,
        coarse_eligible: false,
        delegate_target_name: None,
    })
}

fn classify_constant_declarator(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let symbol_name = simple_declarator_name(node, source)?;
    let value = node.child_by_field_name("value")?;
    let coarse_eligible = classify_constant_expression(value, source)?;

    Some(SemanticInfo {
        symbol_name: Some(symbol_name),
        symbol_aliases: Vec::new(),
        symbol_kind: Some(SymbolKind::Constant),
        chunk_kind: ChunkKind::Code,
        coarse_eligible,
        delegate_target_name: None,
    })
}

fn classify_export_clause(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let mut names = Vec::new();
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() != "export_specifier" {
            continue;
        }

        if let Some(name) = extract_name_by_fields(child, source, &["alias", "name"]) {
            names.push(name);
        }
    }

    if names.is_empty() {
        return None;
    }

    let display = if names.len() > 3 {
        format!("export{{{},{},{},...}}", names[0], names[1], names[2])
    } else {
        format!("export{{{}}}", names.join(","))
    };

    Some(SemanticInfo {
        symbol_name: Some(display),
        symbol_aliases: Vec::new(),
        symbol_kind: Some(SymbolKind::Module),
        chunk_kind: ChunkKind::Code,
        coarse_eligible: false,
        delegate_target_name: None,
    })
}

fn classify_internal_module(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let symbol_name = node
        .child_by_field_name("name")
        .and_then(|name_node| {
            extract_string_literal(name_node, source).or_else(|| {
                node_text(name_node, source)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(ToString::to_string)
            })
        })
        .or_else(|| extract_name_by_fields(node, source, &["name"]))?;

    Some(SemanticInfo {
        symbol_name: Some(symbol_name),
        symbol_aliases: Vec::new(),
        symbol_kind: Some(SymbolKind::Module),
        chunk_kind: ChunkKind::Code,
        coarse_eligible: true,
        delegate_target_name: None,
    })
}

fn classify_export_default_expression(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let node = unwrap_transparent_expression(node);
    let symbol_name = Some("<default>".to_string());
    match node.kind() {
        "arrow_function" | "function" | "function_expression" => Some(SemanticInfo {
            symbol_name,
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Function),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        "class" => Some(SemanticInfo {
            symbol_name,
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "call_expression" => Some(SemanticInfo {
            symbol_name,
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        "identifier" | "member_expression" => Some(SemanticInfo {
            symbol_name,
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Module),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        _ => classify_constant_expression(node, source).map(|coarse_eligible| SemanticInfo {
            symbol_name,
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Constant),
            chunk_kind: ChunkKind::Code,
            coarse_eligible,
            delegate_target_name: None,
        }),
    }
}

fn delegation_target_for_call(node: Node<'_>, source: &str) -> Option<String> {
    if node.kind() != "call_expression" {
        return None;
    }

    let function = node.child_by_field_name("function")?;
    identifier_text(function, source)
}

fn delegation_target_for_statement(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "return_statement" => {
            let mut cursor = node.walk();
            let child = node
                .named_children(&mut cursor)
                .find(|child| child.kind() != "comment")?;
            delegation_target_for_call(unwrap_transparent_expression(child), source)
        }
        "expression_statement" => {
            let mut cursor = node.walk();
            let child = node
                .named_children(&mut cursor)
                .find(|child| child.kind() != "comment")?;
            delegation_target_for_call(unwrap_transparent_expression(child), source)
        }
        _ => None,
    }
}

fn capitalize_identifier(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };

    let mut capitalized = String::new();
    capitalized.extend(first.to_uppercase());
    capitalized.push_str(chars.as_str());
    capitalized
}

fn is_delegation_variant(caller_name: &str, target_name: &str) -> bool {
    target_name == format!("_{caller_name}")
        || target_name == format!("safe{}", capitalize_identifier(caller_name))
}

fn delegation_target_for_function_like(
    node: Node<'_>,
    source: &str,
    caller_name: &str,
) -> Option<String> {
    let body = node.child_by_field_name("body")?;
    let target_name = match body.kind() {
        "statement_block" => {
            let mut cursor = body.walk();
            let mut statements = body.named_children(&mut cursor).filter(|child| child.kind() != "comment");
            let statement = statements.next()?;
            if statements.next().is_some() {
                return None;
            }
            delegation_target_for_statement(statement, source)?
        }
        _ => delegation_target_for_call(unwrap_transparent_expression(body), source)?,
    };

    is_delegation_variant(caller_name, &target_name).then_some(target_name)
}

fn classify_ambient_declaration(
    node: Node<'_>,
    source: &str,
    allow_commonjs: bool,
) -> Option<SemanticInfo> {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "comment" {
            continue;
        }

        if let Some(info) = classify_ts_js_node_impl(child, source, allow_commonjs) {
            return Some(info);
        }
    }

    None
}

fn classify_internal_module_statement(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    if node.kind() != "expression_statement" {
        return None;
    }

    let internal_module = first_named_child_of_kind(node, "internal_module")?;
    classify_internal_module(internal_module, source)
}

fn classify_export_statement(
    node: Node<'_>,
    source: &str,
    allow_commonjs: bool,
) -> Option<SemanticInfo> {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "comment" {
            continue;
        }

        if matches!(child.kind(), "lexical_declaration" | "variable_declaration") {
            if let Some(declarator) = first_named_child_of_kind(child, "variable_declarator") {
                if let Some(info) = classify_variable_declarator(declarator, source) {
                    return Some(info);
                }
            }
        }

        if let Some(info) = classify_export_default_expression(child, source) {
            return Some(info);
        }

        if let Some(info) = classify_ts_js_node_impl(child, source, allow_commonjs) {
            return Some(info);
        }
    }
    None
}

fn classify_variable_declarator(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let value = node.child_by_field_name("value")?;
    let symbol_name = extract_name_by_fields(node, source, &["name"]);
    let delegate_target_name = symbol_name
        .as_deref()
        .and_then(|name| delegation_target_for_function_like(value, source, name));

    match value.kind() {
        "arrow_function" | "function" | "function_expression" => Some(SemanticInfo {
            symbol_name,
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Function),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
            delegate_target_name,
        }),
        "class" | "class_declaration" => Some(SemanticInfo {
            symbol_name,
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Class),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "call_expression" => classify_call_wrapper(node, source),
        _ => classify_constant_declarator(node, source),
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

    if !is_js_test_call(call, source) {
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
        symbol_aliases: Vec::new(),
        symbol_kind: Some(SymbolKind::Test),
        chunk_kind: ChunkKind::Test,
        coarse_eligible: false,
        delegate_target_name: None,
    })
}

fn is_js_test_call(node: Node<'_>, source: &str) -> bool {
    let Some(function) = node.child_by_field_name("function") else {
        return false;
    };

    match function.kind() {
        "identifier" | "property_identifier" => node_text(function, source)
            .map(|value| JS_TEST_CALLEES.iter().any(|callee| value == *callee))
            .unwrap_or(false),
        "member_expression" => {
            let property = function
                .child_by_field_name("property")
                .and_then(|child| node_text(child, source));
            let object = function
                .child_by_field_name("object")
                .and_then(|child| node_text(child, source))
                .map(str::trim);

            matches!(object, Some("test"))
                && property
                    .map(|value| JS_TEST_CALLEES.iter().any(|callee| value == *callee))
                    .unwrap_or(false)
        }
        _ => false,
    }
}

fn is_registration_method_name(name: &str) -> bool {
    matches!(name, "tool" | "prompt" | "command" | "register")
}

fn has_registration_surface_shape(text: &str) -> bool {
    [".tool(", ".prompt(", ".command(", ".register("]
        .iter()
        .any(|needle| text.contains(needle))
        && (text.contains("=>") || text.contains("function"))
        && (text.contains('"') || text.contains('\'') || text.contains('`'))
}

fn has_registration_tail_shape(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    let has_prompt_payload_shape = (trimmed.contains("messages")
        && trimmed.contains("role:")
        && trimmed.contains("content:")
        && trimmed.contains("text:"))
        || (trimmed.contains("text:")
            && (trimmed.contains("implementation_lookup tool")
                || trimmed.contains("codebase_search for broader discovery")
                || trimmed.contains("Find the definition of:")));
    let has_tool_payload_shape = trimmed.contains("structuredContent:")
        || trimmed.contains("content: [{ type: \"text\"")
        || trimmed.contains("content: [{type:\"text\"");
    let has_registration_closeout = trimmed.contains("return server;")
        || trimmed.ends_with(");")
        || trimmed.ends_with("}),")
        || trimmed.ends_with("})");

    (has_prompt_payload_shape || has_tool_payload_shape)
        && has_registration_closeout
        && (trimmed.contains('"') || trimmed.contains('\'') || trimmed.contains('`'))
}

pub(crate) fn registration_chunk_kind(text: &str, default_kind: &ChunkKind) -> ChunkKind {
    if *default_kind == ChunkKind::Code
        && (has_registration_surface_shape(text) || has_registration_tail_shape(text))
    {
        ChunkKind::Config
    } else {
        default_kind.clone()
    }
}

fn registration_call_from_statement(node: Node<'_>) -> Option<Node<'_>> {
    if node.kind() == "expression_statement" {
        return first_named_child_of_kind(node, "call_expression");
    }

    if node.kind() == "call_expression" {
        return Some(node);
    }

    None
}

fn registration_arguments_are_declarative(call: Node<'_>, _source: &str) -> bool {
    let Some(arguments) = call.child_by_field_name("arguments") else {
        return false;
    };

    let mut has_label = false;
    let mut has_schema_or_handler = false;
    let mut cursor = arguments.walk();
    for argument in arguments.named_children(&mut cursor) {
        let argument = unwrap_transparent_expression(argument);
        match argument.kind() {
            "string" | "string_literal" | "template_string" | "template_literal" => {
                has_label = true;
            }
            "object" | "array" | "arrow_function" | "function" | "function_expression" => {
                has_schema_or_handler = true;
            }
            "identifier"
            | "member_expression"
            | "subscript_expression"
            | "number"
            | "true"
            | "false"
            | "null"
            | "undefined" => {}
            _ => return false,
        }
    }

    has_label && has_schema_or_handler
}

pub(crate) fn is_registration_statement(node: Node<'_>, source: &str) -> bool {
    let statement_text = node_text(node, source)
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let has_registration_shape = statement_text
        .map(has_registration_surface_shape)
        .unwrap_or(false);

    let Some(call) = registration_call_from_statement(node) else {
        return has_registration_shape;
    };

    let Some(function) = call.child_by_field_name("function") else {
        return false;
    };

    let Some(method_name) = (match function.kind() {
        "member_expression" => member_expression_property_name(function, source),
        "identifier" | "property_identifier" => node_text(function, source)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string),
        _ => None,
    }) else {
        return false;
    };

    (is_registration_method_name(&method_name)
        && registration_arguments_are_declarative(call, source))
        || has_registration_shape
}

fn classify_commonjs_assignment(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let assignment = if node.kind() == "expression_statement" {
        first_named_child_of_kind(node, "assignment_expression")
    } else {
        None
    }?;

    let left = assignment.child_by_field_name("left")?;
    if left.kind() != "member_expression" {
        return None;
    }

    let object = member_expression_object_text(left, source)?;
    let property = member_expression_property_name(left, source)?;
    let right = assignment
        .child_by_field_name("right")
        .map(unwrap_transparent_expression);
    let is_constant_export = right
        .map(|rhs| matches!(rhs.kind(), "object" | "array"))
        .unwrap_or(false);

    if object == "module" && property == "exports" {
        return Some(SemanticInfo {
            symbol_name: Some("<module.exports>".to_string()),
            symbol_aliases: Vec::new(),
            symbol_kind: Some(if is_constant_export {
                SymbolKind::Constant
            } else {
                SymbolKind::Module
            }),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: is_constant_export,
            delegate_target_name: None,
        });
    }

    if object == "exports" {
        return Some(SemanticInfo {
            symbol_name: Some(property),
            symbol_aliases: Vec::new(),
            symbol_kind: Some(if is_constant_export {
                SymbolKind::Constant
            } else {
                SymbolKind::Module
            }),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: is_constant_export,
            delegate_target_name: None,
        });
    }

    None
}

fn classify_ts_js_node_impl(
    node: Node<'_>,
    source: &str,
    allow_commonjs: bool,
) -> Option<SemanticInfo> {
    match node.kind() {
        "ambient_declaration" => classify_ambient_declaration(node, source, allow_commonjs),
        "export_statement" => classify_export_statement(node, source, allow_commonjs),
        "export_clause" => classify_export_clause(node, source),
        "function_declaration" | "generator_function_declaration" => {
            let symbol_name = extract_name_by_fields(node, source, &["name"]);
            let delegate_target_name = symbol_name
                .as_deref()
                .and_then(|name| delegation_target_for_function_like(node, source, name));
            Some(SemanticInfo {
                symbol_name,
                symbol_aliases: Vec::new(),
                symbol_kind: Some(SymbolKind::Function),
                chunk_kind: ChunkKind::Code,
                coarse_eligible: false,
                delegate_target_name,
            })
        }
        "method_definition" => {
            let symbol_name = extract_name_by_fields(node, source, &["name", "property"]);
            if symbol_name.as_deref() == Some("constructor") {
                return None;
            }
            Some(SemanticInfo {
                symbol_name,
                symbol_aliases: Vec::new(),
                symbol_kind: Some(SymbolKind::Method),
                chunk_kind: ChunkKind::Code,
                coarse_eligible: false,
                delegate_target_name: None,
            })
        }
        "class_declaration" | "abstract_class_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Class),
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
        "type_alias_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Type),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: false,
            delegate_target_name: None,
        }),
        "enum_declaration" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_aliases: Vec::new(),
            symbol_kind: Some(SymbolKind::Type),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
            delegate_target_name: None,
        }),
        "internal_module" => classify_internal_module(node, source),
        "variable_declarator" => classify_variable_declarator(node, source),
        "expression_statement" | "call_expression" => classify_test_expression(node, source)
            .or_else(|| {
                if allow_commonjs {
                    classify_commonjs_assignment(node, source)
                } else {
                    None
                }
            })
            .or_else(|| classify_internal_module_statement(node, source)),
        "lexical_declaration" if has_descendant_kind(node, &["variable_declarator"]) => None,
        _ => None,
    }
}

fn classify_ts_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    classify_ts_js_node_impl(node, source, false)
}

fn classify_js_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    classify_ts_js_node_impl(node, source, true)
}

pub const TYPESCRIPT_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "typescript",
    parser_language: ts_language,
    classify_node: classify_ts_node,
    is_comment_kind,
};

pub const TSX_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "tsx",
    parser_language: tsx_language,
    classify_node: classify_ts_node,
    is_comment_kind,
};

pub const JAVASCRIPT_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "javascript",
    parser_language: js_language,
    classify_node: classify_js_node,
    is_comment_kind,
};

pub const JSX_POLICY: LanguagePolicy = LanguagePolicy {
    language_name: "jsx",
    parser_language: js_language,
    classify_node: classify_js_node,
    is_comment_kind,
};
