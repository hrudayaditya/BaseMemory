use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::scanner::{normalize_changed_path, scan_single_path};
use super::tree::{
    ancestors_for_file, build_child_map, compute_directory_hash, depth, ensure_parent_directories,
    parent_path, ChildMap,
};
use super::types::{
    IgnoreRules, MerkleDiff, MerkleError, MerkleNode, MerkleNodeKind, MerkleResult, MerkleSnapshot,
};

pub fn diff_snapshots(old: &MerkleSnapshot, new: &MerkleSnapshot) -> MerkleResult<MerkleDiff> {
    if old.root_hash == new.root_hash {
        return Ok(MerkleDiff::default());
    }

    let old_children = build_child_map(&old.nodes);
    let new_children = build_child_map(&new.nodes);
    let mut diff = MerkleDiff::default();
    diff_node(
        "",
        old,
        &old_children,
        new,
        &new_children,
        &mut diff,
    )?;
    diff.sort_and_dedup();
    Ok(diff)
}

pub fn diff_from_events(
    old_snapshot: &MerkleSnapshot,
    changed_paths: &[String],
    repo_root: &Path,
    rules: &IgnoreRules,
) -> MerkleResult<(MerkleDiff, MerkleSnapshot)> {
    let mut next_snapshot = old_snapshot.clone();
    if !next_snapshot.nodes.contains_key("") {
        return Err(MerkleError::InvalidSnapshot(
            "root node missing from snapshot".to_string(),
        ));
    }

    let mut affected_directories = BTreeSet::new();
    affected_directories.insert(String::new());

    let mut normalized_paths: Vec<String> = changed_paths.to_vec();
    normalized_paths.sort();
    normalized_paths.dedup();

    for changed_path in normalized_paths {
        let normalized_changed_path = normalize_changed_path(repo_root, &changed_path)?;
        let scanned = scan_single_path(repo_root, &changed_path, rules)?;
        let target_path = scanned
            .as_ref()
            .map(|file| file.path.clone())
            .unwrap_or(normalized_changed_path);

        affected_directories.extend(ancestors_for_file(&target_path));

        match scanned {
            Some(file) => {
                ensure_parent_directories(&mut next_snapshot.nodes, &file.path);
                affected_directories.extend(ancestors_for_file(&file.path));
                next_snapshot.nodes.insert(
                    file.path.clone(),
                    MerkleNode::file(file.path.clone(), parent_path(&file.path), file.hash, file.size_bytes),
                );
            }
            None => {
                next_snapshot.nodes.remove(&target_path);
            }
        }
    }

    prune_empty_directories(&mut next_snapshot.nodes, &affected_directories);
    recompute_affected_hashes(&mut next_snapshot.nodes, &affected_directories)?;

    next_snapshot.root_hash = next_snapshot
        .nodes
        .get("")
        .map(|node| node.hash.clone())
        .ok_or_else(|| MerkleError::InvalidSnapshot("root node missing after diff".to_string()))?;

    let diff = diff_snapshots(old_snapshot, &next_snapshot)?;
    Ok((diff, next_snapshot))
}

fn diff_node(
    path: &str,
    old: &MerkleSnapshot,
    old_children: &ChildMap,
    new: &MerkleSnapshot,
    new_children: &ChildMap,
    diff: &mut MerkleDiff,
) -> MerkleResult<()> {
    let old_node = old.nodes.get(path);
    let new_node = new.nodes.get(path);

    match (old_node, new_node) {
        (Some(old_node), Some(new_node)) => {
            if old_node.hash == new_node.hash {
                return Ok(());
            }

            match (&old_node.kind, &new_node.kind) {
                (MerkleNodeKind::File, MerkleNodeKind::File) => {
                    if !path.is_empty() {
                        diff.changed_files.push(path.to_string());
                    }
                }
                (MerkleNodeKind::Directory, MerkleNodeKind::Directory) => {
                    let old_child_set = child_set(old_children, path);
                    let new_child_set = child_set(new_children, path);
                    let combined: BTreeSet<String> =
                        old_child_set.union(&new_child_set).cloned().collect();
                    for child in combined {
                        diff_node(&child, old, old_children, new, new_children, diff)?;
                    }
                }
                _ => {
                    collect_subtree_files(old, old_children, path, &mut diff.removed_files)?;
                    collect_subtree_files(new, new_children, path, &mut diff.added_files)?;
                }
            }
        }
        (Some(_), None) => {
            collect_subtree_files(old, old_children, path, &mut diff.removed_files)?;
        }
        (None, Some(_)) => {
            collect_subtree_files(new, new_children, path, &mut diff.added_files)?;
        }
        (None, None) => {}
    }

    Ok(())
}

