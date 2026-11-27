use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::diff::{CommentKind, ResolvedComment};
use crate::mdx_spans::{byte_to_utf16, scan_protected_spans, utf16_to_byte, SpanKind};
use crate::workspace::write_file_atomic;

const PANGRAM_V3_ENDPOINT: &str = "https://text.api.pangram.com/v3";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyService {
    Pangram,
    Anthropic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretSource {
    Saved,
    Env,
    Dotenv,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SingleKeyStatus {
    pub configured: bool,
    pub source: Option<SecretSource>,
    pub masked_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyStatus {
    pub pangram: SingleKeyStatus,
    pub anthropic: SingleKeyStatus,
    pub secrets_path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StoredSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pangram_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    anthropic_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PangramCheckRequest {
    pub content: String,
    #[serde(default)]
    pub selection_utf16: Option<(usize, usize)>,
    #[serde(default)]
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PangramCheckResponse {
    pub reply: String,
    pub headline: String,
    pub prediction: String,
    pub version: String,
    pub fraction_ai: f64,
    pub fraction_ai_assisted: f64,
    pub fraction_human: f64,
    pub comments: Vec<ResolvedComment>,
    pub total_windows: usize,
    pub flagged_windows: usize,
    pub duration_ms: u64,
}

/// Returns the per-user secrets file path outside the repository
/// (e.g. `~/Library/Application Support/com.henrydashwood.writer/secrets.json`).
pub fn resolve_secrets_path(app: &AppHandle) -> PathBuf {
    if let Ok(cfg_dir) = app.path().app_config_dir() {
        return cfg_dir.join("secrets.json");
    }
    PathBuf::from("secrets.json")
}

fn load_stored_secrets(path: &Path) -> StoredSecrets {
    let Ok(raw) = fs::read_to_string(path) else {
        return StoredSecrets::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_stored_secrets(path: &Path, secrets: &StoredSecrets) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create config directory: {err}"))?;
    }
    let json = serde_json::to_string_pretty(secrets)
        .map_err(|err| format!("Failed to serialize secrets: {err}"))?;
    write_file_atomic(path, &json)?;

    // Restrict secrets file permissions to owner read/write only on Unix (0o600).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

/// Parses a single `KEY=VALUE` entry from a `.env` file without mutating process env.
pub fn parse_dotenv_var(dotenv_content: &str, key_name: &str) -> Option<String> {
    for raw_line in dotenv_content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim).unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        if k.trim() != key_name {
            continue;
        }
        let mut val = v.trim();
        if val.len() >= 2
            && ((val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\'')))
        {
            val = &val[1..val.len() - 1];
        } else if let Some((before_comment, _)) = val.split_once(" #") {
            val = before_comment.trim();
        }
        if !val.trim().is_empty() {
            return Some(val.trim().to_string());
        }
    }
    None
}

fn lookup_dotenv_key(key_name: &str, workspace_root: Option<&Path>) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(ws) = workspace_root {
        candidates.push(ws.join(".env"));
    }
    if let Some(repo_root) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        candidates.push(repo_root.join(".env"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(".env"));
    }

    for path in candidates {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Some(val) = parse_dotenv_var(&content, key_name) {
                return Some(val);
            }
        }
    }
    None
}

fn mask_secret(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() <= 6 {
        return "••••••".to_string();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("••••{tail}")
}

/// Resolves an API key in priority order:
/// 1. Saved user key in `<app_config_dir>/secrets.json`
/// 2. Environment variable (`PANGRAM_API_KEY` / `ANTHROPIC_API_KEY`)
/// 3. Local `.env` file (workspace or app root)
pub fn resolve_api_key(
    secrets_path: &Path,
    service: ApiKeyService,
    workspace_root: Option<&Path>,
) -> Option<(String, SecretSource)> {
    let stored = load_stored_secrets(secrets_path);
    let (saved_val, env_name) = match service {
        ApiKeyService::Pangram => (stored.pangram_api_key, "PANGRAM_API_KEY"),
        ApiKeyService::Anthropic => (stored.anthropic_api_key, "ANTHROPIC_API_KEY"),
    };

    if let Some(val) = saved_val.filter(|s| !s.trim().is_empty()) {
        return Some((val, SecretSource::Saved));
    }
    if let Ok(val) = std::env::var(env_name) {
        if !val.trim().is_empty() {
            return Some((val.trim().to_string(), SecretSource::Env));
        }
    }
    if let Some(val) = lookup_dotenv_key(env_name, workspace_root) {
        return Some((val, SecretSource::Dotenv));
    }
    None
}

pub fn get_api_key_status(secrets_path: &Path, workspace_root: Option<&Path>) -> ApiKeyStatus {
    let to_status = |svc: ApiKeyService| match resolve_api_key(secrets_path, svc, workspace_root) {
        Some((val, src)) => SingleKeyStatus {
            configured: true,
            source: Some(src),
            masked_preview: Some(mask_secret(&val)),
        },
        None => SingleKeyStatus {
            configured: false,
            source: None,
            masked_preview: None,
        },
    };

    ApiKeyStatus {
        pangram: to_status(ApiKeyService::Pangram),
        anthropic: to_status(ApiKeyService::Anthropic),
        secrets_path: secrets_path.to_string_lossy().to_string(),
    }
}

pub fn save_api_key(
    secrets_path: &Path,
    service: ApiKeyService,
    key: &str,
    workspace_root: Option<&Path>,
) -> Result<ApiKeyStatus, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key cannot be empty.".into());
    }
    let mut stored = load_stored_secrets(secrets_path);
    match service {
        ApiKeyService::Pangram => stored.pangram_api_key = Some(trimmed.to_string()),
        ApiKeyService::Anthropic => stored.anthropic_api_key = Some(trimmed.to_string()),
    }
    write_stored_secrets(secrets_path, &stored)?;
    Ok(get_api_key_status(secrets_path, workspace_root))
}

