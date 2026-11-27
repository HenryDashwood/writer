use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::mdx_spans::{byte_to_utf16, scan_protected_spans, SpanKind};

/// Directories skipped while scanning a workspace for `.md` / `.mdx` documents.
pub const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".next",
    ".turbo",
    ".vscode",
    ".claude",
    ".idea",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HeadingItem {
    pub level: u8,
    pub text: String,
    /// 1-based line number.
    pub line: usize,
    /// UTF-16 code-unit offset of the heading line start for CodeMirror 6.
    pub utf16_offset: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PageMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub date: Option<String>,
    pub tags: Vec<String>,
    /// Origin of the metadata: `"mdx_export"`, `"frontmatter"`, or `"sibling_page_tsx"`.
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DocumentData {
    pub path: String,
    pub content: String,
    pub outline: Vec<HeadingItem>,
    pub metadata: Option<PageMetadata>,
    pub writer_guide: Option<String>,
    pub writer_guide_path: Option<String>,
    pub word_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SaveResult {
    pub path: String,
    pub outline: Vec<HeadingItem>,
    pub metadata: Option<PageMetadata>,
    pub word_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MutationResult {
    pub path: String,
    pub tree: Vec<FileNode>,
}

/// Returns true if a path represents a Markdown or MDX document we should show.
pub fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            let lower = ext.to_ascii_lowercase();
            lower == "md" || lower == "mdx" || lower == "markdown"
        })
}

/// Returns true if any component of `path` is in `IGNORED_DIRS` or is a temp file.
pub fn is_ignored_path(path: &Path) -> bool {
    path.components().any(|comp| {
        let name = comp.as_os_str().to_string_lossy();
        IGNORED_DIRS.contains(&name.as_ref()) || name.contains(".writer-tmp.")
    })
}

/// Recursively scans `root` for files and folders, sorting directories before files.
///
/// When `show_all_files` is `false` (default Markdown focus mode), non-empty folders
/// containing only non-Markdown assets (like `_components/` or `images/`) are pruned,
/// while genuinely empty folders are kept so newly created folders remain visible.
pub fn scan_workspace(root: &Path, show_all_files: bool) -> Result<Vec<FileNode>, String> {
    if !root.exists() {
        return Err(format!("Workspace path does not exist: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {}",
            root.display()
        ));
    }

    let (nodes, _) = scan_dir(root, show_all_files)?;
    Ok(nodes)
}

/// Returns `(visible_nodes, had_any_visible_or_raw_entries)`.
fn scan_dir(dir: &Path, show_all_files: bool) -> Result<(Vec<FileNode>, bool), String> {
    let entries = fs::read_dir(dir)
        .map_err(|err| format!("Failed to read directory {}: {err}", dir.display()))?;

    let mut nodes = Vec::new();
    let mut saw_any_non_hidden_entry = false;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') || IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }

        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        saw_any_non_hidden_entry = true;

        if file_type.is_dir() {
            let (children, dir_had_entries) = scan_dir(&path, show_all_files)?;
            let is_genuinely_empty = !dir_had_entries;
            if show_all_files || !children.is_empty() || is_genuinely_empty {
                nodes.push(FileNode {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_dir: true,
                    children,
                });
            }
        } else if file_type.is_file() && (show_all_files || is_markdown_file(&path)) {
            nodes.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                children: Vec::new(),
            });
        }
    }

    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok((nodes, saw_any_non_hidden_entry))
}

/// Ensures `candidate` resolves inside `workspace_root` (preventing path traversal).
fn ensure_inside_workspace(workspace_root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let canonical_root = fs::canonicalize(workspace_root).map_err(|err| {
        format!(
            "Invalid workspace root {}: {err}",
            workspace_root.display()
        )
    })?;

    let resolved = if candidate.exists() {
        fs::canonicalize(candidate)
            .map_err(|err| format!("Invalid path {}: {err}", candidate.display()))?
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| format!("Path has no parent: {}", candidate.display()))?;
        let file_name = candidate
            .file_name()
            .ok_or_else(|| format!("Invalid filename in path: {}", candidate.display()))?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|err| format!("Parent folder does not exist ({}): {err}", parent.display()))?;
        canonical_parent.join(file_name)
    };

    if !resolved.starts_with(&canonical_root) {
        return Err("Operation refused: path is outside the open workspace.".to_string());
    }

    Ok(resolved)
}

