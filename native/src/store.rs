use crate::SearchResult;
use anyhow::{anyhow, Result};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use usearch::{new_index, Index, IndexOptions, MetricKind, ScalarKind};

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
struct StoredMetadata {
    id_to_key: HashMap<u64, String>,
    key_to_id: HashMap<String, u64>,
    metadata: HashMap<String, String>,
    next_id: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct BranchFilterState {
    keys: HashSet<String>,
    ids: HashSet<u64>,
}

pub struct VectorStoreInner {
    index: Index,
    index_path: PathBuf,
    metadata_path: PathBuf,
    stored: StoredMetadata,
    branch_filters: HashMap<String, BranchFilterState>,
    dimensions: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SaveInjectionPoint {
    AfterIndexRename,
}

impl VectorStoreInner {
    fn index_options(dimensions: usize) -> IndexOptions {
        IndexOptions {
            dimensions,
            metric: MetricKind::Cos,
            quantization: ScalarKind::F16,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        }
    }

    fn create_index(dimensions: usize) -> Result<Index> {
        Ok(new_index(&Self::index_options(dimensions))?)
    }

    fn tmp_path_for(path: &PathBuf) -> Result<PathBuf> {
        let file_name = path
            .file_name()
            .ok_or_else(|| anyhow!("Path has no file name: {:?}", path))?
            .to_string_lossy()
            .into_owned();
        Ok(path.with_file_name(format!("{file_name}.tmp")))
    }

    fn warn_recoverable_load_issue(message: &str, details: &str) {
        eprintln!(
            "[vector-store:warn] {} ({}) - treating store as empty and forcing rebuild",
            message, details
        );
    }

    fn reset_in_memory(&mut self) -> Result<()> {
        self.index = Self::create_index(self.dimensions)?;
        self.stored = StoredMetadata::default();
        self.branch_filters.clear();
        Ok(())
    }

    fn remove_key_from_branch_filters(&mut self, key: &str, id: u64, drop_key: bool) {
        for filter in self.branch_filters.values_mut() {
            if !filter.keys.contains(key) {
                continue;
            }

            filter.ids.remove(&id);
            if drop_key {
                filter.keys.remove(key);
            }
        }
    }

    fn refresh_key_in_branch_filters(&mut self, key: &str, old_id: Option<u64>) {
        let new_id = self.stored.key_to_id.get(key).copied();
        for filter in self.branch_filters.values_mut() {
            if !filter.keys.contains(key) {
                continue;
            }

            if let Some(previous_id) = old_id {
                filter.ids.remove(&previous_id);
            }

            if let Some(current_id) = new_id {
                filter.ids.insert(current_id);
            }
        }
    }