pub fn clear_api_key(
    secrets_path: &Path,
    service: ApiKeyService,
    workspace_root: Option<&Path>,
) -> Result<ApiKeyStatus, String> {
    let mut stored = load_stored_secrets(secrets_path);
    match service {
        ApiKeyService::Pangram => stored.pangram_api_key = None,
        ApiKeyService::Anthropic => stored.anthropic_api_key = None,
    }
    write_stored_secrets(secrets_path, &stored)?;
    Ok(get_api_key_status(secrets_path, workspace_root))
}

/// Maps each character index in the extracted prose string back to its original UTF-8 byte
/// offset in the source document (or `None` for synthetic separator characters).
#[derive(Debug, Clone)]
pub struct ExtractedProse {
    pub text: String,
    /// `char_to_orig_byte[i]` = `(orig_byte_start, orig_byte_end)` for the `i`-th char of `text`.
    pub char_to_orig_byte: Vec<Option<(usize, usize)>>,
}

/// Strips non-prose block spans (`Frontmatter`, `Import`, `Export`, `CodeFence`, `JsxTag`)
/// while preserving an exact char-index -> original-byte-offset map so Pangram's window
/// indices highlight the exact prose lines in the live editor.
pub fn extract_prose_with_map(doc: &str, base_offset: usize) -> ExtractedProse {
    let spans = scan_protected_spans(doc);
    let mut skip_ranges: Vec<(usize, usize)> = spans
        .into_iter()
        .filter(|s| {
            matches!(
                s.kind,
                SpanKind::Frontmatter
                    | SpanKind::Import
                    | SpanKind::Export
                    | SpanKind::CodeFence
                    | SpanKind::JsxTag
            )
        })
        .map(|s| (s.byte_start, s.byte_end))
        .collect();
    skip_ranges.sort_by_key(|r| r.0);

    let mut text = String::with_capacity(doc.len());
    let mut char_to_orig_byte: Vec<Option<(usize, usize)>> = Vec::with_capacity(doc.len());

    let mut cursor = 0usize;
    let push_slice = |slice: &str,
                      slice_start: usize,
                      out: &mut String,
                      map: &mut Vec<Option<(usize, usize)>>| {
        for (rel_idx, ch) in slice.char_indices() {
            let b_start = base_offset + slice_start + rel_idx;
            let b_end = b_start + ch.len_utf8();
            out.push(ch);
            map.push(Some((b_start, b_end)));
        }
    };

    for (start, end) in skip_ranges {
        if start > cursor {
            push_slice(&doc[cursor..start], cursor, &mut text, &mut char_to_orig_byte);
        }
        // Keep paragraph separation where a skipped block stood without shifting surrounding prose.
        if !text.is_empty() && !text.ends_with("\n\n") {
            if !text.ends_with('\n') {
                text.push('\n');
                char_to_orig_byte.push(None);
            }
            text.push('\n');
            char_to_orig_byte.push(None);
        }
        cursor = cursor.max(end);
    }

    if cursor < doc.len() {
        push_slice(&doc[cursor..], cursor, &mut text, &mut char_to_orig_byte);
    }

    ExtractedProse {
        text,
        char_to_orig_byte,
    }
}

