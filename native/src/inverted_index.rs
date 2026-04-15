use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

const BM25_TOKENIZER_VERSION: u32 = 2;

#[derive(Serialize, Deserialize, Default)]
struct InvertedIndexData {
    term_to_chunks: HashMap<String, Vec<String>>,
    chunk_tokens: HashMap<String, HashMap<String, u32>>,
    avg_doc_length: f64,
    tokenizer_version: u32,
}

pub struct InvertedIndexInner {
    index_path: PathBuf,
    term_to_chunks: HashMap<String, HashSet<String>>,
    chunk_tokens: HashMap<String, HashMap<String, u32>>,
    total_token_count: u64,
    branch_filters: HashMap<String, HashSet<String>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SaveInjectionPoint {
    AfterTempWrite,
}

impl InvertedIndexInner {
    pub fn new(index_path: PathBuf) -> Self {
        Self {
            index_path,
            term_to_chunks: HashMap::new(),
            chunk_tokens: HashMap::new(),
            total_token_count: 0,
            branch_filters: HashMap::new(),
        }
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
            "[bm25:warn] {} ({}) - treating index as empty and forcing rebuild",
            message, details
        );
    }

    fn cleanup_persistent_state(&self) -> Result<()> {
        for path in [
            self.index_path.clone(),
            Self::tmp_path_for(&self.index_path)?,
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
        self.clear();
        Ok(true)
    }

    pub fn load(&mut self) -> Result<bool> {
        let tmp_path = Self::tmp_path_for(&self.index_path)?;
        if tmp_path.exists() {
            return self.recover_empty_from_disk_issue(
                "Detected leftover BM25 temp file",
                &format!("index_path={:?}", self.index_path),
            );
        }

        if !self.index_path.exists() {
            self.clear();
            return Ok(false);
        }

        let load_result: Result<InvertedIndexData> = (|| {
            let content = fs::read_to_string(&self.index_path)?;
            Ok(serde_json::from_str(&content)?)
        })();
        let data = match load_result {
            Ok(data) => data,
            Err(error) => {
                return self.recover_empty_from_disk_issue(
                    "Failed to load persisted BM25 state",
                    &error.to_string(),
                );
            }
        };

        if data.tokenizer_version != BM25_TOKENIZER_VERSION {
            return self.recover_empty_from_disk_issue(
                "Detected BM25 tokenizer version mismatch",
                &format!(
                    "stored_version={} runtime_version={}",
                    data.tokenizer_version, BM25_TOKENIZER_VERSION
                ),
            );
        }

        self.term_to_chunks.clear();
        for (term, chunk_ids) in data.term_to_chunks {
            self.term_to_chunks
                .insert(term, chunk_ids.into_iter().collect());
        }

        self.chunk_tokens.clear();
        self.total_token_count = 0;
        for (chunk_id, tokens) in data.chunk_tokens {
            for count in tokens.values() {
                self.total_token_count += *count as u64;
            }
            self.chunk_tokens.insert(chunk_id, tokens);
        }

        Ok(false)
    }

    pub fn save(&self) -> Result<()> {
        self.save_internal(None)
    }

    fn save_internal(&self, inject_failure: Option<SaveInjectionPoint>) -> Result<()> {
        if let Some(parent) = self.index_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut data = InvertedIndexData {
            term_to_chunks: HashMap::new(),
            chunk_tokens: self.chunk_tokens.clone(),
            avg_doc_length: self.get_avg_doc_length(),
            tokenizer_version: BM25_TOKENIZER_VERSION,
        };

        for (term, chunk_ids) in &self.term_to_chunks {
            data.term_to_chunks
                .insert(term.clone(), chunk_ids.iter().cloned().collect());
        }

        let json = serde_json::to_string(&data)?;
        let tmp_path = Self::tmp_path_for(&self.index_path)?;
        if tmp_path.exists() {
            fs::remove_file(&tmp_path)?;
        }
        if let Err(error) = fs::write(&tmp_path, json) {
            let _ = fs::remove_file(&tmp_path);
            return Err(error.into());
        }
        if inject_failure == Some(SaveInjectionPoint::AfterTempWrite) {
            return Err(anyhow!("Injected BM25 save failure after temp write"));
        }
        if let Err(error) = fs::rename(&tmp_path, &self.index_path) {
            let _ = fs::remove_file(&tmp_path);
            return Err(error.into());
        }

        Ok(())
    }

    pub fn add_chunk(&mut self, chunk_id: &str, content: &str) {
        let tokens = self.tokenize(content);
        let mut term_freq: HashMap<String, u32> = HashMap::new();

        for token in &tokens {
            *term_freq.entry(token.clone()).or_insert(0) += 1;

            self.term_to_chunks
                .entry(token.clone())
                .or_default()
                .insert(chunk_id.to_string());
        }

        self.chunk_tokens.insert(chunk_id.to_string(), term_freq);
        self.total_token_count += tokens.len() as u64;
    }

    pub fn remove_chunk(&mut self, chunk_id: &str) -> bool {
        let tokens = match self.chunk_tokens.remove(chunk_id) {
            Some(t) => t,
            None => return false,
        };

        for (token, count) in &tokens {
            self.total_token_count = self.total_token_count.saturating_sub(*count as u64);

            if let Some(chunks) = self.term_to_chunks.get_mut(token) {
                chunks.remove(chunk_id);
                if chunks.is_empty() {
                    self.term_to_chunks.remove(token);
                }
            }
        }

        for filter in self.branch_filters.values_mut() {
            filter.remove(chunk_id);
        }

        true
    }

    pub fn search(&self, query: &str) -> Vec<(String, f64)> {
        self.search_internal(query, None)
    }

    pub fn search_filtered(
        &self,
        query: &str,
        allowed_chunk_ids: &HashSet<String>,
    ) -> Vec<(String, f64)> {
        if allowed_chunk_ids.is_empty() {
            return Vec::new();
        }

        self.search_internal(query, Some(allowed_chunk_ids))
    }

    pub fn search_on_branch(&self, query: &str, branch: &str) -> Vec<(String, f64)> {
        let Some(allowed_chunk_ids) = self.branch_filters.get(branch) else {
            return Vec::new();
        };

        if allowed_chunk_ids.is_empty() {
            return Vec::new();
        }

        self.search_internal(query, Some(allowed_chunk_ids))
    }

    pub fn set_branch_membership(&mut self, branch: &str, chunk_ids: &[String]) {
        self.branch_filters
            .insert(branch.to_string(), chunk_ids.iter().cloned().collect());
    }

    pub fn apply_branch_delta(&mut self, branch: &str, added: &[String], removed: &[String]) {
        let filter = self
            .branch_filters
            .entry(branch.to_string())
            .or_default();

        for chunk_id in removed {
            filter.remove(chunk_id);
        }

        for chunk_id in added {
            filter.insert(chunk_id.clone());
        }
    }

    pub fn clear_branch_membership(&mut self, branch: &str) {
        self.branch_filters.remove(branch);
    }

    pub fn clear_all_branch_memberships(&mut self) {
        self.branch_filters.clear();
    }

    fn search_internal(
        &self,
        query: &str,
        allowed_chunk_ids: Option<&HashSet<String>>,
    ) -> Vec<(String, f64)> {
        let query_tokens = self.tokenize(query);
        if query_tokens.is_empty() {
            return Vec::new();
        }

        let mut candidate_chunks: HashSet<String> = HashSet::new();
        for token in &query_tokens {
            if let Some(chunks) = self.term_to_chunks.get(token) {
                for chunk_id in chunks {
                    if let Some(allowed_ids) = allowed_chunk_ids {
                        if !allowed_ids.contains(chunk_id) {
                            continue;
                        }
                    }
                    candidate_chunks.insert(chunk_id.clone());
                }
            }
        }

        let k1: f64 = 1.2;
        let b: f64 = 0.75;
        let n = self.chunk_tokens.len() as f64;
        let avg_doc_length = self.get_avg_doc_length();

        let mut scores: Vec<(String, f64)> = Vec::new();

        for chunk_id in candidate_chunks {
            let term_freq = match self.chunk_tokens.get(&chunk_id) {
                Some(tf) => tf,
                None => continue,
            };

            let doc_length: u32 = term_freq.values().sum();
            let mut score: f64 = 0.0;

            for term in &query_tokens {
                let tf = *term_freq.get(term).unwrap_or(&0) as f64;
                if tf == 0.0 {
                    continue;
                }

                let df = self.term_to_chunks.get(term).map(|s| s.len()).unwrap_or(0) as f64;
                let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();

                let tf_norm = (tf * (k1 + 1.0))
                    / (tf + k1 * (1.0 - b + b * (doc_length as f64 / avg_doc_length)));
                score += idf * tf_norm;
            }

            if score > 0.0 {
                scores.push((chunk_id, score));
            }
        }

        let max_score = scores.iter().map(|(_, s)| *s).fold(1.0_f64, f64::max);
        for (_, score) in &mut scores {
            *score /= max_score;
        }

        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scores
    }

    pub fn has_chunk(&self, chunk_id: &str) -> bool {
        self.chunk_tokens.contains_key(chunk_id)
    }

    pub fn branch_contains(&self, branch: &str, chunk_id: &str) -> bool {
        self.branch_filters
            .get(branch)
            .map(|filter| filter.contains(chunk_id) && self.has_chunk(chunk_id))
            .unwrap_or(false)
    }

    pub fn clear(&mut self) {
        self.term_to_chunks.clear();
        self.chunk_tokens.clear();
        self.total_token_count = 0;
        self.branch_filters.clear();
    }

    pub fn document_count(&self) -> usize {
        self.chunk_tokens.len()
    }

    fn get_avg_doc_length(&self) -> f64 {
        let count = self.chunk_tokens.len();
        if count > 0 {
            self.total_token_count as f64 / count as f64
        } else {
            100.0
        }
    }

    fn tokenize(&self, text: &str) -> Vec<String> {
        tokenize_code_aware(text)
    }
}

fn tokenize_code_aware(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        if is_token_char(ch) {
            current.push(ch);
        } else if !current.is_empty() {
            emit_token_variants(&current, &mut tokens);
            current.clear();
        }
    }

