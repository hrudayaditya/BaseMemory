extern crate napi_build;

use std::env;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use xxhash_rust::xxh3::xxh3_64;

struct ChunkerSourceFile {
    absolute_path: PathBuf,
    relative_path: String,
}

struct GraphExtractorSourceFile {
    absolute_path: PathBuf,
    relative_path: String,
}

fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn collect_chunker_source_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<ChunkerSourceFile>,
) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(current)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_chunker_source_files(root, &path, files)?;
            continue;
        }

        if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(ChunkerSourceFile {
                relative_path: normalize_relative_path(path.strip_prefix(root)?),
                absolute_path: path,
            });
        }
    }

    Ok(())
}

fn collect_graph_query_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<GraphExtractorSourceFile>,
) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(current)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_graph_query_files(root, &path, files)?;
            continue;
        }

        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with("-calls.scm"))
        {
            files.push(GraphExtractorSourceFile {
                relative_path: normalize_relative_path(path.strip_prefix(root)?),
                absolute_path: path,
            });
        }
    }

    Ok(())
}

fn hash_versioned_files(
    source_files: &[(String, PathBuf)],
) -> Result<String, Box<dyn Error>> {
    let mut combined = Vec::new();

    for (relative_path, absolute_path) in source_files {
        println!("cargo:rerun-if-changed={}", absolute_path.display());
        combined.extend_from_slice(relative_path.as_bytes());
        combined.push(0);
        combined.extend(fs::read(absolute_path)?);
        combined.push(0);
    }

    Ok(format!("{:016x}", xxh3_64(&combined)))
}

fn main() -> Result<(), Box<dyn Error>> {
    napi_build::setup();
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let chunker_dir = manifest_dir.join("src").join("chunker");
    println!("cargo:rerun-if-changed={}", chunker_dir.display());
    let mut source_files = Vec::new();
    collect_chunker_source_files(&chunker_dir, &chunker_dir, &mut source_files)?;
    source_files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let chunker_source_files = source_files
        .iter()
        .map(|source_file| {
            (
                source_file.relative_path.clone(),
                source_file.absolute_path.clone(),
            )
        })
        .collect::<Vec<_>>();
    let chunker_version = hash_versioned_files(&chunker_source_files)?;
    println!("cargo:rustc-env=CHUNKER_VERSION={chunker_version}");

    let queries_dir = manifest_dir.join("queries");
    println!("cargo:rerun-if-changed={}", queries_dir.display());

    let mut graph_source_files = vec![
        GraphExtractorSourceFile {
            absolute_path: manifest_dir.join("src").join("call_extractor.rs"),
            relative_path: "src/call_extractor.rs".to_string(),
        },
        GraphExtractorSourceFile {
            absolute_path: manifest_dir.join("src").join("types.rs"),
            relative_path: "src/types.rs".to_string(),
        },
    ];
    collect_graph_query_files(&manifest_dir, &queries_dir, &mut graph_source_files)?;
    graph_source_files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let graph_version_inputs = graph_source_files
        .iter()
        .map(|source_file| {
            (
                source_file.relative_path.clone(),
                source_file.absolute_path.clone(),
            )
        })
        .collect::<Vec<_>>();
    let graph_extractor_version = hash_versioned_files(&graph_version_inputs)?;
    println!("cargo:rustc-env=GRAPH_EXTRACTOR_VERSION={graph_extractor_version}");

    Ok(())
}