impl ExtractedProse {
    /// Converts a `[char_start, char_end)` slice in `self.text` back to `[orig_byte_start, orig_byte_end)`
    /// in the original document, trimming leading/trailing whitespace so highlights look crisp.
    pub fn map_char_range_to_orig_bytes(
        &self,
        char_start: usize,
        char_end: usize,
        original_doc: &str,
    ) -> Option<(usize, usize)> {
        let len = self.char_to_orig_byte.len();
        if len == 0 {
            return None;
        }
        let s = char_start.min(len);
        let e = char_end.min(len);
        if s >= e {
            return None;
        }

        let mut first_byte: Option<usize> = None;
        let mut last_byte: Option<usize> = None;

        for entry in &self.char_to_orig_byte[s..e] {
            if let Some((b_start, b_end)) = *entry {
                if first_byte.is_none() {
                    first_byte = Some(b_start);
                }
                last_byte = Some(b_end);
            }
        }

        let (mut b_start, mut b_end) = (first_byte?, last_byte?);
        if b_start >= b_end || b_end > original_doc.len() {
            return None;
        }

        // Trim leading/trailing whitespace from the highlight range.
        let slice = &original_doc[b_start..b_end];
        let trim_start = slice.len() - slice.trim_start().len();
        let trim_end = slice.len() - slice.trim_end().len();
        b_start += trim_start;
        b_end = b_end.saturating_sub(trim_end);

        (b_start < b_end).then_some((b_start, b_end))
    }
}

