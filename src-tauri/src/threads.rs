use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::workspace::write_file_atomic;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedThreadItem {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedThread {
    pub id: String,
    pub title: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub messages: Vec<SavedThreadItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocumentThreadsFile {
    pub file_path: String,
    pub active_thread_id: Option<String>,
    pub threads: Vec<SavedThread>,
}

/// Resolves the per-user threads directory outside any git repo
/// (e.g. `~/Library/Application Support/com.henrydashwood.writer/threads`).
pub fn resolve_threads_dir(app: &AppHandle) -> PathBuf {
    if let Ok(cfg_dir) = app.path().app_config_dir() {
        return cfg_dir.join("threads");
    }
    PathBuf::from("threads")
}

/// Stable 64-bit FNV-1a hash so every document maps cleanly to one JSON file on disk
/// regardless of slashes, spaces, or path length.
fn doc_storage_path(threads_dir: &Path, file_path: &str) -> PathBuf {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in file_path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    threads_dir.join(format!("doc-{hash:016x}.json"))
}

pub fn load_document_threads(threads_dir: &Path, file_path: &str) -> DocumentThreadsFile {
    let path = doc_storage_path(threads_dir, file_path);
    let Ok(raw) = fs::read_to_string(&path) else {
        return DocumentThreadsFile {
            file_path: file_path.to_string(),
            active_thread_id: None,
            threads: Vec::new(),
        };
    };

    match serde_json::from_str::<DocumentThreadsFile>(&raw) {
        Ok(mut parsed) => {
            parsed.file_path = file_path.to_string();
            parsed
                .threads
                .sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
            parsed
        }
        Err(_) => DocumentThreadsFile {
            file_path: file_path.to_string(),
            active_thread_id: None,
            threads: Vec::new(),
        },
    }
}

pub fn save_document_threads(
    threads_dir: &Path,
    mut data: DocumentThreadsFile,
) -> Result<(), String> {
    if data.file_path.trim().is_empty() {
        return Ok(());
    }

    // Drop completely empty threads so disk stays tidy.
    data.threads.retain(|t| !t.messages.is_empty());
    data.threads
        .sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));

    let path = doc_storage_path(threads_dir, &data.file_path);
    if data.threads.is_empty() {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        return Ok(());
    }

    fs::create_dir_all(threads_dir)
        .map_err(|err| format!("Failed to create threads directory: {err}"))?;
    let json = serde_json::to_string_pretty(&data)
        .map_err(|err| format!("Failed to serialize threads: {err}"))?;
    write_file_atomic(&path, &json)
}

/// Moves saved thread history when a document is renamed or moved inside the workspace.
pub fn remap_document_threads(
    threads_dir: &Path,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    if old_path == new_path {
        return Ok(());
    }
    let old_file = doc_storage_path(threads_dir, old_path);
    if !old_file.is_file() {
        return Ok(());
    }

    let mut data = load_document_threads(threads_dir, old_path);
    data.file_path = new_path.to_string();
    save_document_threads(threads_dir, data)?;
    let _ = fs::remove_file(&old_file);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_thread(id: &str, title: &str, ts: u64) -> SavedThread {
        SavedThread {
            id: id.into(),
            title: title.into(),
            created_at_ms: ts,
            updated_at_ms: ts,
            messages: vec![SavedThreadItem {
                id: "m1".into(),
                role: "user".into(),
                content: "Tighten the intro.".into(),
                mode: None,
                skill_slug: Some("tighten".into()),
                selection_preview: None,
                edit_count: None,
                comment_count: None,
                meta: None,
                pinned: false,
                hidden: false,
            }],
        }
    }

    #[test]
    fn saves_loads_sorts_and_remaps_document_threads() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("writer-threads-test-{stamp}"));

        let file_a = "/Users/henry/blog/vocoders.mdx";
        let file_b = "/Users/henry/blog/vocoders-v2.mdx";

        save_document_threads(
            &dir,
            DocumentThreadsFile {
                file_path: file_a.into(),
                active_thread_id: Some("t2".into()),
                threads: vec![
                    sample_thread("t1", "Older thread", 1000),
                    sample_thread("t2", "Newer thread", 2000),
                ],
            },
        )
        .unwrap();

        let loaded = load_document_threads(&dir, file_a);
        assert_eq!(loaded.threads.len(), 2);
        assert_eq!(loaded.threads[0].id, "t2"); // sorted newest first
        assert_eq!(loaded.active_thread_id.as_deref(), Some("t2"));

        remap_document_threads(&dir, file_a, file_b).unwrap();
        assert!(load_document_threads(&dir, file_a).threads.is_empty());
        let remapped = load_document_threads(&dir, file_b);
        assert_eq!(remapped.threads.len(), 2);
        assert_eq!(remapped.file_path, file_b);

        let _ = fs::remove_dir_all(&dir);
    }
}
