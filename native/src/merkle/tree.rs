use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::scanner::scan_repo;
use super::types::{
    FileHash, IgnoreRules, MerkleError, MerkleNode, MerkleNodeKind, MerkleResult, MerkleSnapshot,
};

pub type ChildMap = BTreeMap<String, Vec<String>>;

pub fn build_merkle_snapshot(
    repo_root: &Path,
    branch: &str,
    rules: &IgnoreRules,
) -> MerkleResult<MerkleSnapshot> {
    let files = scan_repo(repo_root, rules)?;
    build_snapshot_from_files(branch, files)
}

pub fn build_snapshot_from_files(
    branch: &str,
    files: Vec<FileHash>,
) -> MerkleResult<MerkleSnapshot> {
    let mut nodes = BTreeMap::new();
    nodes.insert(
        String::new(),
        MerkleNode::directory(String::new(), None, crate::hasher::xxhash_content("")),
    );

    for file in files {
        ensure_parent_directories(&mut nodes, &file.path);
        let parent_path = parent_path(&file.path);
        nodes.insert(
            file.path.clone(),
            MerkleNode::file(file.path, parent_path, file.hash, file.size_bytes),
        );
    }

    recompute_directory_hashes_for_all(&mut nodes)?;
    let root_hash = nodes
        .get("")
        .map(|node| node.hash.clone())
        .ok_or_else(|| MerkleError::InvalidSnapshot("root node missing".to_string()))?;

    Ok(MerkleSnapshot {
        branch: branch.to_string(),
        root_hash,
        nodes,
    })
}

pub fn build_child_map(nodes: &BTreeMap<String, MerkleNode>) -> ChildMap {
    let mut child_map: ChildMap = BTreeMap::new();

    for (path, node) in nodes {
        if let Some(parent_path) = &node.parent_path {
            child_map
                .entry(parent_path.clone())
                .or_default()
                .push(path.clone());
        }
    }

    for children in child_map.values_mut() {
        children.sort();
    }

    child_map
}

pub fn recompute_directory_hashes_for_paths(
    nodes: &mut BTreeMap<String, MerkleNode>,
    affected_directories: &BTreeSet<String>,
) -> MerkleResult<()> {
    let child_map = build_child_map(nodes);
    let mut directories: Vec<String> = affected_directories.iter().cloned().collect();
    directories.sort_by(|left, right| depth(right).cmp(&depth(left)).then_with(|| left.cmp(right)));

    for directory in directories {
        let Some(node) = nodes.get(&directory) else {
            continue;
        };

        if node.kind != MerkleNodeKind::Directory {
            continue;
        }

        let hash = compute_directory_hash(nodes, &child_map, &directory)?;
        if let Some(entry) = nodes.get_mut(&directory) {
            entry.hash = hash;
        }
    }

    Ok(())
}

pub fn recompute_directory_hashes_for_all(
    nodes: &mut BTreeMap<String, MerkleNode>,
) -> MerkleResult<()> {
    let affected_directories: BTreeSet<String> = nodes
        .iter()
        .filter_map(|(path, node)| {
            if node.kind == MerkleNodeKind::Directory {
                Some(path.clone())
            } else {
                None
            }
        })
        .collect();
    recompute_directory_hashes_for_paths(nodes, &affected_directories)
}

pub fn compute_directory_hash(
    nodes: &BTreeMap<String, MerkleNode>,
    child_map: &ChildMap,
    directory: &str,
) -> MerkleResult<String> {
    let mut payload = String::new();

    if let Some(children) = child_map.get(directory) {
        for child_path in children {
            let child = nodes.get(child_path).ok_or_else(|| {
                MerkleError::InvalidSnapshot(format!(
                    "missing child node '{}' while hashing '{}'",
                    child_path, directory
                ))
            })?;
            payload.push_str(child.kind.as_str());
            payload.push(':');
            payload.push_str(child_path);
            payload.push(':');
            payload.push_str(&child.hash);
            payload.push('\n');
        }
    }

    // We keep xxh3 here to match the project's existing content-addressing story and
    // because this Merkle tree is used for fast local invalidation, not adversarial integrity.
    Ok(crate::hasher::xxhash_content(&payload))
}

pub fn ensure_parent_directories(nodes: &mut BTreeMap<String, MerkleNode>, file_path: &str) {
    let mut current = String::new();
    let segments: Vec<&str> = file_path.split('/').collect();

    for (index, segment) in segments.iter().enumerate() {
        if index + 1 == segments.len() {
            break;
        }

        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(segment);

        let parent = parent_path(&current);
        nodes
            .entry(current.clone())
            .or_insert_with(|| MerkleNode::directory(current.clone(), parent, String::new()));
    }
}

pub fn parent_path(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }

    match path.rsplit_once('/') {
        Some((parent, _)) => Some(parent.to_string()),
        None => Some(String::new()),
    }
}

pub fn ancestors_for_file(path: &str) -> BTreeSet<String> {
    let mut ancestors = BTreeSet::new();
    ancestors.insert(String::new());

    let mut current = parent_path(path);
    while let Some(path) = current {
        ancestors.insert(path.clone());
        current = parent_path(&path);
    }

    ancestors
}

pub fn depth(path: &str) -> usize {
    if path.is_empty() {
        return 0;
    }

    path.split('/').count()
}