fn validate_entry_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name cannot be empty.".to_string());
    }
    if trimmed == "." || trimmed == ".." || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Name cannot contain path separators or '..'.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Creates a new Markdown/MDX file inside `parent_dir`. Automatically appends `.md`
/// when no file extension is provided.
pub fn create_file(
    workspace_root: &Path,
    parent_dir: &Path,
    raw_name: &str,
) -> Result<PathBuf, String> {
    let mut name = validate_entry_name(raw_name)?;
    if !name.contains('.') {
        name.push_str(".md");
    }

    let safe_parent = ensure_inside_workspace(workspace_root, parent_dir)?;
    if !safe_parent.is_dir() {
        return Err(format!("Not a directory: {}", safe_parent.display()));
    }

    let target = safe_parent.join(&name);
    if target.exists() {
        return Err(format!("A file named '{name}' already exists here."));
    }

    let title = Path::new(&name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .replace(['-', '_'], " ");
    let initial_content = if is_markdown_file(&target) {
        format!("# {title}\n\n")
    } else {
        String::new()
    };

    write_file_atomic(&target, &initial_content)?;
    Ok(target)
}

/// Creates a new directory inside `parent_dir`.
pub fn create_folder(
    workspace_root: &Path,
    parent_dir: &Path,
    raw_name: &str,
) -> Result<PathBuf, String> {
    let name = validate_entry_name(raw_name)?;
    let safe_parent = ensure_inside_workspace(workspace_root, parent_dir)?;
    if !safe_parent.is_dir() {
        return Err(format!("Not a directory: {}", safe_parent.display()));
    }

    let target = safe_parent.join(&name);
    if target.exists() {
        return Err(format!("A folder or file named '{name}' already exists here."));
    }

    fs::create_dir(&target)
        .map_err(|err| format!("Failed to create folder '{}': {err}", target.display()))?;
    Ok(target)
}

/// Renames a file or folder within its current directory.
pub fn rename_entry(
    workspace_root: &Path,
    old_path: &Path,
    new_raw_name: &str,
) -> Result<PathBuf, String> {
    let new_name = validate_entry_name(new_raw_name)?;
    let safe_old = ensure_inside_workspace(workspace_root, old_path)?;
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|err| format!("Invalid workspace root: {err}"))?;

    if safe_old == canonical_root {
        return Err("Cannot rename the workspace root folder.".to_string());
    }

    let parent = safe_old
        .parent()
        .ok_or_else(|| "Entry has no parent directory.".to_string())?;
    let target = parent.join(&new_name);

    if target == safe_old {
        return Ok(safe_old);
    }
    if target.exists() {
        return Err(format!("'{new_name}' already exists in this folder."));
    }

    fs::rename(&safe_old, &target)
        .map_err(|err| format!("Failed to rename to '{new_name}': {err}"))?;
    Ok(target)
}

/// Moves a file or folder into `target_dir` (used by sidebar drag-and-drop).
pub fn move_entry(
    workspace_root: &Path,
    source_path: &Path,
    target_dir: &Path,
) -> Result<PathBuf, String> {
    let safe_src = ensure_inside_workspace(workspace_root, source_path)?;
    let safe_dir = ensure_inside_workspace(workspace_root, target_dir)?;
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|err| format!("Invalid workspace root: {err}"))?;

    if safe_src == canonical_root {
        return Err("Cannot move the workspace root folder.".to_string());
    }
    if !safe_dir.is_dir() {
        return Err("Drop target is not a folder.".to_string());
    }
    if safe_src.is_dir() && safe_dir.starts_with(&safe_src) {
        return Err("Cannot move a folder into itself.".to_string());
    }

    let file_name = safe_src
        .file_name()
        .ok_or_else(|| "Invalid source filename.".to_string())?;
    let dest = safe_dir.join(file_name);

    if dest == safe_src {
        return Ok(safe_src);
    }
    if dest.exists() {
        return Err(format!(
            "'{}' already exists in the destination folder.",
            file_name.to_string_lossy()
        ));
    }

    fs::rename(&safe_src, &dest).map_err(|err| format!("Failed to move item: {err}"))?;
    Ok(dest)
}