fn collect_subtree_files(
    snapshot: &MerkleSnapshot,
    child_map: &ChildMap,
    path: &str,
    output: &mut Vec<String>,
) -> MerkleResult<()> {
    let Some(node) = snapshot.nodes.get(path) else {
        return Ok(());
    };

    match node.kind {
        MerkleNodeKind::File => {
            if !path.is_empty() {
                output.push(path.to_string());
            }
        }
        MerkleNodeKind::Directory => {
            if let Some(children) = child_map.get(path) {
                for child in children {
                    collect_subtree_files(snapshot, child_map, child, output)?;
                }
            }
        }
    }

    Ok(())
}

fn child_set(child_map: &ChildMap, path: &str) -> BTreeSet<String> {
    child_map
        .get(path)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect()
}

fn prune_empty_directories(
    nodes: &mut BTreeMap<String, MerkleNode>,
    affected_directories: &BTreeSet<String>,
) {
    let mut directories: Vec<String> = affected_directories.iter().cloned().collect();
    directories.sort_by(|left, right| {
        depth(right)
            .cmp(&depth(left))
            .then_with(|| left.cmp(right))
    });

    let mut changed = true;
    while changed {
        changed = false;
        let child_map = build_child_map(nodes);

        for directory in &directories {
            if directory.is_empty() {
                continue;
            }

            let Some(node) = nodes.get(directory) else {
                continue;
            };

            if node.kind != MerkleNodeKind::Directory {
                continue;
            }

            let has_children = child_map
                .get(directory)
                .map(|children| !children.is_empty())
                .unwrap_or(false);
            if !has_children {
                nodes.remove(directory);
                changed = true;
            }
        }
    }
}

fn recompute_affected_hashes(
    nodes: &mut BTreeMap<String, MerkleNode>,
    affected_directories: &BTreeSet<String>,
) -> MerkleResult<()> {
    let mut directories: Vec<String> = affected_directories.iter().cloned().collect();
    directories.sort_by(|left, right| {
        depth(right)
            .cmp(&depth(left))
            .then_with(|| left.cmp(right))
    });

    let child_map = build_child_map(nodes);
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::merkle::types::{MerkleNode, MerkleSnapshot};

    fn snapshot(branch: &str, files: &[(&str, &str)]) -> MerkleSnapshot {
        let mut nodes = BTreeMap::new();
        nodes.insert(
            String::new(),
            MerkleNode::directory(String::new(), None, crate::hasher::xxhash_content("")),
        );
        for (path, hash) in files {
            ensure_parent_directories(&mut nodes, path);
            nodes.insert(
                (*path).to_string(),
                MerkleNode::file(
                    (*path).to_string(),
                    parent_path(path),
                    (*hash).to_string(),
                    10,
                ),
            );
        }
        let mut snapshot = MerkleSnapshot {
            branch: branch.to_string(),
            root_hash: String::new(),
            nodes,
        };
        let affected_directories = snapshot
            .nodes
            .iter()
            .filter_map(|(path, node)| {
                if node.kind == MerkleNodeKind::Directory {
                    Some(path.clone())
                } else {
                    None
                }
            })
            .collect();
        recompute_affected_hashes(
            &mut snapshot.nodes,
            &affected_directories,
        )
        .unwrap();
        snapshot.root_hash = snapshot.nodes.get("").unwrap().hash.clone();
        snapshot
    }

    #[test]
    fn detects_changed_added_and_removed_files() {
        let old = snapshot("main", &[("src/a.ts", "1111"), ("src/b.ts", "2222")]);
        let new = snapshot("main", &[("src/a.ts", "3333"), ("src/c.ts", "4444")]);

        let diff = diff_snapshots(&old, &new).unwrap();
        assert_eq!(diff.changed_files, vec!["src/a.ts"]);
        assert_eq!(diff.added_files, vec!["src/c.ts"]);
        assert_eq!(diff.removed_files, vec!["src/b.ts"]);
    }
}