#[derive(Debug, Deserialize)]
struct PangramWindowRaw {
    #[serde(default)]
    text: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    ai_assistance_score: f64,
    #[serde(default)]
    confidence: Option<Value>,
    #[serde(default)]
    start_index: Option<usize>,
    #[serde(default)]
    end_index: Option<usize>,
    #[serde(default)]
    word_count: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct PangramResponseRaw {
    #[serde(default)]
    version: String,
    #[serde(default)]
    headline: String,
    #[serde(default)]
    prediction: String,
    #[serde(default)]
    fraction_ai: f64,
    #[serde(default)]
    fraction_ai_assisted: f64,
    #[serde(default)]
    fraction_human: f64,
    #[serde(default)]
    num_ai_segments: Option<usize>,
    #[serde(default)]
    num_ai_assisted_segments: Option<usize>,
    #[serde(default)]
    num_human_segments: Option<usize>,
    #[serde(default)]
    windows: Vec<PangramWindowRaw>,
}

fn classify_window(label: &str, score: f64) -> Option<CommentKind> {
    let lower = label.to_lowercase();
    if lower.contains("human") && !lower.contains("ai") && score < 0.25 {
        return None;
    }
    if lower.contains("assisted") || lower.contains("mixed") {
        return Some(CommentKind::AiAssisted);
    }
    if lower.contains("ai") || score >= 0.5 {
        return Some(CommentKind::AiGenerated);
    }
    if score >= 0.25 {
        return Some(CommentKind::AiAssisted);
    }
    None
}

fn format_confidence(val: &Option<Value>) -> String {
    match val {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(Value::Number(n)) => n
            .as_f64()
            .map(|f| format!("{:.0}%", f * 100.0))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn make_excerpt(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.len() <= 140 {
        collapsed
    } else {
        let head: String = chars[..137].iter().collect();
        format!("{head}…")
    }
}

/// Converts a parsed Pangram v3 JSON payload + prose offset map into highlighted comments
/// and a Markdown summary for the chat drawer.
pub fn build_pangram_result(
    payload: &Value,
    original_doc: &str,
    extracted: &ExtractedProse,
    duration_ms: u64,
) -> Result<PangramCheckResponse, String> {
    let parsed: PangramResponseRaw = serde_json::from_value(payload.clone())
        .map_err(|err| format!("Failed to parse Pangram API response: {err}"))?;

    let mut comments: Vec<ResolvedComment> = Vec::new();
    let total_windows = parsed.windows.len();

    for (idx, win) in parsed.windows.iter().enumerate() {
        let Some(kind) = classify_window(&win.label, win.ai_assistance_score) else {
            continue;
        };

        let mapped = match (win.start_index, win.end_index) {
            (Some(s), Some(e)) => extracted.map_char_range_to_orig_bytes(s, e, original_doc),
            _ => None,
        }
        .or_else(|| {
            // Fallback: locate trimmed snippet verbatim in original doc if indices were omitted.
            let needle = win.text.trim();
            if needle.len() >= 12 {
                original_doc
                    .find(needle)
                    .map(|start| (start, start + needle.len()))
            } else {
                None
            }
        });

        let Some((byte_start, byte_end)) = mapped else {
            continue;
        };

        let utf16_start = byte_to_utf16(original_doc, byte_start);
        let utf16_end = byte_to_utf16(original_doc, byte_end);
        if utf16_start >= utf16_end {
            continue;
        }

        let pct = (win.ai_assistance_score * 100.0).round() as i64;
        let conf = format_confidence(&win.confidence);
        let badge_label = match kind {
            CommentKind::AiGenerated => format!("AI-Generated · {pct}%"),
            CommentKind::AiAssisted => format!("AI-Assisted · {pct}%"),
            CommentKind::Note => "Note".to_string(),
        };

        let mut details = vec![format!("**{}** (score: {}%)", win.label, pct)];
        if !conf.is_empty() {
            details.push(format!("Confidence: {conf}"));
        }
        if let Some(wc) = win.word_count {
            details.push(format!("{wc} words"));
        }

        comments.push(ResolvedComment {
            id: format!("pg{}", idx + 1),
            byte_start,
            byte_end,
            utf16_start,
            utf16_end,
            anchor: make_excerpt(&original_doc[byte_start..byte_end]),
            body: details.join(" · "),
            kind,
            label: Some(badge_label),
        });
    }

    let flagged_windows = comments.len();
    let ai_pct = (parsed.fraction_ai * 100.0).round() as i64;
    let assisted_pct = (parsed.fraction_ai_assisted * 100.0).round() as i64;
    let human_pct = (parsed.fraction_human * 100.0).round() as i64;

    let headline = if parsed.headline.trim().is_empty() {
        if flagged_windows == 0 {
            "Likely Human".to_string()
        } else {
            "AI Content Flagged".to_string()
        }
    } else {
        parsed.headline.clone()
    };

    let version_tag = if parsed.version.trim().is_empty() {
        "Pangram".to_string()
    } else {
        format!("Pangram {}", parsed.version.trim())
    };

    let mut reply = format!("**{headline}** ({version_tag})\n\n");
    if !parsed.prediction.trim().is_empty() {
        reply.push_str(parsed.prediction.trim());
        reply.push_str("\n\n");
    }
    reply.push_str(&format!(
        "| Metric | Share |\n| --- | --- |\n| Human | **{human_pct}%** |\n| AI-Assisted | **{assisted_pct}%** |\n| AI-Generated | **{ai_pct}%** |\n\n"
    ));

    if let (Some(ai_n), Some(asst_n), Some(hum_n)) = (
        parsed.num_ai_segments,
        parsed.num_ai_assisted_segments,
        parsed.num_human_segments,
    ) {
        reply.push_str(&format!(
            "Segments: {ai_n} AI · {asst_n} AI-assisted · {hum_n} human.\n\n"
        ));
    }

    if flagged_windows == 0 {
        reply.push_str("No passages were flagged as AI-generated or AI-assisted.");
    } else {
        reply.push_str(&format!(
            "Highlighted **{flagged_windows}** flagged {} in the editor. Click any card below to jump to it or rewrite it in your voice.",
            if flagged_windows == 1 { "section" } else { "sections" }
        ));
    }

    Ok(PangramCheckResponse {
        reply,
        headline,
        prediction: parsed.prediction,
        version: version_tag,
        fraction_ai: parsed.fraction_ai,
        fraction_ai_assisted: parsed.fraction_ai_assisted,
        fraction_human: parsed.fraction_human,
        comments,
        total_windows,
        flagged_windows,
        duration_ms,
    })
}

/// Calls Pangram Labs v3 API on the document's prose (or selection) and maps every
/// AI-flagged window back onto live editor highlight spans.
pub async fn run_pangram_check(
    secrets_path: &Path,
    req: PangramCheckRequest,
) -> Result<PangramCheckResponse, String> {
    let started = Instant::now();
    let ws_path = req.workspace_root.as_deref().map(Path::new);

    let (api_key, _source) = resolve_api_key(secrets_path, ApiKeyService::Pangram, ws_path)
        .ok_or_else(|| {
            "No Pangram API key found. Add `PANGRAM_API_KEY` in Settings → Models & Keys (or in your local `.env` file)."
                .to_string()
        })?;

    let (slice, base_offset) = match req.selection_utf16 {
        Some((u_start, u_end)) if u_start < u_end => {
            let b_start = utf16_to_byte(&req.content, u_start);
            let b_end = utf16_to_byte(&req.content, u_end);
            if b_start < b_end && b_end <= req.content.len() {
                (&req.content[b_start..b_end], b_start)
            } else {
                (req.content.as_str(), 0)
            }
        }
        _ => (req.content.as_str(), 0),
    };

    let extracted = extract_prose_with_map(slice, base_offset);
    if extracted.text.trim().is_empty() {
        return Err("No prose text found to scan with Pangram.".into());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(PANGRAM_V3_ENDPOINT)
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key)
        .json(&json!({
            "text": extracted.text,
            "public_dashboard_link": false,
        }))
        .send()
        .await
        .map_err(|err| format!("Pangram API request failed: {err}"))?;

    let status = resp.status();
    let raw_body = resp
        .text()
        .await
        .map_err(|err| format!("Failed to read Pangram API response: {err}"))?;

    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&raw_body)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .or_else(|| v.get("detail"))
                    .or_else(|| v.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| raw_body.trim().to_string());
        return Err(format!("Pangram API HTTP {status}: {msg}"));
    }

    let payload: Value = serde_json::from_str(&raw_body)
        .map_err(|err| format!("Invalid JSON from Pangram API: {err}"))?;

    build_pangram_result(
        &payload,
        &req.content,
        &extracted,
        started.elapsed().as_millis() as u64,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dotenv_lines_with_quotes_and_export() {
        let env_txt = r#"
# comment
export PANGRAM_API_KEY="pg_test_123456"
OTHER_KEY=foo
ANTHROPIC_API_KEY='sk-ant-abc'
"#;
        assert_eq!(
            parse_dotenv_var(env_txt, "PANGRAM_API_KEY").as_deref(),
            Some("pg_test_123456")
        );
        assert_eq!(
            parse_dotenv_var(env_txt, "ANTHROPIC_API_KEY").as_deref(),
            Some("sk-ant-abc")
        );
        assert_eq!(parse_dotenv_var(env_txt, "MISSING"), None);
    }

    #[test]
    fn extracts_mdx_prose_and_maps_pangram_windows_back_to_exact_offsets() {
        let doc = "import Viz from \"./Viz\";\n\nFirst human paragraph here.\n\n<Viz />\n\nSecond paragraph flagged by Pangram as AI.\n";
        let extracted = extract_prose_with_map(doc, 0);
        assert!(!extracted.text.contains("import Viz"));
        assert!(!extracted.text.contains("<Viz />"));

        let target = "Second paragraph flagged by Pangram as AI.";
        let char_start = extracted
            .text
            .find(target)
            .map(|b| extracted.text[..b].chars().count())
            .unwrap();
        let char_end = char_start + target.chars().count();

        let payload = json!({
            "version": "4.1",
            "headline": "Mixed AI and Human",
            "prediction": "Parts of this document appear AI-generated.",
            "fraction_ai": 0.5,
            "fraction_ai_assisted": 0.0,
            "fraction_human": 0.5,
            "num_ai_segments": 1,
            "num_ai_assisted_segments": 0,
            "num_human_segments": 1,
            "windows": [
                {
                    "text": "First human paragraph here.",
                    "label": "Human",
                    "ai_assistance_score": 0.02,
                    "confidence": "High",
                    "start_index": 0,
                    "end_index": 27,
                    "word_count": 4
                },
                {
                    "text": target,
                    "label": "AI-Generated",
                    "ai_assistance_score": 0.96,
                    "confidence": "High",
                    "start_index": char_start,
                    "end_index": char_end,
                    "word_count": 7
                }
            ]
        });

        let res = build_pangram_result(&payload, doc, &extracted, 420).unwrap();
        assert_eq!(res.flagged_windows, 1);
        assert_eq!(res.comments.len(), 1);
        let c = &res.comments[0];
        assert_eq!(c.kind, CommentKind::AiGenerated);
        assert_eq!(&doc[c.byte_start..c.byte_end], target);
        assert_eq!(c.label.as_deref(), Some("AI-Generated · 96%"));
    }
}
