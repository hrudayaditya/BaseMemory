use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type MerkleResult<T> = Result<T, MerkleError>;

pub const DEFAULT_MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IgnoreRules {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub max_file_size: u64,
}

impl Default for IgnoreRules {
    fn default() -> Self {
        Self {
            include: Vec::new(),
            exclude: Vec::new(),
            max_file_size: DEFAULT_MAX_FILE_SIZE,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileHash {
    pub path: String,
    pub hash: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MerkleNodeKind {
    File,
    Directory,
}

impl MerkleNodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
        }
    }

    pub fn from_str(value: &str) -> MerkleResult<Self> {
        match value {
            "file" => Ok(Self::File),
            "directory" => Ok(Self::Directory),
            other => Err(MerkleError::InvalidSnapshot(format!(
                "unknown node kind: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MerkleNode {
    pub path: String,
    pub parent_path: Option<String>,
    pub kind: MerkleNodeKind,
    pub hash: String,
    pub size_bytes: Option<u64>,
}

impl MerkleNode {
    pub fn file(path: String, parent_path: Option<String>, hash: String, size_bytes: u64) -> Self {
        Self {
            path,
            parent_path,
            kind: MerkleNodeKind::File,
            hash,
            size_bytes: Some(size_bytes),
        }
    }

    pub fn directory(path: String, parent_path: Option<String>, hash: String) -> Self {
        Self {
            path,
            parent_path,
            kind: MerkleNodeKind::Directory,
            hash,
            size_bytes: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MerkleSnapshot {
    pub branch: String,
    pub root_hash: String,
    pub nodes: BTreeMap<String, MerkleNode>,
}

impl MerkleSnapshot {
    pub fn total_nodes(&self) -> usize {
        self.nodes.len()
    }

    pub fn total_files(&self) -> usize {
        self.nodes
            .values()
            .filter(|node| node.kind == MerkleNodeKind::File)
            .count()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MerkleDiff {
    pub changed_files: Vec<String>,
    pub added_files: Vec<String>,
    pub removed_files: Vec<String>,
}

impl MerkleDiff {
    pub fn is_empty(&self) -> bool {
        self.changed_files.is_empty() && self.added_files.is_empty() && self.removed_files.is_empty()
    }

    pub fn sort_and_dedup(&mut self) {
        self.changed_files.sort();
        self.changed_files.dedup();
        self.added_files.sort();
        self.added_files.dedup();
        self.removed_files.sort();
        self.removed_files.dedup();
    }
}

#[derive(Error, Debug)]
pub enum MerkleError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("ignore walk error: {0}")]
    Ignore(#[from] ignore::Error),
    #[error("snapshot missing for branch '{0}'")]
    SnapshotMissing(String),
    #[error("invalid snapshot: {0}")]
    InvalidSnapshot(String),
    #[error("invalid path: {0}")]
    InvalidPath(String),
}