/// Copies a file or directory recursively into `target_dir` (used by Copy → Paste),
/// automatically appending ` copy` on name collisions and preventing copying a folder into itself.
pub fn copy_entry(
    workspace_root: &Path,
    source_path: &Path,
    target_dir: &Path,
) -> Result<PathBuf, String> {
    let safe_src = ensure_inside_workspace(workspace_root, source_path)?;
    let safe_dir = ensure_inside_workspace(workspace_root, target_dir)?;

    if !safe_dir.is_dir() {
        return Err("Paste destination is not a folder.".to_string());
    }
    if safe_src.is_dir() && safe_dir.starts_with(&safe_src) {
        return Err("Cannot copy a folder into itself.".to_string());
    }

    let orig_name = safe_src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid source filename.".to_string())?;

    let mut dest = safe_dir.join(orig_name);
    if dest.exists() {
        let stem = safe_src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(orig_name);
        let ext = if safe_src.is_file() {
            safe_src.extension().and_then(|s| s.to_str())
        } else {
            None
        };
        let mut counter = 1usize;
        dest = loop {
            let suffix = if counter == 1 {
                " copy".to_string()
            } else {
                format!(" copy {counter}")
            };
            let candidate_name = match ext {
                Some(e) => format!("{stem}{suffix}.{e}"),
                None => format!("{stem}{suffix}"),
            };
            let candidate = safe_dir.join(candidate_name);
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
        };
    }

    if safe_src.is_file() {
        fs::copy(&safe_src, &dest).map_err(|err| format!("Failed to copy file: {err}"))?;
    } else {
        copy_dir_recursive(&safe_src, &dest)?;
    }

    Ok(dest)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|err| format!("Failed to create directory {}: {err}", dst.display()))?;
    let entries = fs::read_dir(src)
        .map_err(|err| format!("Failed to read directory {}: {err}", src.display()))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            fs::copy(&from, &to)
                .map_err(|err| format!("Failed to copy {}: {err}", from.display()))?;
        }
    }
    Ok(())
}

/// Duplicates a file next to itself as `<stem> copy.<ext>` (incrementing if needed).
pub fn duplicate_file(workspace_root: &Path, path: &Path) -> Result<PathBuf, String> {
    let safe_src = ensure_inside_workspace(workspace_root, path)?;
    if !safe_src.is_file() {
        return Err("Only files can be duplicated.".to_string());
    }

    let parent = safe_src
        .parent()
        .ok_or_else(|| "File has no parent directory.".to_string())?;
    let stem = safe_src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = safe_src.extension().and_then(|s| s.to_str());

    let mut counter = 1usize;
    let dest = loop {
        let suffix = if counter == 1 {
            " copy".to_string()
        } else {
            format!(" copy {counter}")
        };
        let candidate_name = match ext {
            Some(e) => format!("{stem}{suffix}.{e}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            break candidate;
        }
        counter += 1;
    };

    fs::copy(&safe_src, &dest).map_err(|err| format!("Failed to duplicate file: {err}"))?;
    Ok(dest)
}

/// Moves a file or folder safely to the OS Trash (recoverable via Finder Trash).
pub fn trash_entry(workspace_root: &Path, path: &Path) -> Result<(), String> {
    let safe_path = ensure_inside_workspace(workspace_root, path)?;
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|err| format!("Invalid workspace root: {err}"))?;

    if safe_path == canonical_root {
        return Err("Cannot delete the workspace root folder.".to_string());
    }

    trash::delete(&safe_path).map_err(|err| format!("Failed to move to Trash: {err}"))
}

/// Reveals a file or folder in macOS Finder.
pub fn reveal_in_finder(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|err| format!("Failed to open Finder: {err}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Reveal in Finder is only supported on macOS.".to_string())
    }
}

/// Opens a file with the OS default application (e.g. Preview for images, VS Code for `.tsx`).
pub fn open_with_default_app(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|err| format!("Failed to open with default app: {err}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Open with default app is only supported on macOS.".to_string())
    }
}

/// Writes plain text directly to the macOS clipboard via `pbcopy` (more reliable
/// than WebView clipboard permissions).
pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::{Command, Stdio};
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|err| format!("Failed to launch pbcopy: {err}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|err| format!("Failed to write to pbcopy: {err}"))?;
        }
        let status = child
            .wait()
            .map_err(|err| format!("Failed waiting for pbcopy: {err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("pbcopy exited with an error.".to_string())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("Native clipboard copy is only configured for macOS.".to_string())
    }
}

