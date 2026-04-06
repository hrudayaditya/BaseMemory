use super::super::policy::{
    extract_name_by_fields, first_named_child_of_kind, LanguagePolicy, SemanticInfo,
};
use super::super::{ChunkKind, SymbolKind};
use tree_sitter::Node;

fn python_language() -> tree_sitter::Language {
    tree_sitter_python::LANGUAGE.into()
}

fn is_comment_kind(kind: &str) -> bool {
    kind == "comment"
}

fn classify_python_function(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    let name = extract_name_by_fields(node, source, &["name"])?;
    let mut symbol_kind = SymbolKind::Function;
    let mut chunk_kind = ChunkKind::Code;
    let mut ancestor = node.parent();

    while let Some(parent) = ancestor {
        if parent.kind() == "class_definition" {
            symbol_kind = SymbolKind::Method;

            if let Some(class_name) = extract_name_by_fields(parent, source, &["name"]) {
                if class_name.starts_with("Test") {
                    symbol_kind = SymbolKind::Test;
                    chunk_kind = ChunkKind::Test;
                }
            }
            break;
        }

        if parent.kind() == "decorated_definition" {
            symbol_kind = SymbolKind::Method;
        }

        ancestor = parent.parent();
    }

    if name.starts_with("test_") {
        symbol_kind = SymbolKind::Test;
        chunk_kind = ChunkKind::Test;
    }

    Some(SemanticInfo {
        symbol_name: Some(name),
        symbol_kind: Some(symbol_kind),
        chunk_kind,
        coarse_eligible: false,
    })
}

fn classify_python_node(node: Node<'_>, source: &str) -> Option<SemanticInfo> {
    match node.kind() {
        "function_definition" => classify_python_function(node, source),
        "class_definition" => Some(SemanticInfo {
            symbol_name: extract_name_by_fields(node, source, &["name"]),
            symbol_kind: Some(SymbolKind::Class),
            chunk_kind: ChunkKind::Code,
            coarse_eligible: true,
        }),
        "decorated_definition" => {
            let target = first_named_child_of_kind(node, "function_definition")
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
