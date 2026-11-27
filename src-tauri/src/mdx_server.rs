use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use crate::llm::augmented_gui_path;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct MdxServerInfo {
    pub port: u16,
    pub base_url: String,
}

struct RunningServer {
    child: Child,
    port: u16,
}

/// RAII cleanup: when `RunningServer` is dropped (e.g. app shutdown), terminate
/// the Bun sidecar cleanly so no background process is left behind.
impl Drop for RunningServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Managed Tauri state supervising the local Bun MDX compiler sidecar.
#[derive(Default)]
pub struct MdxServerState {
    inner: Mutex<Option<RunningServer>>,
}

impl MdxServerState {
    /// Starts the Bun MDX sidecar if not already running and returns its localhost URL.
    pub fn ensure_running(&self, app: &AppHandle) -> Result<MdxServerInfo, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "MDX server state mutex poisoned".to_string())?;

        // Reuse existing server if the child process is still alive.
        if let Some(ref mut running) = *guard {
            if matches!(running.child.try_wait(), Ok(None)) {
                return Ok(MdxServerInfo {
                    port: running.port,
                    base_url: format!("http://127.0.0.1:{}", running.port),
                });
            }
        }

        let bun = find_bun_binary().ok_or_else(|| {
            "Could not find `bun` on PATH or in ~/.bun/bin. Install Bun to render live MDX components.".to_string()
        })?;
        let script = locate_sidecar_script(app)?;

        let mut child = Command::new(&bun)
            .arg("run")
            .arg(&script)
            .arg("--port")
            .arg("0")
            .env("PATH", augmented_gui_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|err| format!("Failed to start Bun MDX sidecar: {err}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MDX sidecar stdout was not captured".to_string())?;

        // Wait for the sidecar to print `READY <port>` on its first stdout line.
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|err| format!("Failed reading MDX sidecar startup line: {err}"))?;

        let port: u16 = line
            .trim()
            .strip_prefix("READY ")
            .and_then(|p| p.parse::<u16>().ok())
            .ok_or_else(|| {
                let _ = child.kill();
                format!("Unexpected MDX sidecar startup output: {:?}", line.trim())
            })?;

        *guard = Some(RunningServer { child, port });

        Ok(MdxServerInfo {
            port,
            base_url: format!("http://127.0.0.1:{port}"),
        })
    }

    /// Stops the sidecar explicitly (called on Tauri `RunEvent::Exit`).
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
    }
}

/// Locates `bun` even when launched as a macOS GUI app with a minimal `PATH`.
pub fn find_bun_binary() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join("bun"));
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".bun/bin/bun"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/bun"));
    candidates.push(PathBuf::from("/usr/local/bin/bun"));

    candidates.into_iter().find(|p| p.is_file())
}

fn locate_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    // In dev builds, prefer the live checkout script so edits take effect immediately.
    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|root| root.join("sidecar/mdx-server.ts"));
        if let Some(p) = dev_path.filter(|p| p.is_file()) {
            return Ok(p);
        }
    }

    // In packaged `.app` builds, prefer the self-contained bundled sidecar inside Contents/Resources.
    if let Ok(res_dir) = app.path().resource_dir() {
        for rel in ["sidecar/mdx-server.mjs", "sidecar/mdx-server.ts"] {
            let bundled = res_dir.join(rel);
            if bundled.is_file() {
                return Ok(bundled);
            }
        }
    }

    // Fallback to checkout path if running an unbundled release binary.
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| root.join("sidecar/mdx-server.ts"));
    if let Some(p) = dev_path.filter(|p| p.is_file()) {
        return Ok(p);
    }

    Err("Could not locate bundled or dev MDX sidecar script".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locates_bun_binary_on_dev_machine() {
        let bun = find_bun_binary();
        assert!(bun.is_some(), "Expected `bun` binary to be discoverable");
    }
}