/// Reads a document from disk along with its heading outline, page metadata,
/// prose word count, and nearest `WRITER.md` style guide.
pub fn read_document(path: &Path, workspace_root: Option<&Path>) -> Result<DocumentData, String> {
    let content = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;

    let outline = extract_outline(&content);
    let metadata = extract_page_metadata(path, &content);
    let word_count = count_prose_words(&content);
    let guide = find_writer_guide(path, workspace_root);

    let (writer_guide_path, writer_guide) = match guide {
        Some((p, text)) => (Some(p.to_string_lossy().to_string()), Some(text)),
        None => (None, None),
    };

    Ok(DocumentData {
        path: path.to_string_lossy().to_string(),
        content,
        outline,
        metadata,
        writer_guide,
        writer_guide_path,
        word_count,
    })
}

/// Extracts page title/frontmatter from (1) an inline MDX `export const metadata`,
/// (2) YAML frontmatter `--- ... ---`, or (3) a sibling Next.js `page.tsx`.
pub fn extract_page_metadata(path: &Path, content: &str) -> Option<PageMetadata> {
    if let Some(meta) = extract_js_metadata_object(content, "mdx_export") {
        return Some(meta);
    }
    if let Some(meta) = extract_yaml_frontmatter(content) {
        return Some(meta);
    }
    if is_markdown_file(path) {
        if let Some(sibling) = path.parent().map(|p| p.join("page.tsx")) {
            if sibling.is_file() {
                if let Ok(page_src) = fs::read_to_string(&sibling) {
                    if let Some(meta) = extract_js_metadata_object(&page_src, "sibling_page_tsx") {
                        return Some(meta);
                    }
                }
            }
        }
    }
    None
}

fn extract_js_metadata_object(source: &str, origin: &str) -> Option<PageMetadata> {
    let idx = source.find("export const metadata")?;
    let brace_rel = source[idx..].find('{')?;
    let start = idx + brace_rel;
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut in_quote: Option<u8> = None;
    let mut end = None;
    let mut i = start;

    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = in_quote {
            if b == b'\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if b == q {
                in_quote = None;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' | b'\'' | b'`' => in_quote = Some(b),
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    end = Some(i + 1);
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }

    let block = &source[start..end?];
    let title = extract_js_string_field(block, "title");
    let description = extract_js_string_field(block, "description");
    let date = extract_js_string_field(block, "published")
        .or_else(|| extract_js_string_field(block, "created"))
        .or_else(|| extract_js_string_field(block, "date"));
    let tags = extract_js_string_array(block, "tags");

    if title.is_none() && description.is_none() && date.is_none() && tags.is_empty() {
        return None;
    }

    Some(PageMetadata {
        title,
        description,
        date,
        tags,
        source: Some(origin.to_string()),
    })
}

fn extract_js_string_field(block: &str, key: &str) -> Option<String> {
    for line in block.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix(key) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let first = rest.as_bytes().first().copied()?;
        if first != b'"' && first != b'\'' {
            continue;
        }
        let quote = first as char;
        let mut out = String::new();
        let mut chars = rest[1..].chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
                continue;
            }
            if c == quote {
                return Some(out);
            }
            out.push(c);
        }
    }
    None
}

fn extract_js_string_array(block: &str, key: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let Some(pos) = block.find(&format!("{key}:")) else {
        return tags;
    };
    let rest = &block[pos + key.len() + 1..];
    let Some(open) = rest.find('[') else {
        return tags;
    };
    let Some(close) = rest[open..].find(']') else {
        return tags;
    };
    let inner = &rest[open + 1..open + close];
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            let quote = c;
            let mut item = String::new();
            while let Some(ch) = chars.next() {
                if ch == '\\' {
                    if let Some(n) = chars.next() {
                        item.push(n);
                    }
                    continue;
                }
                if ch == quote {
                    break;
                }
                item.push(ch);
            }
            if !item.trim().is_empty() {
                tags.push(item.trim().to_string());
            }
        }
    }
    tags
}

