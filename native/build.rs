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

fn main() -> Result<(), Box<dyn Error>> {
    napi_build::setup();
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let chunker_dir = manifest_dir.join("src").join("chunker");
    println!("cargo:rerun-if-changed={}", chunker_dir.display());
    let mut source_files = Vec::new();
    collect_chunker_source_files(&chunker_dir, &chunker_dir, &mut source_files)?;
    source_files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    let mut combined = Vec::new();
    for source_file in source_files {
        println!("cargo:rerun-if-changed={}", source_file.absolute_path.display());
        combined.extend_from_slice(source_file.relative_path.as_bytes());
        combined.push(0);
        combined.extend(fs::read(source_file.absolute_path)?);
        combined.push(0);
    }

    let chunker_version = format!("{:016x}", xxh3_64(&combined));
    println!("cargo:rustc-env=CHUNKER_VERSION={chunker_version}");

    Ok(())
}