    if !current.is_empty() {
        emit_token_variants(&current, &mut tokens);
    }

    tokens
}

fn is_token_char(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '_' | '-' | '/' | '\\' | '.')
}

fn emit_token_variants(raw_token: &str, output: &mut Vec<String>) {
    if raw_token.is_empty() {
        return;
    }

    let mut seen = HashSet::new();
    collect_token(raw_token, &mut seen);

    for token in seen {
        output.push(token);
    }
}

fn collect_token(token: &str, output: &mut HashSet<String>) {
    let normalized = token.trim().to_lowercase();
    if normalized.is_empty() {
        return;
    }

    output.insert(normalized.clone());

    for path_component in token
        .split(|ch| matches!(ch, '/' | '\\'))
        .filter(|component| !component.is_empty())
    {
        collect_path_component(path_component, output);
    }
}

fn collect_path_component(component: &str, output: &mut HashSet<String>) {
    let normalized = component.trim().to_lowercase();
    if normalized.is_empty() {
        return;
    }

    output.insert(normalized);

    for dot_component in component.split('.').filter(|part| !part.is_empty()) {
        collect_identifier(dot_component, output);
    }
}

fn collect_identifier(identifier: &str, output: &mut HashSet<String>) {
    let normalized = identifier.trim().to_lowercase();
    if normalized.is_empty() {
        return;
    }

    output.insert(normalized);

    for delimiter_component in identifier
        .split(|ch| matches!(ch, '_' | '-'))
        .filter(|part| !part.is_empty())
    {
        collect_camel_case_terms(delimiter_component, output);
    }
}

