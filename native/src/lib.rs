#![deny(clippy::all)]

mod call_extractor;
mod chunker;
mod db;
mod hasher;
mod inverted_index;
mod merkle;
mod parser;
mod store;
mod types;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashSet;
use std::path::PathBuf;

pub use chunker::{Chunk, ChunkConfig, ChunkKind, Granularity, SymbolKind};
pub use hasher::*;
pub use inverted_index::*;
pub use merkle::{
    build_merkle_snapshot as build_merkle_snapshot_internal,
    diff_from_events as diff_merkle_from_events_internal,
    diff_snapshots as diff_merkle_snapshots_internal,
    FileHash as MerkleFileHash,
    IgnoreRules as InternalMerkleIgnoreRules,
    MerkleDiff as InternalMerkleDiff,
    MerkleError as InternalMerkleError,
    MerkleNode as InternalMerkleNode,
    MerkleNodeKind as InternalMerkleNodeKind,
    MerkleSnapshot as InternalMerkleSnapshot,
};
pub use parser::*;
pub use store::*;
pub use types::*;

#[napi]
pub fn chunk_file(
    file_path: String,
    language: String,
    source_code: String,
    config: Option<ChunkConfig>,
) -> Result<Vec<Chunk>> {
    chunker::chunk_file(
        &file_path,
        &language,
        &source_code,
        &config.unwrap_or_default(),
    )
    .map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_file(file_path: String, content: String) -> Result<Vec<CodeChunk>> {
    parser::parse_file_internal(&file_path, &content).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_files(files: Vec<FileInput>) -> Result<Vec<ParsedFile>> {
    parser::parse_files_parallel(files).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn hash_content(content: String) -> String {
    hasher::xxhash_content(&content)
}

#[napi]
pub fn hash_file(file_path: String) -> Result<String> {
    hasher::xxhash_file(&file_path).map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn get_chunker_version() -> String {
    chunker::CHUNKER_VERSION.to_string()
}

#[napi]
pub fn extract_calls(content: String, language: String) -> Result<Vec<CallSiteData>> {
    call_extractor::extract_calls(&content, &language)
        .map(|sites| {
            sites
                .into_iter()
                .map(|s| CallSiteData {
                    callee_name: s.callee_name,
                    line: s.line,
                    column: s.column,
                    call_type: format!("{:?}", s.call_type),
                })
                .collect()
        })
        .map_err(|e| Error::from_reason(e.to_string()))
}

#[napi(object)]
pub struct MerkleIgnoreRules {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub max_file_size: Option<u32>,
}

#[napi(object)]
pub struct MerkleDiffData {
    pub changed_files: Vec<String>,
    pub added_files: Vec<String>,
    pub removed_files: Vec<String>,
}

#[napi(object)]
pub struct PreparedMerkleDiffData {
    pub changed_files: Vec<String>,
    pub added_files: Vec<String>,
    pub removed_files: Vec<String>,
    pub next_snapshot: String,
}

#[napi(object)]
pub struct MerkleSnapshotPayload {
    pub branch: String,
    pub root_hash: String,
    pub total_nodes: u32,
    pub total_files: u32,
    pub snapshot: String,
}

impl From<MerkleIgnoreRules> for merkle::IgnoreRules {
    fn from(value: MerkleIgnoreRules) -> Self {
        Self {
            include: value.include,
            exclude: value.exclude,
            max_file_size: value
                .max_file_size
                .map(|size| size as u64)
                .unwrap_or(merkle::types::DEFAULT_MAX_FILE_SIZE),
        }
    }
}

fn serialize_snapshot(snapshot: &merkle::MerkleSnapshot) -> Result<String> {
    serde_json::to_string(snapshot).map_err(|error| Error::from_reason(error.to_string()))
}

fn deserialize_snapshot(snapshot: &str) -> Result<merkle::MerkleSnapshot> {
    serde_json::from_str(snapshot).map_err(|error| Error::from_reason(error.to_string()))
}

fn merkle_diff_to_js(diff: merkle::MerkleDiff) -> MerkleDiffData {
    MerkleDiffData {
        changed_files: diff.changed_files,
        added_files: diff.added_files,
        removed_files: diff.removed_files,
    }
}

fn merkle_snapshot_payload(snapshot: merkle::MerkleSnapshot) -> Result<MerkleSnapshotPayload> {
    let branch = snapshot.branch.clone();
    let root_hash = snapshot.root_hash.clone();
    let total_nodes = snapshot.total_nodes() as u32;
    let total_files = snapshot.total_files() as u32;
    let snapshot = serialize_snapshot(&snapshot)?;

    Ok(MerkleSnapshotPayload {
        branch,
        root_hash,
        total_nodes,
        total_files,
        snapshot,
    })
}

pub struct BuildMerkleSnapshotTask {
    repo_root: String,
    branch: String,
    ignore_rules: merkle::IgnoreRules,
}

impl napi::Task for BuildMerkleSnapshotTask {
    type Output = MerkleSnapshotPayload;
    type JsValue = MerkleSnapshotPayload;

    fn compute(&mut self) -> Result<Self::Output> {
        let snapshot = merkle::build_merkle_snapshot(
            std::path::Path::new(&self.repo_root),
            &self.branch,
            &self.ignore_rules,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;
        merkle_snapshot_payload(snapshot)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct DiffMerkleSnapshotsTask {
    old_snapshot: String,
    new_snapshot: String,
}

impl napi::Task for DiffMerkleSnapshotsTask {
    type Output = MerkleDiffData;
    type JsValue = MerkleDiffData;

    fn compute(&mut self) -> Result<Self::Output> {
        let old_snapshot = deserialize_snapshot(&self.old_snapshot)?;
        let new_snapshot = deserialize_snapshot(&self.new_snapshot)?;
        let diff = merkle::diff_snapshots(&old_snapshot, &new_snapshot)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(merkle_diff_to_js(diff))
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct DiffMerkleFromEventsTask {
    old_snapshot: String,
    changed_paths: Vec<String>,
    repo_root: String,
    ignore_rules: merkle::IgnoreRules,
}

impl napi::Task for DiffMerkleFromEventsTask {
    type Output = PreparedMerkleDiffData;
    type JsValue = PreparedMerkleDiffData;

    fn compute(&mut self) -> Result<Self::Output> {
        let old_snapshot = deserialize_snapshot(&self.old_snapshot)?;
        let (diff, next_snapshot) = merkle::diff_from_events(
            &old_snapshot,
            &self.changed_paths,
            std::path::Path::new(&self.repo_root),
            &self.ignore_rules,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;

        let next_snapshot = serialize_snapshot(&next_snapshot)?;
        Ok(PreparedMerkleDiffData {
            changed_files: diff.changed_files,
            added_files: diff.added_files,
            removed_files: diff.removed_files,
            next_snapshot,
        })
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn build_merkle_snapshot(
    repo_root: String,
    branch: String,
    ignore_rules: Option<MerkleIgnoreRules>,
) -> AsyncTask<BuildMerkleSnapshotTask> {
    AsyncTask::new(BuildMerkleSnapshotTask {
        repo_root,
        branch,
        ignore_rules: ignore_rules.unwrap_or(MerkleIgnoreRules {
            include: Vec::new(),
            exclude: Vec::new(),
            max_file_size: None,
        })
        .into(),
    })
}

#[napi]
pub fn diff_merkle_snapshots(
    old_snapshot: String,
    new_snapshot: String,
) -> AsyncTask<DiffMerkleSnapshotsTask> {
    AsyncTask::new(DiffMerkleSnapshotsTask {
        old_snapshot,
        new_snapshot,
    })
}

#[napi]
pub fn diff_merkle_from_events(
    old_snapshot: String,
    changed_paths: Vec<String>,
    repo_root: String,
    ignore_rules: Option<MerkleIgnoreRules>,
) -> AsyncTask<DiffMerkleFromEventsTask> {
    AsyncTask::new(DiffMerkleFromEventsTask {
        old_snapshot,
        changed_paths,
        repo_root,
        ignore_rules: ignore_rules.unwrap_or(MerkleIgnoreRules {
            include: Vec::new(),
            exclude: Vec::new(),
            max_file_size: None,
        })
        .into(),
    })
}

#[napi]
pub struct VectorStore {
    inner: store::VectorStoreInner,
}

#[napi]
impl VectorStore {
    #[napi(constructor)]
    pub fn new(index_path: String, dimensions: u32) -> Result<Self> {
        let inner = store::VectorStoreInner::new(PathBuf::from(index_path), dimensions as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self { inner })
    }

    #[napi]
    pub fn add(&mut self, id: String, vector: Vec<f64>, metadata: String) -> Result<()> {
        let vector_f32: Vec<f32> = vector.iter().map(|&x| x as f32).collect();
        self.inner
            .add(&id, &vector_f32, &metadata)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_batch(
        &mut self,
        ids: Vec<String>,
        vectors: Vec<Vec<f64>>,
        metadata: Vec<String>,
    ) -> Result<()> {
        let vectors_f32: Vec<Vec<f32>> = vectors
            .iter()
            .map(|v| v.iter().map(|&x| x as f32).collect())
            .collect();
        self.inner
            .add_batch(&ids, &vectors_f32, &metadata)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn search(&self, query_vector: Vec<f64>, limit: u32) -> Result<Vec<SearchResult>> {
        let query_f32: Vec<f32> = query_vector.iter().map(|&x| x as f32).collect();
        self.inner
            .search(&query_f32, limit as usize)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn search_filtered(
        &self,
        query_vector: Vec<f64>,
        limit: u32,
        allowed_ids: Vec<String>,
    ) -> Result<Vec<SearchResult>> {
        let query_f32: Vec<f32> = query_vector.iter().map(|&x| x as f32).collect();
        let allowed: HashSet<String> = allowed_ids.into_iter().collect();
        self.inner
            .search_filtered(&query_f32, limit as usize, &allowed)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn remove(&mut self, id: String) -> Result<bool> {
        self.inner
            .remove(&id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn save(&self) -> Result<()> {
        self.inner
            .save()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn load(&mut self) -> Result<()> {
        self.inner
            .load()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn count(&self) -> u32 {
        self.inner.count() as u32
    }

    #[napi]
    pub fn clear(&mut self) -> Result<()> {
        self.inner
            .clear()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_all_keys(&self) -> Vec<String> {
        self.inner.get_all_keys()
    }

    #[napi]
    pub fn get_all_metadata(&self) -> Vec<KeyMetadataPair> {
        self.inner
            .get_all_metadata()
            .into_iter()
            .map(|(key, metadata)| KeyMetadataPair { key, metadata })
            .collect()
    }

    #[napi]
    pub fn get_metadata(&self, id: String) -> Option<String> {
        self.inner.get_metadata(&id)
    }

    #[napi]
    pub fn get_metadata_batch(&self, ids: Vec<String>) -> Vec<KeyMetadataPair> {
        self.inner
            .get_metadata_batch(&ids)
            .into_iter()
            .map(|(key, metadata)| KeyMetadataPair { key, metadata })
            .collect()
    }
}

#[napi(object)]
pub struct FileInput {
    pub path: String,
    pub content: String,
}

#[napi(object)]
pub struct ParsedFile {
    pub path: String,
    pub chunks: Vec<CodeChunk>,
    pub hash: String,
}

#[napi(object)]
pub struct CodeChunk {
    pub content: String,
    pub start_line: u32,
    pub end_line: u32,
    pub chunk_type: String,
    pub name: Option<String>,
    pub language: String,
}

#[napi(object)]
pub struct SearchResult {
    pub id: String,
    pub score: f64,
    pub metadata: String,
}

#[napi(object)]
pub struct KeyMetadataPair {
    pub key: String,
    pub metadata: String,
}

#[napi(object)]
pub struct CallSiteData {
    pub callee_name: String,
    pub line: u32,
    pub column: u32,
    pub call_type: String,
}

#[napi(object)]
pub struct SymbolData {
    pub id: String,
    pub file_path: String,
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub language: String,
}

#[napi(object)]
pub struct CallEdgeData {
    pub id: String,
    pub branch: String,
    pub from_symbol_id: String,
    pub from_symbol_name: Option<String>,
    pub from_symbol_file_path: Option<String>,
    pub caller_file_path: Option<String>,
    pub target_name: String,
    pub target_file_path: Option<String>,
    pub target_kind: Option<String>,
    pub to_symbol_id: Option<String>,
    pub call_type: String,
    pub line: u32,
    pub col: u32,
    pub is_resolved: bool,
}

#[napi(object)]
pub struct KeywordSearchResult {
    pub chunk_id: String,
    pub score: f64,
}

#[napi]
pub struct InvertedIndex {
    inner: inverted_index::InvertedIndexInner,
}

#[napi]
impl InvertedIndex {
    #[napi(constructor)]
    pub fn new(index_path: String) -> Self {
        let inner = inverted_index::InvertedIndexInner::new(PathBuf::from(index_path));
        Self { inner }
    }

    #[napi]
    pub fn load(&mut self) -> Result<()> {
        self.inner
            .load()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn save(&self) -> Result<()> {
        self.inner
            .save()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_chunk(&mut self, chunk_id: String, content: String) {
        self.inner.add_chunk(&chunk_id, &content);
    }

    #[napi]
    pub fn remove_chunk(&mut self, chunk_id: String) -> bool {
        self.inner.remove_chunk(&chunk_id)
    }

    #[napi]
    pub fn search(&self, query: String, limit: Option<u32>) -> Vec<KeywordSearchResult> {
        let results = self.inner.search(&query);
        let limit = limit.unwrap_or(100) as usize;
        results
            .into_iter()
            .take(limit)
            .map(|(chunk_id, score)| KeywordSearchResult { chunk_id, score })
            .collect()
    }

    #[napi]
    pub fn search_filtered(
        &self,
        query: String,
        allowed_chunk_ids: Vec<String>,
        limit: Option<u32>,
    ) -> Vec<KeywordSearchResult> {
        let allowed: HashSet<String> = allowed_chunk_ids.into_iter().collect();
        let results = self.inner.search_filtered(&query, &allowed);
        let limit = limit.unwrap_or(100) as usize;
        results
            .into_iter()
            .take(limit)
            .map(|(chunk_id, score)| KeywordSearchResult { chunk_id, score })
            .collect()
    }

    #[napi]
    pub fn has_chunk(&self, chunk_id: String) -> bool {
        self.inner.has_chunk(&chunk_id)
    }

    #[napi]
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    #[napi]
    pub fn document_count(&self) -> u32 {
        self.inner.document_count() as u32
    }
}

#[napi]
pub struct Database {
    conn: std::sync::Mutex<rusqlite::Connection>,
}

#[napi(object)]
pub struct ChunkData {
    pub chunk_id: String,
    pub content_hash: String,
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub node_type: Option<String>,
    pub name: Option<String>,
    pub chunk_kind: Option<String>,
    pub symbol_kind: Option<String>,
    pub language: String,
}

#[napi(object)]
pub struct ChunkKindEnrichmentData {
    pub chunk_id: String,
    pub chunk_kind: Option<String>,
    pub symbol_kind: Option<String>,
}

#[napi(object)]
pub struct BranchDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[napi(object)]
pub struct EmbeddingBatchItem {
    pub content_hash: String,
    pub embedding: Buffer,
    pub chunk_text: String,
    pub model: String,
}

#[napi(object)]
pub struct DatabaseStats {
    pub embedding_count: u32,
    pub chunk_count: u32,
    pub branch_chunk_count: u32,
    pub branch_count: u32,
    pub symbol_count: u32,
    pub call_edge_count: u32,
}

#[napi(object)]
pub struct PipelineStateData {
    pub branch: String,
    pub file_path: String,
    pub stage: String,
    pub status: String,
    pub input_hash: Option<String>,
    pub error: Option<String>,
    pub updated_at: f64,
}

#[napi(object)]
pub struct PipelineRunData {
    pub run_id: String,
    pub branch: String,
    pub run_type: String,
    pub status: String,
    pub config_hash: String,
    pub started_at: f64,
    pub completed_at: Option<f64>,
}

#[napi(object)]
pub struct ConfigVersionData {
    pub config_hash: String,
    pub embedding_model_id: String,
    pub embedding_dimension: u32,
    pub chunker_version: String,
    pub graph_extractor_version: String,
    pub active: bool,
    pub created_at: f64,
}

#[napi]
impl Database {
    #[napi(constructor)]
    pub fn new(db_path: String) -> Result<Self> {
        let conn = db::init_db(std::path::Path::new(&db_path))
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self {
            conn: std::sync::Mutex::new(conn),
        })
    }

    #[napi]
    pub fn embedding_exists(&self, content_hash: String) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::embedding_exists(&conn, &content_hash).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_embedding(&self, content_hash: String) -> Result<Option<Buffer>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let result = db::get_embedding(&conn, &content_hash)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(result.map(Buffer::from))
    }

    #[napi]
    pub fn upsert_embedding(
        &self,
        content_hash: String,
        embedding: Buffer,
        chunk_text: String,
        model: String,
    ) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::upsert_embedding(&conn, &content_hash, &embedding, &chunk_text, &model)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_missing_embeddings(&self, content_hashes: Vec<String>) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_missing_embeddings(&conn, &content_hashes)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_missing_embeddings_for_model(
        &self,
        content_hashes: Vec<String>,
        model: String,
    ) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_missing_embeddings_for_model(&conn, &content_hashes, &model)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_chunk(&self, chunk: ChunkData) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::upsert_chunk(
            &conn,
            &chunk.chunk_id,
            &chunk.content_hash,
            &chunk.file_path,
            chunk.start_line,
            chunk.end_line,
            chunk.node_type.as_deref(),
            chunk.name.as_deref(),
            chunk.chunk_kind.as_deref(),
            chunk.symbol_kind.as_deref(),
            &chunk.language,
        )
        .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_chunk(&self, chunk_id: String) -> Result<Option<ChunkData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let result =
            db::get_chunk(&conn, &chunk_id).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(result.map(|row| ChunkData {
            chunk_id: row.chunk_id,
            content_hash: row.content_hash,
            file_path: row.file_path,
            start_line: row.start_line,
            end_line: row.end_line,
            node_type: row.node_type,
            name: row.name,
            chunk_kind: row.chunk_kind,
            symbol_kind: row.symbol_kind,
            language: row.language,
        }))
    }

    #[napi]
    pub fn get_chunks_by_file(&self, file_path: String) -> Result<Vec<ChunkData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_chunks_by_file(&conn, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| ChunkData {
                chunk_id: row.chunk_id,
                content_hash: row.content_hash,
                file_path: row.file_path,
                start_line: row.start_line,
                end_line: row.end_line,
                node_type: row.node_type,
                name: row.name,
                chunk_kind: row.chunk_kind,
                symbol_kind: row.symbol_kind,
                language: row.language,
            })
            .collect())
    }

    #[napi]
    pub fn get_chunks_by_name(&self, name: String) -> Result<Vec<ChunkData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows =
            db::get_chunks_by_name(&conn, &name).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| ChunkData {
                chunk_id: row.chunk_id,
                content_hash: row.content_hash,
                file_path: row.file_path,
                start_line: row.start_line,
                end_line: row.end_line,
                node_type: row.node_type,
                name: row.name,
                chunk_kind: row.chunk_kind,
                symbol_kind: row.symbol_kind,
                language: row.language,
            })
            .collect())
    }

    #[napi]
    pub fn get_chunks_by_name_ci(&self, name: String) -> Result<Vec<ChunkData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_chunks_by_name_ci(&conn, &name)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| ChunkData {
                chunk_id: row.chunk_id,
                content_hash: row.content_hash,
                file_path: row.file_path,
                start_line: row.start_line,
                end_line: row.end_line,
                node_type: row.node_type,
                name: row.name,
                chunk_kind: row.chunk_kind,
                symbol_kind: row.symbol_kind,
                language: row.language,
            })
            .collect())
    }

    #[napi]
    pub fn get_chunk_kinds_batch(
        &self,
        chunk_ids: Vec<String>,
    ) -> Result<Vec<ChunkKindEnrichmentData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_chunk_kinds_batch(&conn, &chunk_ids)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| ChunkKindEnrichmentData {
                chunk_id: row.chunk_id,
                chunk_kind: row.chunk_kind,
                symbol_kind: row.symbol_kind,
            })
            .collect())
    }

    #[napi]
    pub fn delete_chunks_by_file(&self, file_path: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::delete_chunks_by_file(&conn, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn add_chunks_to_branch(&self, branch: String, chunk_ids: Vec<String>) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::add_chunks_to_branch(&conn, &branch, &chunk_ids)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_embeddings_batch(&self, items: Vec<EmbeddingBatchItem>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let batch: Vec<(String, Vec<u8>, String, String)> = items
            .into_iter()
            .map(|item| {
                (
                    item.content_hash,
                    item.embedding.to_vec(),
                    item.chunk_text,
                    item.model,
                )
            })
            .collect();
        db::upsert_embeddings_batch(&mut conn, &batch)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_chunks_batch(&self, chunks: Vec<ChunkData>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let batch: Vec<db::ChunkRow> = chunks
            .into_iter()
            .map(|c| db::ChunkRow {
                chunk_id: c.chunk_id,
                content_hash: c.content_hash,
                file_path: c.file_path,
                start_line: c.start_line,
                end_line: c.end_line,
                node_type: c.node_type,
                name: c.name,
                chunk_kind: c.chunk_kind,
                symbol_kind: c.symbol_kind,
                language: c.language,
            })
            .collect();
        db::upsert_chunks_batch(&mut conn, &batch).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_chunks_to_branch_batch(&self, branch: String, chunk_ids: Vec<String>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::add_chunks_to_branch_batch(&mut conn, &branch, &chunk_ids)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn clear_branch(&self, branch: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count =
            db::clear_branch(&conn, &branch).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn clear_all_branches(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::clear_all_branches(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn get_branch_chunk_ids(&self, branch: String) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_branch_chunk_ids(&conn, &branch).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_branch_delta(&self, branch: String, base_branch: String) -> Result<BranchDelta> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let delta = db::get_branch_delta(&conn, &branch, &base_branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(BranchDelta {
            added: delta.added,
            removed: delta.removed,
        })
    }

    #[napi]
    pub fn chunk_exists_on_branch(&self, branch: String, chunk_id: String) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::chunk_exists_on_branch(&conn, &branch, &chunk_id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn chunk_exists_on_other_branches(
        &self,
        branch: String,
        chunk_id: String,
    ) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::chunk_exists_on_other_branches(&conn, &branch, &chunk_id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_all_branches(&self) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_all_branches(&conn).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_metadata(&self, key: String) -> Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_metadata(&conn, &key).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn set_metadata(&self, key: String, value: String) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::set_metadata(&conn, &key, &value).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn delete_metadata(&self, key: String) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::delete_metadata(&conn, &key).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_merkle_snapshot(&self, branch: String) -> Result<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let snapshot = merkle::store::load_snapshot(&conn, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        snapshot
            .map(|value| serialize_snapshot(&value))
            .transpose()
    }

    #[napi]
    pub fn save_merkle_snapshot(&self, snapshot: String) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let snapshot = deserialize_snapshot(&snapshot)?;
        merkle::store::save_snapshot(&mut conn, &snapshot)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn delete_merkle_snapshot(&self, branch: String) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        merkle::store::delete_snapshot(&conn, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn clear_all_merkle_snapshots(&self) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        merkle::store::clear_all_snapshots(&conn)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn gc_orphan_embeddings(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count =
            db::gc_orphan_embeddings(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn gc_orphan_chunks(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::gc_orphan_chunks(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn get_stats(&self) -> Result<DatabaseStats> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let stats = db::get_stats(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(DatabaseStats {
            embedding_count: stats.embedding_count as u32,
            chunk_count: stats.chunk_count as u32,
            branch_chunk_count: stats.branch_chunk_count as u32,
            branch_count: stats.branch_count as u32,
            symbol_count: stats.symbol_count as u32,
            call_edge_count: stats.call_edge_count as u32,
        })
    }

    // ── Pipeline state methods ─────────────────────────────────────

    #[napi]
    pub fn upsert_pipeline_state(&self, state: PipelineStateData) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let row = db::PipelineStateRow {
            branch: state.branch,
            file_path: state.file_path,
            stage: state.stage,
            status: state.status,
            input_hash: state.input_hash,
            error: state.error,
            updated_at: state.updated_at as i64,
        };
        db::upsert_pipeline_state(&conn, &row).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_pipeline_state(
        &self,
        branch: String,
        file_path: String,
        stage: String,
    ) -> Result<Option<PipelineStateData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let result = db::get_pipeline_state(&conn, &branch, &file_path, &stage)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(result.map(|row| PipelineStateData {
            branch: row.branch,
            file_path: row.file_path,
            stage: row.stage,
            status: row.status,
            input_hash: row.input_hash,
            error: row.error,
            updated_at: row.updated_at as f64,
        }))
    }

    #[napi]
    pub fn get_unfinished_pipeline_files(&self, branch: String) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_unfinished_pipeline_files(&conn, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_known_pipeline_files(&self, branch: String) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_known_pipeline_files(&conn, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn reset_pipeline_stage(
        &self,
        branch: String,
        stage: String,
        updated_at: f64,
    ) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::reset_pipeline_stage(&conn, &branch, &stage, updated_at as i64)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn clear_pipeline_state_for_branch(&self, branch: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::clear_pipeline_state_for_branch(&conn, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn clear_pipeline_state_for_file(&self, branch: String, file_path: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::clear_pipeline_state_for_file(&conn, &branch, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    // ── Pipeline run methods ───────────────────────────────────────

    #[napi]
    pub fn start_pipeline_run(&self, run: PipelineRunData, cancelled_at: f64) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let row = db::PipelineRunRow {
            run_id: run.run_id,
            branch: run.branch,
            run_type: run.run_type,
            status: run.status,
            config_hash: run.config_hash,
            started_at: run.started_at as i64,
            completed_at: run.completed_at.map(|value| value as i64),
        };
        db::start_pipeline_run(&mut conn, &row, cancelled_at as i64)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn update_pipeline_run_status(
        &self,
        run_id: String,
        status: String,
        completed_at: f64,
    ) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::update_pipeline_run_status(&conn, &run_id, &status, completed_at as i64)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_pipeline_run(&self, run_id: String) -> Result<Option<PipelineRunData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let result = db::get_pipeline_run(&conn, &run_id)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(result.map(|row| PipelineRunData {
            run_id: row.run_id,
            branch: row.branch,
            run_type: row.run_type,
            status: row.status,
            config_hash: row.config_hash,
            started_at: row.started_at as f64,
            completed_at: row.completed_at.map(|value| value as f64),
        }))
    }

    #[napi]
    pub fn cancel_active_pipeline_runs(&self, branch: String, cancelled_at: f64) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::cancel_active_pipeline_runs(&conn, &branch, cancelled_at as i64)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn get_active_pipeline_runs(&self) -> Result<Vec<PipelineRunData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows =
            db::get_active_pipeline_runs(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| PipelineRunData {
                run_id: row.run_id,
                branch: row.branch,
                run_type: row.run_type,
                status: row.status,
                config_hash: row.config_hash,
                started_at: row.started_at as f64,
                completed_at: row.completed_at.map(|value| value as f64),
            })
            .collect())
    }

    #[napi]
    pub fn prune_finished_pipeline_runs(&self, older_than: f64) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::prune_finished_pipeline_runs(&conn, older_than as i64)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    // ── Config version methods ─────────────────────────────────────

    #[napi]
    pub fn get_active_config_version(&self) -> Result<Option<ConfigVersionData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let result = db::get_active_config_version(&conn)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(result.map(|row| ConfigVersionData {
            config_hash: row.config_hash,
            embedding_model_id: row.embedding_model_id,
            embedding_dimension: row.embedding_dimension as u32,
            chunker_version: row.chunker_version,
            graph_extractor_version: row.graph_extractor_version,
            active: row.active,
            created_at: row.created_at as f64,
        }))
    }

    #[napi]
    pub fn activate_config_version(&self, config_version: ConfigVersionData) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let row = db::ConfigVersionRow {
            config_hash: config_version.config_hash,
            embedding_model_id: config_version.embedding_model_id,
            embedding_dimension: config_version.embedding_dimension as i64,
            chunker_version: config_version.chunker_version,
            graph_extractor_version: config_version.graph_extractor_version,
            active: config_version.active,
            created_at: config_version.created_at as i64,
        };
        db::activate_config_version(&mut conn, &row).map_err(|e| Error::from_reason(e.to_string()))
    }

    // ── Symbol methods ──────────────────────────────────────────────

    #[napi]
    pub fn upsert_symbol(&self, symbol: SymbolData) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let row = db::SymbolRow {
            id: symbol.id,
            file_path: symbol.file_path,
            name: symbol.name,
            kind: symbol.kind,
            start_line: symbol.start_line,
            start_col: symbol.start_col,
            end_line: symbol.end_line,
            end_col: symbol.end_col,
            language: symbol.language,
        };
        db::upsert_symbol(&conn, &row).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_symbols_batch(&self, symbols: Vec<SymbolData>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows: Vec<db::SymbolRow> = symbols
            .into_iter()
            .map(|s| db::SymbolRow {
                id: s.id,
                file_path: s.file_path,
                name: s.name,
                kind: s.kind,
                start_line: s.start_line,
                start_col: s.start_col,
                end_line: s.end_line,
                end_col: s.end_col,
                language: s.language,
            })
            .collect();
        db::upsert_symbols_batch(&mut conn, &rows).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_symbols_by_file(&self, file_path: String) -> Result<Vec<SymbolData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_symbols_by_file(&conn, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| SymbolData {
                id: r.id,
                file_path: r.file_path,
                name: r.name,
                kind: r.kind,
                start_line: r.start_line,
                start_col: r.start_col,
                end_line: r.end_line,
                end_col: r.end_col,
                language: r.language,
            })
            .collect())
    }

    #[napi]
    pub fn get_symbol_by_id(&self, symbol_id: String) -> Result<Option<SymbolData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let row = db::get_symbol_by_id(&conn, &symbol_id)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(row.map(|r| SymbolData {
            id: r.id,
            file_path: r.file_path,
            name: r.name,
            kind: r.kind,
            start_line: r.start_line,
            start_col: r.start_col,
            end_line: r.end_line,
            end_col: r.end_col,
            language: r.language,
        }))
    }

    #[napi]
    pub fn get_symbol_by_name(
        &self,
        name: String,
        file_path: String,
    ) -> Result<Option<SymbolData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let row = db::get_symbol_by_name(&conn, &name, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(row.map(|r| SymbolData {
            id: r.id,
            file_path: r.file_path,
            name: r.name,
            kind: r.kind,
            start_line: r.start_line,
            start_col: r.start_col,
            end_line: r.end_line,
            end_col: r.end_col,
            language: r.language,
        }))
    }

    #[napi]
    pub fn get_symbols_by_name(&self, name: String) -> Result<Vec<SymbolData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows =
            db::get_symbols_by_name(&conn, &name).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| SymbolData {
                id: r.id,
                file_path: r.file_path,
                name: r.name,
                kind: r.kind,
                start_line: r.start_line,
                start_col: r.start_col,
                end_line: r.end_line,
                end_col: r.end_col,
                language: r.language,
            })
            .collect())
    }

    #[napi]
    pub fn get_symbols_by_name_ci(&self, name: String) -> Result<Vec<SymbolData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_symbols_by_name_ci(&conn, &name)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| SymbolData {
                id: r.id,
                file_path: r.file_path,
                name: r.name,
                kind: r.kind,
                start_line: r.start_line,
                start_col: r.start_col,
                end_line: r.end_line,
                end_col: r.end_col,
                language: r.language,
            })
            .collect())
    }

    #[napi]
    pub fn symbol_exists_on_other_branches(
        &self,
        branch: String,
        symbol_id: String,
    ) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::symbol_exists_on_other_branches(&conn, &branch, &symbol_id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn delete_symbols_by_file(&self, file_path: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::delete_symbols_by_file(&conn, &file_path)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn delete_symbol(&self, symbol_id: String) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::delete_symbol(&conn, &symbol_id).map_err(|e| Error::from_reason(e.to_string()))
    }

    // ── Call Edge methods ────────────────────────────────────────────

    #[napi]
    pub fn upsert_call_edge(&self, edge: CallEdgeData) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let row = db::CallEdgeRow {
            id: edge.id,
            branch: edge.branch,
            from_symbol_id: edge.from_symbol_id,
            caller_file_path: edge.caller_file_path.or(edge.from_symbol_file_path),
            target_name: edge.target_name,
            target_file_path: edge.target_file_path,
            target_kind: edge.target_kind,
            to_symbol_id: edge.to_symbol_id,
            call_type: edge.call_type,
            line: edge.line,
            col: edge.col,
            is_resolved: edge.is_resolved,
        };
        db::upsert_call_edge(&conn, &row).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn upsert_call_edges_batch(&self, edges: Vec<CallEdgeData>) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows: Vec<db::CallEdgeRow> = edges
            .into_iter()
            .map(|e| db::CallEdgeRow {
                id: e.id,
                branch: e.branch,
                from_symbol_id: e.from_symbol_id,
                caller_file_path: e.caller_file_path.or(e.from_symbol_file_path),
                target_name: e.target_name,
                target_file_path: e.target_file_path,
                target_kind: e.target_kind,
                to_symbol_id: e.to_symbol_id,
                call_type: e.call_type,
                line: e.line,
                col: e.col,
                is_resolved: e.is_resolved,
            })
            .collect();
        db::upsert_call_edges_batch(&mut conn, &rows).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_callers(&self, symbol_name: String, branch: String) -> Result<Vec<CallEdgeData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_callers(&conn, &symbol_name, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| CallEdgeData {
                id: r.id,
                branch: r.branch,
                from_symbol_id: r.from_symbol_id,
                from_symbol_name: None,
                from_symbol_file_path: None,
                caller_file_path: r.caller_file_path,
                target_name: r.target_name,
                target_file_path: r.target_file_path,
                target_kind: r.target_kind,
                to_symbol_id: r.to_symbol_id,
                call_type: r.call_type,
                line: r.line,
                col: r.col,
                is_resolved: r.is_resolved,
            })
            .collect())
    }

    #[napi]
    pub fn get_callees(&self, symbol_id: String, branch: String) -> Result<Vec<CallEdgeData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_callees(&conn, &symbol_id, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| CallEdgeData {
                id: r.id,
                branch: r.branch,
                from_symbol_id: r.from_symbol_id,
                from_symbol_name: None,
                from_symbol_file_path: None,
                caller_file_path: r.caller_file_path,
                target_name: r.target_name,
                target_file_path: r.target_file_path,
                target_kind: r.target_kind,
                to_symbol_id: r.to_symbol_id,
                call_type: r.call_type,
                line: r.line,
                col: r.col,
                is_resolved: r.is_resolved,
            })
            .collect())
    }

    #[napi]
    pub fn get_callers_with_context(
        &self,
        symbol_name: String,
        branch: String,
    ) -> Result<Vec<CallEdgeData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_callers_with_context(&conn, &symbol_name, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let from_symbol_file_path = r.from_symbol_file_path;
                CallEdgeData {
                id: r.id,
                branch: branch.clone(),
                from_symbol_id: r.from_symbol_id,
                from_symbol_name: Some(r.from_symbol_name),
                from_symbol_file_path: Some(from_symbol_file_path.clone()),
                caller_file_path: Some(from_symbol_file_path),
                target_name: r.target_name,
                target_file_path: r.target_file_path,
                target_kind: r.target_kind,
                to_symbol_id: r.to_symbol_id,
                call_type: r.call_type,
                line: r.line,
                col: r.col,
                is_resolved: r.is_resolved,
            }})
            .collect())
    }

    #[napi]
    pub fn get_callers_with_context_by_target_symbol_id(
        &self,
        target_symbol_id: String,
        branch: String,
    ) -> Result<Vec<CallEdgeData>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let rows = db::get_callers_with_context_by_target_symbol_id(&conn, &target_symbol_id, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let from_symbol_file_path = r.from_symbol_file_path;
                CallEdgeData {
                id: r.id,
                branch: branch.clone(),
                from_symbol_id: r.from_symbol_id,
                from_symbol_name: Some(r.from_symbol_name),
                from_symbol_file_path: Some(from_symbol_file_path.clone()),
                caller_file_path: Some(from_symbol_file_path),
                target_name: r.target_name,
                target_file_path: r.target_file_path,
                target_kind: r.target_kind,
                to_symbol_id: r.to_symbol_id,
                call_type: r.call_type,
                line: r.line,
                col: r.col,
                is_resolved: r.is_resolved,
            }})
            .collect())
    }

    #[napi]
    pub fn delete_call_edges_by_file(&self, file_path: String, branch: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::delete_call_edges_by_file(&conn, &file_path, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn delete_call_edges_by_symbol(&self, symbol_id: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::delete_call_edges_by_symbol(&conn, &symbol_id)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn delete_call_edges_by_symbol_for_branch(
        &self,
        symbol_id: String,
        branch: String,
    ) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::delete_call_edges_by_symbol_for_branch(&conn, &symbol_id, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn resolve_call_edge(
        &self,
        edge_id: String,
        branch: String,
        to_symbol_id: String,
        target_file_path: Option<String>,
        target_kind: Option<String>,
    ) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::resolve_call_edge(
            &conn,
            &edge_id,
            &branch,
            &to_symbol_id,
            target_file_path.as_deref(),
            target_kind.as_deref(),
        )
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    // ── Branch Symbol methods ────────────────────────────────────────

    #[napi]
    pub fn add_symbols_to_branch(&self, branch: String, symbol_ids: Vec<String>) -> Result<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::add_symbols_to_branch(&conn, &branch, &symbol_ids)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn add_symbols_to_branch_batch(
        &self,
        branch: String,
        symbol_ids: Vec<String>,
    ) -> Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::add_symbols_to_branch_batch(&mut conn, &branch, &symbol_ids)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_branch_symbol_ids(&self, branch: String) -> Result<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        db::get_branch_symbol_ids(&conn, &branch).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn clear_branch_symbols(&self, branch: String) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::clear_branch_symbols(&conn, &branch)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn clear_all_branch_symbols(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::clear_all_branch_symbols(&conn)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    // ── GC methods for symbols/edges ─────────────────────────────────

    #[napi]
    pub fn gc_orphan_symbols(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count = db::gc_orphan_symbols(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }

    #[napi]
    pub fn gc_orphan_call_edges(&self) -> Result<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let count =
            db::gc_orphan_call_edges(&conn).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(count as u32)
    }
}