fn extract_yaml_frontmatter(content: &str) -> Option<PageMetadata> {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return None;
    }
    let first_nl = content.find('\n')? + 1;
    let mut end = None;
    let mut pos = first_nl;
    while pos < content.len() {
        let line_end = content[pos..]
            .find('\n')
            .map(|i| pos + i + 1)
            .unwrap_or(content.len());
        let trimmed = content[pos..line_end].trim();
        if trimmed == "---" || trimmed == "..." {
            end = Some(pos);
            break;
        }
        pos = line_end;
    }
    let body = &content[first_nl..end?];
    let mut title = None;
    let mut description = None;
    let mut date = None;
    let mut tags = Vec::new();
    let mut reading_tags_list = false;

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if reading_tags_list {
            if let Some(item) = trimmed.strip_prefix("- ") {
                let cleaned = unquote_yaml(item);
                if !cleaned.is_empty() {
                    tags.push(cleaned);
                }
                continue;
            } else {
                reading_tags_list = false;
            }
        }
        let Some((k, v)) = trimmed.split_once(':') else {
            continue;
        };
        let key = k.trim().to_ascii_lowercase();
        let val = v.trim();
        match key.as_str() {
            "title" => title = Some(unquote_yaml(val)),
            "description" | "subtitle" | "summary" => description = Some(unquote_yaml(val)),
            "date" | "published" | "created" => date = Some(unquote_yaml(val)),
            "tags" => {
                if val.is_empty() {
                    reading_tags_list = true;
                } else if val.starts_with('[') && val.ends_with(']') {
                    for part in val[1..val.len() - 1].split(',') {
                        let cleaned = unquote_yaml(part);
                        if !cleaned.is_empty() {
                            tags.push(cleaned);
                        }
                    }
                } else {
                    for part in val.split(',') {
                        let cleaned = unquote_yaml(part);
                        if !cleaned.is_empty() {
                            tags.push(cleaned);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if title.is_none() && description.is_none() && date.is_none() && tags.is_empty() {
        return None;
    }

    Some(PageMetadata {
        title,
        description,
        date,
        tags,
        source: Some("frontmatter".to_string()),
    })
}

fn unquote_yaml(raw: &str) -> String {
    let t = raw.trim();
    if t.len() >= 2
        && ((t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\'')))
    {
        t[1..t.len() - 1].trim().to_string()
    } else {
        t.to_string()
    }
}

/// Atomically writes `content` to `path` by writing to a sibling temporary file,
/// flushing to disk, and renaming it into place.
pub fn write_file_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent directory for {}", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document");

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_name = format!(".{file_name}.writer-tmp.{}.{nanos}", std::process::id());
    let tmp_path = parent.join(tmp_name);

    let write_result = (|| -> Result<(), std::io::Error> {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to write temporary file: {err}"));
    }

    fs::rename(&tmp_path, path).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to replace {}: {err}", path.display())
    })
}

