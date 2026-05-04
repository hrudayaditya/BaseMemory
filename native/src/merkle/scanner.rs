use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use ignore::{
    gitignore::{Gitignore, GitignoreBuilder},
    overrides::{Override, OverrideBuilder},
    Match, WalkBuilder,
};

use super::types::{FileHash, IgnoreRules, MerkleError, MerkleResult};

const DEFAULT_IGNORED_SEGMENTS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    "__pycache__",
    "target",
    "vendor",
    ".opencode",
];

#[derive(Debug)]
struct PatternMatcher {
    include: Override,
    exclude: Gitignore,
    has_include: bool,
}

impl PatternMatcher {
    fn new(repo_root: &Path, rules: &IgnoreRules) -> MerkleResult<Self> {
        let include = build_include_matcher(repo_root, &rules.include)?;
        let exclude = build_exclude_matcher(repo_root, &rules.exclude)?;

        Ok(Self {
            include,
            exclude,
            has_include: !rules.include.is_empty(),
        })
    }

    fn should_include(&self, normalized_path: &str) -> bool {
        let path = Path::new(normalized_path);
        let direct_exclude_match = self.exclude.matched(path, false);
        if direct_exclude_match.is_ignore() {
            return false;
        }
        if direct_exclude_match.is_none()
            && self
                .exclude
                .matched_path_or_any_parents(path, false)
                .is_ignore()
        {
            return false;
        }

        if !self.has_include {
            return false;
        }

        matches!(self.include.matched(path, false), Match::Whitelist(_))
    }
}

fn build_include_matcher(repo_root: &Path, patterns: &[String]) -> MerkleResult<Override> {
    let mut builder = OverrideBuilder::new(repo_root);
    for pattern in expand_patterns(patterns) {
        builder.add(&pattern)?;
    }
    builder.build().map_err(MerkleError::from)
}

fn build_exclude_matcher(repo_root: &Path, patterns: &[String]) -> MerkleResult<Gitignore> {
    let mut builder = GitignoreBuilder::new(repo_root);

    for pattern in DEFAULT_IGNORED_SEGMENTS {
        builder.add_line(None, &format!("{pattern}/"))?;
    }

    for pattern in expand_patterns(patterns) {
        builder.add_line(None, &pattern)?;
    }

    builder.build().map_err(MerkleError::from)
}

fn expand_patterns(patterns: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut expanded = Vec::new();

    for pattern in patterns {
        for entry in expand_braces(pattern) {
            push_pattern(&mut expanded, &mut seen, entry.clone());
            if let Some(stripped) = entry.strip_prefix("**/") {
                push_pattern(&mut expanded, &mut seen, stripped.to_string());
            }
            if let Some(root_anchored) = root_anchored_variant(&entry) {
                push_pattern(&mut expanded, &mut seen, root_anchored);
            }
        }
    }

    expanded
}

fn push_pattern(expanded: &mut Vec<String>, seen: &mut HashSet<String>, pattern: String) {
    if seen.insert(pattern.clone()) {
        expanded.push(pattern);
    }
}

fn root_anchored_variant(pattern: &str) -> Option<String> {
    let (prefix, body) = match pattern.chars().next() {
        Some('!') => ("!", &pattern[1..]),
        Some(_) => ("", pattern),
        None => return None,
    };

    if body.starts_with('/') {
        return None;
    }

    let trimmed = body.trim_end_matches('/');
    if trimmed.is_empty() || trimmed.contains('/') {
        return None;
    }

    Some(format!("{prefix}/{body}"))
}

fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(start) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let Some(end) = pattern[start + 1..].find('}') else {
        return vec![pattern.to_string()];
    };
    let end = start + 1 + end;

    let prefix = &pattern[..start];
    let suffix = &pattern[end + 1..];
    let middle = &pattern[start + 1..end];

    let mut expanded = Vec::new();
    for option in middle.split(',') {
        let variant = format!("{prefix}{option}{suffix}");
        expanded.extend(expand_braces(&variant));
    }
    expanded
}

fn build_walk(_repo_root: &Path, root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder.hidden(false);
    builder.git_ignore(true);
    builder.git_global(true);
    builder.git_exclude(true);
    builder.parents(true);
    builder.follow_links(false);
    builder.same_file_system(false);
    builder.standard_filters(true);
    builder.max_depth(None);
    builder.add_custom_ignore_filename(".gitignore");
    builder.add_custom_ignore_filename(".memignore");
    builder.require_git(false);
    builder
}