fn collect_camel_case_terms(identifier: &str, output: &mut HashSet<String>) {
    let mut parts: Vec<String> = Vec::new();
    let chars: Vec<char> = identifier.chars().collect();
    if chars.is_empty() {
        return;
    }

    let mut current = String::new();
    for index in 0..chars.len() {
        let ch = chars[index];
        if index > 0 {
            let prev = chars[index - 1];
            let next = chars.get(index + 1).copied();
            let starts_new_word = ch.is_uppercase()
                && (prev.is_lowercase()
                    || prev.is_ascii_digit()
                    || next.is_some_and(|next_char| next_char.is_lowercase()));
            if starts_new_word && !current.is_empty() {
                parts.push(current.clone());
                current.clear();
            }
        }
        current.push(ch);
    }

    if !current.is_empty() {
        parts.push(current);
    }

    for part in parts {
        let normalized = part.trim().to_lowercase();
        if !normalized.is_empty() {
            output.insert(normalized);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn token_set(text: &str) -> HashSet<String> {
        tokenize_code_aware(text).into_iter().collect()
    }

    #[test]
    fn test_inverted_index_basic() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path);

        index.add_chunk("chunk1", "function handleError throws exception");
        index.add_chunk("chunk2", "class UserController handles requests");
        index.add_chunk("chunk3", "error logging and debugging");

        assert_eq!(index.document_count(), 3);

        let results = index.search("error handling");
        assert!(!results.is_empty());

        let chunk_ids: Vec<&str> = results.iter().map(|(id, _)| id.as_str()).collect();
        assert!(chunk_ids.contains(&"chunk1") || chunk_ids.contains(&"chunk3"));
    }

    #[test]
    fn test_code_aware_tokenizer_keeps_short_meaningful_terms() {
        let tokens = token_set("db fs io id ts ui");
        for token in ["db", "fs", "io", "id", "ts", "ui"] {
            assert!(tokens.contains(token), "missing token {token}");
        }
    }

    #[test]
    fn test_code_aware_tokenizer_splits_identifiers_and_paths() {
        let camel = token_set("getUserId buildPerQueryResult");
        for token in [
            "getuserid",
            "get",
            "user",
            "id",
            "buildperqueryresult",
            "build",
            "per",
            "query",
            "result",
        ] {
            assert!(camel.contains(token), "missing camel token {token}");
        }

        let snake = token_set("DEFAULT_FINAL_RERANK_TOP_N");
        for token in [
            "default_final_rerank_top_n",
            "default",
            "final",
            "rerank",
            "top",
            "n",
        ] {
            assert!(snake.contains(token), "missing snake token {token}");
        }

        let path_tokens = token_set("src/config/load-env.ts");
        for token in [
            "src/config/load-env.ts",
            "src",
            "config",
            "load-env.ts",
            "load-env",
            "load",
            "env",
            "ts",
        ] {
            assert!(path_tokens.contains(token), "missing path token {token}");
        }
    }

    #[test]
    fn test_inverted_index_remove() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path);

        index.add_chunk("chunk1", "function handleError");
        index.add_chunk("chunk2", "class UserController");

        assert_eq!(index.document_count(), 2);

        index.remove_chunk("chunk1");
        assert_eq!(index.document_count(), 1);
        assert!(!index.has_chunk("chunk1"));
        assert!(index.has_chunk("chunk2"));
    }

    #[test]
    fn test_inverted_index_filtered_search() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path);

        index.add_chunk("chunk1", "function handle error throws exception");
        index.add_chunk("chunk2", "function handle error with retries");

        let allowed = HashSet::from([String::from("chunk2")]);
        let results = index.search_filtered("handle error", &allowed);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "chunk2");
    }

    #[test]
    fn test_inverted_index_branch_membership_search_and_delta() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path);
        index.add_chunk("main-a", "validate user input data");
        index.add_chunk("main-b", "validate request payload");
        index.add_chunk("feature-c", "feature branch search token");

        index.set_branch_membership(
            "main",
            &[String::from("main-a"), String::from("main-b")],
        );
        index.set_branch_membership("feature", &[String::from("feature-c")]);

        let main_results = index.search_on_branch("validate", "main");
        assert_eq!(main_results.len(), 2);
        assert!(main_results.iter().all(|(chunk_id, _)| chunk_id != "feature-c"));

        index.apply_branch_delta("main", &[String::from("feature-c")], &[String::from("main-b")]);
        let updated_main_results = index.search_on_branch("feature", "main");
        assert_eq!(updated_main_results.len(), 1);
        assert_eq!(updated_main_results[0].0, "feature-c");
    }

    #[test]
    fn test_inverted_index_query_and_index_tokenization_are_consistent() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path);
        index.add_chunk("chunk1", "function getUserId(user) { return user.id; }");

        let results = index.search("user id");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "chunk1");
    }

    #[test]
    fn test_inverted_index_persistence() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        {
            let mut index = InvertedIndexInner::new(index_path.clone());
            index.add_chunk("chunk1", "function handleError throws exception");
            index.save().unwrap();
        }

        {
            let mut index = InvertedIndexInner::new(index_path);
            index.load().unwrap();
            assert_eq!(index.document_count(), 1);
            assert!(index.has_chunk("chunk1"));
        }
    }

    #[test]
    fn test_inverted_index_load_treats_leftover_temp_file_as_recoverable_corruption() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path.clone());
        index.add_chunk("chunk1", "function handleError throws exception");
        index.save().unwrap();

        let tmp_path = InvertedIndexInner::tmp_path_for(&index_path).unwrap();
        fs::write(&tmp_path, "{\"partial\":true}").unwrap();

        let mut reloaded = InvertedIndexInner::new(index_path.clone());
        reloaded.load().unwrap();

        assert_eq!(reloaded.document_count(), 0);
        assert!(!index_path.exists());
        assert!(!tmp_path.exists());
    }

    #[test]
    fn test_inverted_index_atomic_save_does_not_publish_temp_file() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path.clone());
        index.add_chunk("chunk1", "stable live state");
        index.save().unwrap();

        index.add_chunk("chunk2", "new state that should not publish");
        let error = index
            .save_internal(Some(SaveInjectionPoint::AfterTempWrite))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("Injected BM25 save failure after temp write"));

        let mut reloaded = InvertedIndexInner::new(index_path.clone());
        reloaded.load().unwrap();
        assert_eq!(reloaded.document_count(), 0);
        assert!(!index_path.exists());
        assert!(!InvertedIndexInner::tmp_path_for(&index_path)
            .unwrap()
            .exists());
    }

    #[test]
    fn test_inverted_index_load_treats_tokenizer_version_mismatch_as_recoverable_corruption() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("inverted-index.json");

        let mut index = InvertedIndexInner::new(index_path.clone());
        index.add_chunk("chunk1", "function getUserId(user) { return user.id; }");
        index.save().unwrap();

        let content = fs::read_to_string(&index_path).unwrap();
        let stale_content = content.replace(
            &format!("\"tokenizer_version\":{}", BM25_TOKENIZER_VERSION),
            "\"tokenizer_version\":1",
        );
        fs::write(&index_path, stale_content).unwrap();

        let mut reloaded = InvertedIndexInner::new(index_path.clone());
        let recovered = reloaded.load().unwrap();

        assert!(recovered);
        assert_eq!(reloaded.document_count(), 0);
        assert!(!index_path.exists());
    }
}