/// Extracts ATX Markdown headings (`#` through `######`), ignoring lines inside
/// fenced code blocks or YAML frontmatter.
pub fn extract_outline(content: &str) -> Vec<HeadingItem> {
    let protected = scan_protected_spans(content);
    let mut outline = Vec::new();
    let mut byte_offset = 0usize;

    for (idx, line) in content.split_inclusive('\n').enumerate() {
        let line_start = byte_offset;
        byte_offset += line.len();

        let in_block = protected.iter().any(|s| {
            matches!(
                s.kind,
                SpanKind::CodeFence | SpanKind::Frontmatter | SpanKind::Export
            ) && line_start >= s.byte_start
                && line_start < s.byte_end
        });
        if in_block {
            continue;
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        let hashes = trimmed.bytes().take_while(|&b| b == b'#').count();
        if (1..=6).contains(&hashes) && trimmed.as_bytes().get(hashes) == Some(&b' ') {
            let text = trimmed[hashes + 1..].trim().trim_end_matches('#').trim();
            if !text.is_empty() {
                outline.push(HeadingItem {
                    level: hashes as u8,
                    text: text.to_string(),
                    line: idx + 1,
                    utf16_offset: byte_to_utf16(content, line_start),
                });
            }
        }
    }

    outline
}

/// Counts prose words while excluding non-prose MDX constructs (imports,
/// metadata exports, code fences, JSX tags, and display math).
pub fn count_prose_words(content: &str) -> usize {
    let protected = scan_protected_spans(content);
    let mut words = 0usize;
    let mut cursor = 0usize;

    for span in &protected {
        if matches!(span.kind, SpanKind::InlineCode | SpanKind::InlineMath) {
            continue;
        }
        if span.byte_start > cursor {
            words += content[cursor..span.byte_start].split_whitespace().count();
        }
        cursor = cursor.max(span.byte_end);
    }

    if cursor < content.len() {
        words += content[cursor..].split_whitespace().count();
    }

    words
}

/// Walks upward from `file_path`'s directory to find the nearest `WRITER.md`,
/// stopping at `workspace_root` when provided.
pub fn find_writer_guide(
    file_path: &Path,
    workspace_root: Option<&Path>,
) -> Option<(PathBuf, String)> {
    let canonical_root = workspace_root.and_then(|r| fs::canonicalize(r).ok());
    let mut current = file_path.parent().map(Path::to_path_buf)?;

    loop {
        let candidate = current.join("WRITER.md");
        if candidate.is_file() {
            if let Ok(text) = fs::read_to_string(&candidate) {
                return Some((candidate, text));
            }
        }

        if let Some(ref root) = canonical_root {
            if fs::canonicalize(&current).ok().as_ref() == Some(root) {
                break;
            }
        }

        if !current.pop() {
            break;
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "writer-test-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scans_markdown_tree_keeping_empty_folders_and_pruning_code_only_dirs() {
        let root = make_temp_dir("tree");
        fs::create_dir_all(root.join("src/posts/vocoders/_components")).unwrap();
        fs::create_dir_all(root.join("node_modules/some-pkg")).unwrap();
        fs::create_dir_all(root.join("drafts")).unwrap();

        fs::write(root.join("src/posts/vocoders/content.mdx"), "# Vocoders\n").unwrap();
        fs::write(
            root.join("src/posts/vocoders/_components/Chart.tsx"),
            "export default function Chart() {}",
        )
        .unwrap();
        fs::write(root.join("node_modules/some-pkg/README.md"), "# Ignored").unwrap();
        fs::write(root.join("WRITER.md"), "Use British spelling.").unwrap();

        let tree = scan_workspace(&root, false).unwrap();
        assert_eq!(tree.len(), 3);
        // Directories sort before files: `drafts`, `src`, then `WRITER.md`.
        assert_eq!(tree[0].name, "drafts");
        assert!(tree[0].is_dir);
        assert_eq!(tree[1].name, "src");
        assert_eq!(tree[2].name, "WRITER.md");

        // `_components` had only `.tsx` so it was pruned; `vocoders` only has `content.mdx`.
        let vocoders = &tree[1].children[0].children[0];
        assert_eq!(vocoders.name, "vocoders");
        assert_eq!(vocoders.children.len(), 1);
        assert_eq!(vocoders.children[0].name, "content.mdx");

        // With `show_all_files = true`, `_components/Chart.tsx` appears.
        let all_tree = scan_workspace(&root, true).unwrap();
        let vocoders_all = &all_tree[1].children[0].children[0];
        assert_eq!(vocoders_all.children.len(), 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn supports_create_rename_duplicate_move_and_blocks_traversal() {
        let root = make_temp_dir("file-ops");
        let drafts = create_folder(&root, &root, "drafts").unwrap();
        let archive = create_folder(&root, &root, "archive").unwrap();

        // Auto-appends `.md` when omitted.
        let note = create_file(&root, &drafts, "first-essay").unwrap();
        assert_eq!(note.file_name().unwrap(), "first-essay.md");
        assert!(fs::read_to_string(&note).unwrap().contains("# first essay"));

        // Explicit `.mdx` extension is preserved.
        let mdx = create_file(&root, &drafts, "post.mdx").unwrap();
        assert_eq!(mdx.file_name().unwrap(), "post.mdx");

        // Duplicate
        let copy = duplicate_file(&root, &note).unwrap();
        assert_eq!(copy.file_name().unwrap(), "first-essay copy.md");

        // Rename
        let renamed = rename_entry(&root, &note, "renamed-essay.md").unwrap();
        assert!(!note.exists());
        assert!(renamed.exists());

        // Move into archive/
        let moved = move_entry(&root, &renamed, &archive).unwrap();
        assert_eq!(moved.parent().unwrap(), fs::canonicalize(&archive).unwrap());

        // Copy folder recursively into archive/ (and prevent copying into itself)
        let copied_dir = copy_entry(&root, &drafts, &archive).unwrap();
        assert!(copied_dir.join("post.mdx").is_file());

        // Cannot move or copy folder into itself.
        let sub = create_folder(&root, &drafts, "nested").unwrap();
        assert!(move_entry(&root, &drafts, &sub).is_err());
        assert!(copy_entry(&root, &drafts, &sub).is_err());

        // Cannot traverse outside workspace.
        assert!(create_file(&root, &root, "../escape.md").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extracts_outline_skipping_code_fences_and_counts_prose_words() {
        let doc = r#"import PhaseVisual from "./_components/PhaseVisual";

# Main Title

Hello world from prose.

<PhaseVisual />

```python
# Not a heading!
def foo():
    return 42
```

## Griffin-Lim
"#;

        let outline = extract_outline(doc);
        assert_eq!(outline.len(), 2);
        assert_eq!(outline[0].level, 1);
        assert_eq!(outline[0].text, "Main Title");
        assert_eq!(outline[1].level, 2);
        assert_eq!(outline[1].text, "Griffin-Lim");
        assert_eq!(count_prose_words(doc), 9);
    }

    #[test]
    fn finds_nearest_writer_guide_and_atomic_write_leaves_no_temp_files() {
        let root = make_temp_dir("guide-and-save");
        let post_dir = root.join("posts/my-post");
        fs::create_dir_all(&post_dir).unwrap();
        fs::write(root.join("WRITER.md"), "Keep British spelling.").unwrap();
        let file = post_dir.join("post.mdx");
        fs::write(&file, "Initial draft.").unwrap();

        let doc = read_document(&file, Some(&root)).unwrap();
        assert_eq!(doc.writer_guide.as_deref(), Some("Keep British spelling."));

        write_file_atomic(&file, "Revised draft.").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "Revised draft.");

        let entries: Vec<_> = fs::read_dir(&post_dir).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extracts_metadata_from_mdx_export_yaml_and_sibling_page_tsx() {
        let root = make_temp_dir("meta");
        let mdx_file = root.join("content.mdx");
        let mdx_src = r#"export const metadata = {
  title: "Vocoders",
  description: "How vocoders produce audio waveforms",
  created: "2026-11-21",
  tags: ["AI", "Audio"],
};

Hello world.
"#;
        let mdx_meta = extract_page_metadata(&mdx_file, mdx_src).unwrap();
        assert_eq!(mdx_meta.title.as_deref(), Some("Vocoders"));
        assert_eq!(mdx_meta.date.as_deref(), Some("2026-11-21"));
        assert_eq!(mdx_meta.tags, vec!["AI", "Audio"]);
        assert_eq!(mdx_meta.source.as_deref(), Some("mdx_export"));

        let md_file = root.join("note.md");
        let yaml_src = "---\ntitle: \"Field Notes\"\ndate: 2026-11-26\ntags:\n  - Writing\n  - Tools\n---\n\nBody text.\n";
        let yaml_meta = extract_page_metadata(&md_file, yaml_src).unwrap();
        assert_eq!(yaml_meta.title.as_deref(), Some("Field Notes"));
        assert_eq!(yaml_meta.date.as_deref(), Some("2026-11-26"));
        assert_eq!(yaml_meta.tags, vec!["Writing", "Tools"]);
        assert_eq!(yaml_meta.source.as_deref(), Some("frontmatter"));

        // Sibling Next.js page.tsx fallback for posts/*/post.mdx
        let post_dir = root.join("post");
        fs::create_dir_all(&post_dir).unwrap();
        fs::write(
            post_dir.join("page.tsx"),
            r#"export const metadata = {
  title: "Inside a City",
  description: "Urban economics",
  other: {
    published: "2025-12-11",
    tags: ["Economics", "Housing"],
  },
};"#,
        )
        .unwrap();
        let post_mdx = post_dir.join("post.mdx");
        let sib_meta = extract_page_metadata(&post_mdx, "Opening paragraph.\n").unwrap();
        assert_eq!(sib_meta.title.as_deref(), Some("Inside a City"));
        assert_eq!(sib_meta.date.as_deref(), Some("2025-12-11"));
        assert_eq!(sib_meta.tags, vec!["Economics", "Housing"]);
        assert_eq!(sib_meta.source.as_deref(), Some("sibling_page_tsx"));

        let _ = fs::remove_dir_all(&root);
    }
}