pub fn scan_repo(repo_root: &Path, rules: &IgnoreRules) -> MerkleResult<Vec<FileHash>> {
    let matcher = PatternMatcher::new(repo_root, rules)?;
    let mut files = Vec::new();
    let walker = build_walk(repo_root, repo_root).build();

    for entry in walker {
        let entry = entry?;
        if !entry
            .file_type()
            .map(|file_type| file_type.is_file())
            .unwrap_or(false)
        {
            continue;
        }

        let normalized_path = normalize_relative_path(repo_root, entry.path())?;
        if !matcher.should_include(&normalized_path) {
            continue;
        }

        let metadata = entry.metadata()?;
        if metadata.len() > rules.max_file_size {
            eprintln!(
                "[codebase-index] Skipping large file during Merkle scan: {} ({} bytes)",
                normalized_path,
                metadata.len()
            );
            continue;
        }

        let hash = crate::hasher::xxhash_file(entry.path().to_string_lossy().as_ref()).map_err(
            |error| {
                MerkleError::InvalidSnapshot(format!("failed to hash {}: {error}", normalized_path))
            },
        )?;

        files.push(FileHash {
            path: normalized_path,
            hash,
            size_bytes: metadata.len(),
        });
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub fn scan_single_path(
    repo_root: &Path,
    changed_path: &str,
    rules: &IgnoreRules,
) -> MerkleResult<Option<FileHash>> {
    let normalized_path = normalize_changed_path(repo_root, changed_path)?;
    if normalized_path.is_empty() {
        return Ok(None);
    }

    let absolute_path = repo_root.join(relative_to_fs_path(&normalized_path));
    if !absolute_path.exists() {
        return Ok(None);
    }

    let matcher = PatternMatcher::new(repo_root, rules)?;
    let walker = build_walk(repo_root, &absolute_path).build();

    for entry in walker {
        let entry = entry?;
        if !entry
            .file_type()
            .map(|file_type| file_type.is_file())
            .unwrap_or(false)
        {
            continue;
        }

        let entry_path = normalize_relative_path(repo_root, entry.path())?;
        if entry_path != normalized_path {
            continue;
        }

        if !matcher.should_include(&entry_path) {
            return Ok(None);
        }

        let metadata = entry.metadata()?;
        if metadata.len() > rules.max_file_size {
            eprintln!(
                "[codebase-index] Skipping large file during Merkle diff: {} ({} bytes)",
                entry_path,
                metadata.len()
            );
            return Ok(None);
        }

        let hash = crate::hasher::xxhash_file(entry.path().to_string_lossy().as_ref()).map_err(
            |error| MerkleError::InvalidSnapshot(format!("failed to hash {}: {error}", entry_path)),
        )?;

        return Ok(Some(FileHash {
            path: entry_path,
            hash,
            size_bytes: metadata.len(),
        }));
    }

    Ok(None)
}

pub fn normalize_changed_path(repo_root: &Path, changed_path: &str) -> MerkleResult<String> {
    let candidate = Path::new(changed_path);
    if candidate.is_absolute() {
        return normalize_relative_path(repo_root, candidate);
    }

    let full_path = repo_root.join(candidate);
    normalize_relative_path(repo_root, &full_path)
}

pub fn normalize_relative_path(repo_root: &Path, candidate: &Path) -> MerkleResult<String> {
    let relative = candidate.strip_prefix(repo_root).map_err(|_| {
        MerkleError::InvalidPath(format!(
            "{} is outside repo root {}",
            candidate.to_string_lossy(),
            repo_root.to_string_lossy()
        ))
    })?;

    normalize_path(relative)
}

pub fn normalize_path(path: &Path) -> MerkleResult<String> {
    let mut parts = Vec::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(segment) => {
                parts.push(segment.to_string_lossy().into_owned());
            }
            Component::RootDir | Component::Prefix(_) => {}
            Component::ParentDir => {
                return Err(MerkleError::InvalidPath(format!(
                    "path escapes repo root: {}",
                    path.to_string_lossy()
                )));
            }
        }
    }

    Ok(parts.join("/"))
}