    fn cleanup_persistent_state(&self) -> Result<()> {
        for path in [
            self.index_path.clone(),
            self.metadata_path.clone(),
            Self::tmp_path_for(&self.index_path)?,
            Self::tmp_path_for(&self.metadata_path)?,
        ] {
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    fn recover_empty_from_disk_issue(&mut self, message: &str, details: &str) -> Result<bool> {
        Self::warn_recoverable_load_issue(message, details);
        self.cleanup_persistent_state()?;
        self.reset_in_memory()?;
        Ok(true)
    }

    pub fn new(index_path: PathBuf, dimensions: usize) -> Result<Self> {
        let index = Self::create_index(dimensions)?;

        let metadata_path = index_path.with_extension("meta.json");

        let mut store = Self {
            index,
            index_path,
            metadata_path,
            stored: StoredMetadata::default(),
            branch_filters: HashMap::new(),
            dimensions,
        };

        let should_attempt_load = store.index_path.exists()
            || store.metadata_path.exists()
            || Self::tmp_path_for(&store.index_path)?.exists()
            || Self::tmp_path_for(&store.metadata_path)?.exists();
        if should_attempt_load {
            let _ = store.load();
        }

        Ok(store)
    }

    fn clone_index(&self) -> Result<Index> {
        let cloned = Self::create_index(self.dimensions)?;
        if self.index.size() == 0 {
            return Ok(cloned);
        }

        let mut buffer = vec![0_u8; self.index.serialized_length()];
        self.index.save_to_buffer(&mut buffer)?;
        cloned.load_from_buffer(&buffer)?;
        Ok(cloned)
    }

    fn ensure_state_consistency_with(index: &Index, stored: &StoredMetadata) -> Result<()> {
        if stored.id_to_key.len() != stored.key_to_id.len()
            || stored.id_to_key.len() != stored.metadata.len()
        {
            return Err(anyhow!(
                "Vector store metadata maps diverged: id_to_key={}, key_to_id={}, metadata={}",
                stored.id_to_key.len(),
                stored.key_to_id.len(),
                stored.metadata.len()
            ));
        }

        if index.size() != stored.id_to_key.len() {
            return Err(anyhow!(
                "Vector store ANN size {} does not match metadata entries {}",
                index.size(),
                stored.id_to_key.len()
            ));
        }

        for (id, key) in &stored.id_to_key {
            if !index.contains(*id) {
                return Err(anyhow!(
                    "Vector store metadata points to missing ANN entry for key {} ({})",
                    key,
                    id
                ));
            }
            if stored.key_to_id.get(key) != Some(id) {
                return Err(anyhow!(
                    "Vector store key_to_id mismatch for key {}: expected {}, found {:?}",
                    key,
                    id,
                    stored.key_to_id.get(key)
                ));
            }
            if !stored.metadata.contains_key(key) {
                return Err(anyhow!(
                    "Vector store missing metadata payload for key {} ({})",
                    key,
                    id
                ));
            }
        }

        for (key, id) in &stored.key_to_id {
            if stored.id_to_key.get(id) != Some(key) {
                return Err(anyhow!(
                    "Vector store id_to_key mismatch for key {}: expected {}, found {:?}",
                    key,
                    id,
                    stored.id_to_key.get(id)
                ));
            }
            if !index.contains(*id) {
                return Err(anyhow!(
                    "Vector store key_to_id points to missing ANN entry for key {} ({})",
                    key,
                    id
                ));
            }
            if !stored.metadata.contains_key(key) {
                return Err(anyhow!(
                    "Vector store metadata missing for key {} ({})",
                    key,
                    id
                ));
            }
        }

        Ok(())
    }

    fn ensure_state_consistency(&self) -> Result<()> {
        Self::ensure_state_consistency_with(&self.index, &self.stored)
    }

    pub fn add(&mut self, key: &str, vector: &[f32], metadata: &str) -> Result<()> {
        if vector.len() != self.dimensions {
            return Err(anyhow!(
                "Vector dimension mismatch: expected {}, got {}",
                self.dimensions,
                vector.len()
            ));
        }

        let previous_id = self.stored.key_to_id.get(key).copied();
        if let Some(&existing_id) = self.stored.key_to_id.get(key) {
            self.index.remove(existing_id)?;
            self.stored.id_to_key.remove(&existing_id);
        }

        let id = self.stored.next_id;
        self.stored.next_id += 1;

        if self.index.capacity() <= self.index.size() {
            let new_capacity = std::cmp::max(self.index.capacity() * 2, 1024);
            self.index.reserve(new_capacity)?;
        }

        self.index.add(id, vector)?;

        self.stored.id_to_key.insert(id, key.to_string());
        self.stored.key_to_id.insert(key.to_string(), id);
        self.stored
            .metadata
            .insert(key.to_string(), metadata.to_string());
        self.refresh_key_in_branch_filters(key, previous_id);

        Ok(())
    }

    pub fn contains(&self, key: &str) -> bool {
        self.stored
            .key_to_id
            .get(key)
            .copied()
            .map(|id| self.index.contains(id))
            .unwrap_or(false)
    }

    fn add_batch_internal(
        &mut self,
        keys: &[String],
        vectors: &[Vec<f32>],
        metadata: &[String],
        fail_after_inserts: Option<usize>,
    ) -> Result<()> {
        self.ensure_state_consistency()?;

        let shadow_index = self.clone_index()?;
        let mut shadow_stored = self.stored.clone();
        let batch_size = keys.len();
        let replacement_ids: Vec<(String, u64)> = keys
            .iter()
            .filter_map(|key| {
                shadow_stored
                    .key_to_id
                    .get(key)
                    .copied()
                    .map(|id| (key.clone(), id))
            })
            .collect();

        for (_key, id) in &replacement_ids {
            shadow_index.remove(*id)?;
            if let Some(key) = shadow_stored.id_to_key.remove(id) {
                shadow_stored.key_to_id.remove(&key);
                shadow_stored.metadata.remove(&key);
            }
        }

        let current_size = shadow_index.size();
        let needed_capacity = current_size + batch_size;
        let num_threads = rayon::current_num_threads();
        shadow_index.reserve_capacity_and_threads(needed_capacity, num_threads)?;

        let start_id = shadow_stored.next_id;
        let ids: Vec<u64> = (0..batch_size).map(|i| start_id + i as u64).collect();

        if let Some(limit) = fail_after_inserts {
            for (index, (&id, vector)) in ids.iter().zip(vectors.iter()).enumerate() {
                if index >= limit {
                    return Err(anyhow!(
                        "Injected add_batch failure after {} successful shadow inserts",
                        limit
                    ));
                }
                shadow_index.add(id, vector)?;
            }
        } else {
            ids.par_iter()
                .zip(vectors.par_iter())
                .try_for_each(|(&id, vector)| -> Result<()> {
                    shadow_index
                        .add(id, vector)
                        .map_err(|error| anyhow!(error.to_string()))
                })?;
        }

        for (index, key) in keys.iter().enumerate() {
            let id = start_id + index as u64;
            shadow_stored.id_to_key.insert(id, key.clone());
            shadow_stored.key_to_id.insert(key.clone(), id);
            shadow_stored
                .metadata
                .insert(key.clone(), metadata[index].clone());
        }
        shadow_stored.next_id = start_id + batch_size as u64;

        Self::ensure_state_consistency_with(&shadow_index, &shadow_stored)?;

        self.index = shadow_index;
        self.stored = shadow_stored;
        for key in keys {
            let previous_id = replacement_ids
                .iter()
                .find_map(|(replacement_key, id)| (replacement_key == key).then_some(*id));
            self.refresh_key_in_branch_filters(key, previous_id);
        }
        self.ensure_state_consistency()
    }

    pub fn add_batch(
        &mut self,
        keys: &[String],
        vectors: &[Vec<f32>],
        metadata: &[String],
    ) -> Result<()> {
        if keys.len() != vectors.len() || keys.len() != metadata.len() {
            return Err(anyhow!("Mismatched batch sizes"));
        }

        let batch_size = keys.len();
        if batch_size == 0 {
            return Ok(());
        }

        for (i, vector) in vectors.iter().enumerate() {
            if vector.len() != self.dimensions {
                return Err(anyhow!(
                    "Vector {} dimension mismatch: expected {}, got {}",
                    i,
                    self.dimensions,
                    vector.len()
                ));
            }
        }

        self.add_batch_internal(keys, vectors, metadata, None)
    }

    pub fn search(&self, query_vector: &[f32], limit: usize) -> Result<Vec<SearchResult>> {
        if query_vector.len() != self.dimensions {
            return Err(anyhow!(
                "Query vector dimension mismatch: expected {}, got {}",
                self.dimensions,
                query_vector.len()
            ));
        }

        let results = self.index.search(query_vector, limit)?;

        let mut search_results = Vec::with_capacity(results.keys.len());

        for (i, &id) in results.keys.iter().enumerate() {
            if let Some(key) = self.stored.id_to_key.get(&id) {
                let metadata = self.stored.metadata.get(key).cloned().unwrap_or_default();

                let score = 1.0 - results.distances[i] as f64;

                search_results.push(SearchResult {
                    id: key.clone(),
                    score,
                    metadata,
                });
            }
        }

        Ok(search_results)
    }

    pub fn search_filtered(
        &self,
        query_vector: &[f32],
        limit: usize,
        allowed_keys: &HashSet<String>,
    ) -> Result<Vec<SearchResult>> {
        if query_vector.len() != self.dimensions {
            return Err(anyhow!(
                "Query vector dimension mismatch: expected {}, got {}",
                self.dimensions,
                query_vector.len()
            ));
        }

        if allowed_keys.is_empty() {
            return Ok(Vec::new());
        }

        let allowed_ids: HashSet<u64> = allowed_keys
            .iter()
            .filter_map(|key| self.stored.key_to_id.get(key).copied())
            .collect();

        if allowed_ids.is_empty() {
            return Ok(Vec::new());
        }

        let results = self
            .index
            .filtered_search(query_vector, limit, |key| allowed_ids.contains(&key))?;

        let mut search_results = Vec::with_capacity(results.keys.len());

        for (i, &id) in results.keys.iter().enumerate() {
            if let Some(key) = self.stored.id_to_key.get(&id) {
                let metadata = self.stored.metadata.get(key).cloned().unwrap_or_default();

                let score = 1.0 - results.distances[i] as f64;

                search_results.push(SearchResult {
                    id: key.clone(),
                    score,
                    metadata,
                });
            }
        }

        Ok(search_results)
    }

    pub fn search_on_branch(
        &self,
        query_vector: &[f32],
        limit: usize,
        branch: &str,
    ) -> Result<Vec<SearchResult>> {
        if query_vector.len() != self.dimensions {
            return Err(anyhow!(
                "Query vector dimension mismatch: expected {}, got {}",
                self.dimensions,
                query_vector.len()
            ));
        }

        let Some(filter) = self.branch_filters.get(branch) else {
            return Ok(Vec::new());
        };

        if filter.ids.is_empty() {
            return Ok(Vec::new());
        }

        let results = self
            .index
            .filtered_search(query_vector, limit, |key| filter.ids.contains(&key))?;

        let mut search_results = Vec::with_capacity(results.keys.len());

        for (i, &id) in results.keys.iter().enumerate() {
            if let Some(key) = self.stored.id_to_key.get(&id) {
                let metadata = self.stored.metadata.get(key).cloned().unwrap_or_default();

                let score = 1.0 - results.distances[i] as f64;

                search_results.push(SearchResult {
                    id: key.clone(),
                    score,
                    metadata,
                });
            }
        }

        Ok(search_results)
    }

    pub fn branch_contains(&self, branch: &str, chunk_id: &str) -> bool {
        let Some(filter) = self.branch_filters.get(branch) else {
            return false;
        };
        let Some(id) = self.stored.key_to_id.get(chunk_id).copied() else {
            return false;
        };
        filter.keys.contains(chunk_id) && filter.ids.contains(&id)
    }

    pub fn remove(&mut self, key: &str) -> Result<bool> {
        if let Some(&id) = self.stored.key_to_id.get(key) {
            self.index.remove(id)?;
            self.stored.id_to_key.remove(&id);
            self.stored.key_to_id.remove(key);
            self.stored.metadata.remove(key);
            self.remove_key_from_branch_filters(key, id, true);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn set_branch_membership(&mut self, branch: &str, chunk_ids: &[String]) {
        let mut filter = BranchFilterState::default();
        for chunk_id in chunk_ids {
            filter.keys.insert(chunk_id.clone());
            if let Some(id) = self.stored.key_to_id.get(chunk_id).copied() {
                filter.ids.insert(id);
            }
        }
        self.branch_filters.insert(branch.to_string(), filter);
    }

    pub fn apply_branch_delta(&mut self, branch: &str, added: &[String], removed: &[String]) {
        let filter = self
            .branch_filters
            .entry(branch.to_string())
            .or_default();

        for chunk_id in removed {
            if let Some(id) = self.stored.key_to_id.get(chunk_id).copied() {
                filter.ids.remove(&id);
            }
            filter.keys.remove(chunk_id);
        }

        for chunk_id in added {
            filter.keys.insert(chunk_id.clone());
            if let Some(id) = self.stored.key_to_id.get(chunk_id).copied() {
                filter.ids.insert(id);
            }
        }
    }

    pub fn clear_branch_membership(&mut self, branch: &str) {
        self.branch_filters.remove(branch);
    }

    pub fn clear_all_branch_memberships(&mut self) {
        self.branch_filters.clear();
    }

    pub fn save(&self) -> Result<()> {
        self.save_internal(None)
    }

    fn save_internal(&self, inject_failure: Option<SaveInjectionPoint>) -> Result<()> {
        if let Some(parent) = self.index_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let index_tmp_path = Self::tmp_path_for(&self.index_path)?;
        let metadata_tmp_path = Self::tmp_path_for(&self.metadata_path)?;

        if index_tmp_path.exists() {
            fs::remove_file(&index_tmp_path)?;
        }
        if metadata_tmp_path.exists() {
            fs::remove_file(&metadata_tmp_path)?;
        }

        let mut index_buffer = vec![0_u8; self.index.serialized_length()];
        self.index.save_to_buffer(&mut index_buffer)?;
        if let Err(error) = fs::write(&index_tmp_path, index_buffer) {
            let _ = fs::remove_file(&index_tmp_path);
            return Err(error.into());
        }

        if let Err(error) = fs::rename(&index_tmp_path, &self.index_path) {
            let _ = fs::remove_file(&index_tmp_path);
            return Err(error.into());
        }

        if inject_failure == Some(SaveInjectionPoint::AfterIndexRename) {
            return Err(anyhow!(
                "Injected vector-store save failure after ANN rename"
            ));
        }

        let metadata_json = serde_json::to_string(&self.stored)?;
        if let Err(error) = fs::write(&metadata_tmp_path, metadata_json) {
            let _ = fs::remove_file(&metadata_tmp_path);
            return Err(error.into());
        }
        if let Err(error) = fs::rename(&metadata_tmp_path, &self.metadata_path) {
            let _ = fs::remove_file(&metadata_tmp_path);
            return Err(error.into());
        }

        Ok(())
    }

    pub fn load(&mut self) -> Result<bool> {
        let index_tmp_path = Self::tmp_path_for(&self.index_path)?;
        let metadata_tmp_path = Self::tmp_path_for(&self.metadata_path)?;
        if index_tmp_path.exists() || metadata_tmp_path.exists() {
            return self.recover_empty_from_disk_issue(
                "Detected leftover vector store temp files",
                &format!(
                    "index_path={:?} metadata_path={:?}",
                    self.index_path, self.metadata_path
                ),
            );
        }

        let has_index = self.index_path.exists();
        let has_metadata = self.metadata_path.exists();
        if has_index != has_metadata {
            return self.recover_empty_from_disk_issue(
                "Detected partial vector store persistence state",
                &format!(
                    "has_index={} has_metadata={} index_path={:?} metadata_path={:?}",
                    has_index, has_metadata, self.index_path, self.metadata_path
                ),
            );
        }

        if !has_index {
            self.reset_in_memory()?;
            return Ok(false);
        }

        let index_path_str = self
            .index_path
            .to_str()
            .ok_or_else(|| anyhow!("Index path contains invalid UTF-8: {:?}", self.index_path))?
            .to_string();

        let load_result: Result<()> = (|| {
            self.reset_in_memory()?;
            self.index.load(&index_path_str)?;
            let metadata_json = fs::read_to_string(&self.metadata_path)?;
            self.stored = serde_json::from_str(&metadata_json)?;
            self.ensure_state_consistency()
        })();

        match load_result {
            Ok(()) => Ok(false),
            Err(error) => self.recover_empty_from_disk_issue(
                "Failed to load persisted vector store state",
                &error.to_string(),
            ),
        }
    }

    pub fn count(&self) -> usize {
        self.stored.key_to_id.len()
    }

    pub fn clear(&mut self) -> Result<()> {
        self.reset_in_memory()?;
        self.cleanup_persistent_state()
    }

    pub fn get_all_keys(&self) -> Vec<String> {
        self.stored.key_to_id.keys().cloned().collect()
    }

    pub fn get_all_metadata(&self) -> Vec<(String, String)> {
        self.stored
            .metadata
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Get metadata for a single key. O(1) lookup.
    pub fn get_metadata(&self, key: &str) -> Option<String> {
        self.stored.metadata.get(key).cloned()
    }

    /// Get metadata for multiple keys. More efficient than calling get_metadata in a loop
    /// when you need metadata for many specific keys (avoids cloning unused entries).
    pub fn get_metadata_batch(&self, keys: &[String]) -> Vec<(String, String)> {
        keys.iter()
            .filter_map(|k| self.stored.metadata.get(k).map(|v| (k.clone(), v.clone())))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[derive(Debug, PartialEq)]
    struct StoreSnapshot {
        stored: StoredMetadata,
        vectors: Vec<(String, Vec<f32>, String)>,
    }

    fn snapshot_store(store: &VectorStoreInner) -> StoreSnapshot {
        let mut vectors = store
            .stored
            .key_to_id
            .iter()
            .map(|(key, id)| {
                let mut vector = vec![0.0_f32; store.dimensions];
                let matches = store.index.get(*id, &mut vector).unwrap();
                assert_eq!(matches, 1);
                (
                    key.clone(),
                    vector,
                    store.stored.metadata.get(key).cloned().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        vectors.sort_by(|left, right| left.0.cmp(&right.0));

        StoreSnapshot {
            stored: store.stored.clone(),
            vectors,
        }
    }

    #[test]
    fn test_vector_store_basic() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        let mut store = VectorStoreInner::new(index_path, 3).unwrap();

        store
            .add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
            .unwrap();
        store
            .add("vec2", &[0.0, 1.0, 0.0], r#"{"file": "b.ts"}"#)
            .unwrap();
        store
            .add("vec3", &[0.0, 0.0, 1.0], r#"{"file": "c.ts"}"#)
            .unwrap();

        assert_eq!(store.count(), 3);

        let results = store.search(&[1.0, 0.0, 0.0], 2).unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].id, "vec1");
    }

    #[test]
    fn test_vector_store_persistence() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        {
            let mut store = VectorStoreInner::new(index_path.clone(), 3).unwrap();
            store
                .add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
                .unwrap();
            store.save().unwrap();
        }

        {
            let mut store = VectorStoreInner::new(index_path, 3).unwrap();
            store.load().unwrap();
            assert_eq!(store.count(), 1);
        }
    }

    #[test]
    fn test_vector_store_filtered_search() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        let mut store = VectorStoreInner::new(index_path, 3).unwrap();
        store
            .add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
            .unwrap();
        store
            .add("vec2", &[0.9, 0.1, 0.0], r#"{"file": "b.ts"}"#)
            .unwrap();

        let allowed = HashSet::from([String::from("vec2")]);
        let results = store
            .search_filtered(&[1.0, 0.0, 0.0], 5, &allowed)
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "vec2");
    }

    #[test]
    fn test_vector_store_branch_membership_search_and_delta() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        let mut store = VectorStoreInner::new(index_path, 3).unwrap();
        store
            .add("main-a", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
            .unwrap();
        store
            .add("main-b", &[0.9, 0.1, 0.0], r#"{"file": "b.ts"}"#)
            .unwrap();
        store
            .add("feature-c", &[0.0, 1.0, 0.0], r#"{"file": "c.ts"}"#)
            .unwrap();

        store.set_branch_membership(
            "main",
            &[String::from("main-a"), String::from("main-b")],
        );
        store.set_branch_membership("feature", &[String::from("feature-c")]);

        let main_results = store.search_on_branch(&[1.0, 0.0, 0.0], 5, "main").unwrap();
        assert_eq!(main_results.len(), 2);
        assert!(main_results.iter().all(|result| result.id != "feature-c"));

        store.apply_branch_delta("main", &[String::from("feature-c")], &[String::from("main-b")]);
        let updated_main_results = store.search_on_branch(&[0.0, 1.0, 0.0], 5, "main").unwrap();
        assert!(updated_main_results.iter().any(|result| result.id == "feature-c"));
        assert!(updated_main_results.iter().all(|result| result.id != "main-b"));
    }

    #[test]
    fn test_add_batch_failure_leaves_store_unchanged() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        let mut store = VectorStoreInner::new(index_path, 3).unwrap();
        store
            .add("old-a", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
            .unwrap();
        store
            .add("old-b", &[0.0, 1.0, 0.0], r#"{"file": "b.ts"}"#)
            .unwrap();

        let before = snapshot_store(&store);

        let error = store
            .add_batch_internal(
                &[String::from("old-a"), String::from("new-c")],
                &[vec![0.9, 0.1, 0.0], vec![0.0, 0.0, 1.0]],
                &[
                    String::from(r#"{"file": "a2.ts"}"#),
                    String::from(r#"{"file": "c.ts"}"#),
                ],
                Some(1),
            )
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("Injected add_batch failure after 1 successful shadow inserts"));
        assert_eq!(snapshot_store(&store), before);
        store.ensure_state_consistency().unwrap();

        let results = store.search(&[1.0, 0.0, 0.0], 5).unwrap();
        let result_ids: Vec<String> = results.into_iter().map(|result| result.id).collect();
        assert!(result_ids.contains(&String::from("old-a")));
        assert!(!result_ids.contains(&String::from("new-c")));
    }

    #[test]
    fn test_add_batch_keeps_metadata_and_ann_consistent_after_success_and_failure() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        let mut store = VectorStoreInner::new(index_path, 3).unwrap();
        store
            .add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
            .unwrap();
        store
            .add_batch(
                &[String::from("vec2"), String::from("vec3")],
                &[vec![0.0, 1.0, 0.0], vec![0.0, 0.0, 1.0]],
                &[
                    String::from(r#"{"file": "b.ts"}"#),
                    String::from(r#"{"file": "c.ts"}"#),
                ],
            )
            .unwrap();
        store.ensure_state_consistency().unwrap();

        let failed = store.add_batch_internal(
            &[String::from("vec1"), String::from("vec4")],
            &[vec![0.9, 0.1, 0.0], vec![0.3, 0.3, 0.4]],
            &[
                String::from(r#"{"file": "a2.ts"}"#),
                String::from(r#"{"file": "d.ts"}"#),
            ],
            Some(0),
        );
        assert!(failed.is_err());
        store.ensure_state_consistency().unwrap();
        assert_eq!(store.count(), 3);
    }

    #[test]
    fn test_vector_store_load_treats_interrupted_ann_then_metadata_save_as_recoverable() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        let mut store = VectorStoreInner::new(index_path.clone(), 3).unwrap();
        store
            .add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
            .unwrap();
        store.save().unwrap();

        store
            .add("vec2", &[0.0, 1.0, 0.0], r#"{"file": "b.ts"}"#)
            .unwrap();
        let error = store
            .save_internal(Some(SaveInjectionPoint::AfterIndexRename))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("Injected vector-store save failure after ANN rename"));

        let mut reloaded = VectorStoreInner::new(index_path.clone(), 3).unwrap();
        reloaded.load().unwrap();

        assert_eq!(reloaded.count(), 0);
        assert!(!index_path.exists());
        assert!(!index_path.with_extension("meta.json").exists());
        assert!(!VectorStoreInner::tmp_path_for(&index_path)
            .unwrap()
            .exists());
        assert!(
            !VectorStoreInner::tmp_path_for(&index_path.with_extension("meta.json"))
                .unwrap()
                .exists()
        );
    }

    #[test]
    fn test_vector_store_load_treats_leftover_temp_files_as_recoverable() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("test.usearch");

        let mut store = VectorStoreInner::new(index_path.clone(), 3).unwrap();
        store
            .add("vec1", &[1.0, 0.0, 0.0], r#"{"file": "a.ts"}"#)
            .unwrap();
        store.save().unwrap();

        let tmp_path = VectorStoreInner::tmp_path_for(&index_path).unwrap();
        fs::write(&tmp_path, b"partial-ann").unwrap();

        let mut reloaded = VectorStoreInner::new(index_path.clone(), 3).unwrap();
        reloaded.load().unwrap();

        assert_eq!(reloaded.count(), 0);
        assert!(!index_path.exists());
        assert!(!index_path.with_extension("meta.json").exists());
        assert!(!tmp_path.exists());
    }
}
