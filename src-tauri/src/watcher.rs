use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::workspace::{is_ignored_path, is_markdown_file};

/// Window during which filesystem events on a path we just saved are treated as
/// echoes of our own write rather than external edits.
const SELF_WRITE_SUPPRESSION: Duration = Duration::from_millis(800);

#[derive(Debug, Clone, Serialize)]
pub struct FileChangeEvent {
    pub path: String,
    pub kind: String,
}

/// Managed application state holding the active workspace watcher and a short-lived
/// map of files Writer recently saved itself.
pub struct WatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    recent_writes: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            recent_writes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl WatcherState {
    /// Marks `path` as having just been written by Writer so FSEvents echoes
    /// do not trigger a spurious external-reload banner in the UI.
    pub fn record_self_write(&self, path: &Path) {
        let key = normalize_path(path);
        if let Ok(mut map) = self.recent_writes.lock() {
            map.insert(key, Instant::now());
            map.retain(|_, ts| ts.elapsed() < SELF_WRITE_SUPPRESSION * 2);
        }
    }

    /// Starts (or replaces) the recursive FSEvents watcher for `root`.
    /// Dropping the previous `RecommendedWatcher` cleanly stops the old watch.
    pub fn watch_workspace(&self, app: AppHandle, root: &Path) -> Result<(), String> {
        let recent_writes = Arc::clone(&self.recent_writes);

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else {
                return;
            };

            let kind = match event.kind {
                EventKind::Modify(_) => "modify",
                EventKind::Create(_) => "create",
                EventKind::Remove(_) => "remove",
                _ => return,
            };

            let mut tree_dirty = false;

            for path in event.paths {
                if is_ignored_path(&path) {
                    continue;
                }

                // Notify the sidebar to refresh when files/folders are added, removed, or renamed.
                if matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_)) {
                    tree_dirty = true;
                }

                if !is_markdown_file(&path) {
                    continue;
                }

                let key = normalize_path(&path);
                let is_self_echo = recent_writes
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&key).copied())
                    .is_some_and(|ts| ts.elapsed() < SELF_WRITE_SUPPRESSION);

                if is_self_echo {
                    continue;
                }

                let _ = app.emit(
                    "workspace-file-changed",
                    FileChangeEvent {
                        path: path.to_string_lossy().to_string(),
                        kind: kind.to_string(),
                    },
                );
            }

            if tree_dirty {
                let _ = app.emit("workspace-tree-changed", ());
            }
        })
        .map_err(|err| format!("Failed to initialize file watcher: {err}"))?;

        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|err| format!("Failed to watch {}: {err}", root.display()))?;

        let mut guard = self
            .watcher
            .lock()
            .map_err(|_| "Watcher mutex poisoned".to_string())?;
        *guard = Some(watcher);

        Ok(())
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