pub fn relative_to_fs_path(relative_path: &str) -> PathBuf {
    if relative_path.is_empty() {
        return PathBuf::new();
    }

    let mut buffer = PathBuf::new();
    for segment in relative_path.split('/') {
        if !segment.is_empty() {
            buffer.push(segment);
        }
    }
    buffer
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merkle::types::DEFAULT_MAX_FILE_SIZE;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn normalizes_relative_paths_with_forward_slashes() {
        let normalized = normalize_path(Path::new("src/example/test.ts")).unwrap();
        assert_eq!(normalized, "src/example/test.ts");
    }

    #[test]
    fn rejects_parent_components() {
        let error = normalize_path(Path::new("../etc/passwd")).unwrap_err();
        assert!(matches!(error, MerkleError::InvalidPath(_)));
    }

    #[test]
    fn ignores_default_vendor_directories() {
        let matcher = build_exclude_matcher(Path::new("/repo"), &[]).unwrap();
        assert!(matcher
            .matched_path_or_any_parents(Path::new("src/node_modules/react/index.js"), false)
            .is_ignore());
        assert!(!matcher
            .matched_path_or_any_parents(Path::new("src/react/index.js"), false)
            .is_ignore());
    }

    #[test]
    fn include_matcher_handles_double_star_patterns_from_repo_root() {
        let matcher =
            build_include_matcher(Path::new("/repo"), &[String::from("**/*.ts")]).unwrap();
        assert!(matches!(
            matcher.matched(Path::new("index.ts"), false),
            Match::Whitelist(_)
        ));
        assert!(matches!(
            matcher.matched(Path::new("src/index.ts"), false),
            Match::Whitelist(_)
        ));
        assert!(matcher.matched(Path::new("README.md"), false).is_ignore());
    }

    #[test]
    fn exclude_matcher_honors_negation_patterns() {
        let matcher = PatternMatcher::new(
            Path::new("/repo"),
            &IgnoreRules {
                include: vec![String::from("**/*.ts")],
                exclude: vec![String::from("*.ts"), String::from("!important.ts")],
                max_file_size: DEFAULT_MAX_FILE_SIZE,
            },
        )
        .unwrap();

        assert!(!matcher.should_include("other.ts"));
        assert!(matcher.should_include("important.ts"));
    }

    #[test]
    fn exclude_matcher_honors_directory_only_patterns() {
        let matcher =
            build_exclude_matcher(Path::new("/repo"), &[String::from("generated/")]).unwrap();

        assert!(matcher
            .matched_path_or_any_parents(Path::new("generated/app.js"), false)
            .is_ignore());
        assert!(matcher
            .matched_path_or_any_parents(Path::new("src/generated.rs"), false)
            .is_none());
    }

    #[test]
    fn pattern_matcher_respects_include_and_exclude_rules() {
        let matcher = PatternMatcher::new(
            Path::new("/repo"),
            &IgnoreRules {
                include: vec![String::from("**/*.ts")],
                exclude: vec![String::from("dist/"), String::from("!dist/keep.ts")],
                max_file_size: DEFAULT_MAX_FILE_SIZE,
            },
        )
        .unwrap();

        assert!(matcher.should_include("src/app.ts"));
        assert!(!matcher.should_include("README.md"));
        assert!(!matcher.should_include("dist/out.js"));
        assert!(matcher.should_include("dist/keep.ts"));
    }

    #[test]
    fn scan_repo_honors_memignore_files() {
        let repo = tempdir().unwrap();
        fs::create_dir_all(repo.path().join("packages/docs")).unwrap();
        fs::create_dir_all(repo.path().join("src")).unwrap();
        fs::write(repo.path().join(".memignore"), "packages/docs/\n").unwrap();
        fs::write(repo.path().join("packages/docs/page.ts"), "export const doc = 1;\n").unwrap();
        fs::write(repo.path().join("src/app.ts"), "export const app = 1;\n").unwrap();

        let files = scan_repo(
            repo.path(),
            &IgnoreRules {
                include: vec![String::from("**/*.ts")],
                exclude: Vec::new(),
                max_file_size: DEFAULT_MAX_FILE_SIZE,
            },
        )
        .unwrap();

        let paths: Vec<String> = files.into_iter().map(|file| file.path).collect();
        assert!(paths.iter().any(|path| path == "src/app.ts"));
        assert!(!paths.iter().any(|path| path == "packages/docs/page.ts"));
    }
}
