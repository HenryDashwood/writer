use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::diff::{
    resolve_comments, resolve_edits, ProposedComment, ProposedEdit, RejectedEdit, ResolveOptions,
    ResolvedComment, ResolvedHunk,
};
use crate::mdx_spans::utf16_to_byte;
use crate::workspace::write_file_atomic;

/// Editorial touch level controlling how invasive the model is allowed to be.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditMode {
    Proofread,
    Tighten,
    LineEdit,
    Critique,
    Custom,
}

/// Pluggable LLM backend selector.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    ClaudeCli,
    AgyCli,
    CodexCli,
    AnthropicApi,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

/// Thinking / reasoning effort level passed to the model.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffortLevel {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl EffortLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            EffortLevel::Low => "low",
            EffortLevel::Medium => "medium",
            EffortLevel::High => "high",
            EffortLevel::Xhigh => "xhigh",
            EffortLevel::Max => "max",
        }
    }

    /// Claude CLI / Anthropic API do not have `xhigh`, so map it gracefully to `high`.
    pub fn as_claude_str(&self) -> &'static str {
        match self {
            EffortLevel::Low => "low",
            EffortLevel::Medium => "medium",
            EffortLevel::High | EffortLevel::Xhigh => "high",
            EffortLevel::Max => "max",
        }
    }
}

fn default_true() -> bool {
    true
}

/// Skill instructions attached when the author invokes a `/skill` slash command.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillSpec {
    pub slug: String,
    pub name: String,
    pub instructions: String,
    #[serde(default = "default_true")]
    pub allow_edits: bool,
}

/// Solveit-inspired interaction mode controlling how actively the model writes vs coaches.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatMode {
    /// Socratic / human-is-the-agent mode: no automatic rewrites, concise questions & margin nudges.
    Craft,
    #[default]
    Standard,
    /// Razor-sharp, zero-preamble responses.
    Concise,
}

fn default_craft_rules() -> String {
    "MODE: CRAFT (Solveit-inspired Socratic partner — zero automatic rewrites).\n\
- The human is the author and agent. Your job is to keep their mind actively engaged and strengthen their craft — never write prose for them.\n\
- Return `edits: []` (MUST be empty in Craft chat). NEVER output replacement paragraphs or 'here is a better version.'\n\
- Keep `reply` concise (2-5 sentences, no walls of text). Diagnose ONE unclear claim, missing intuition, or structural snag at a time and ask a sharp question that helps the author write the stronger sentence themselves.\n\
- Follow Pólya's rhythm when the author is stuck: clarify what they want the reader to feel/understand -> agree on one small step -> let them draft it -> reflect together.\n\
- When pointing at specific sentences, anchor concise questions in `comments` so the author can jump straight to the line and rework it in their own voice.".to_string()
}

fn default_concise_rules() -> String {
    "MODE: CONCISE (high-signal, minimal tokens).\n\
- Answer in at most 2-4 crisp sentences or 3 short bullets. Zero preamble, zero filler, zero sign-offs.\n\
- Leave `edits: []` unless the author explicitly asks for an edit; when editing, keep changes ultra-surgical.".to_string()
}

/// Editable base prompt components stored in `<app_config_dir>/prompts.json`.
/// Exposing these lets the author inspect and tailor every instruction sent to the model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptConfig {
    pub persona: String,
    #[serde(default = "default_craft_rules")]
    pub craft_rules: String,
    pub conversation_rules: String,
    #[serde(default = "default_concise_rules")]
    pub concise_rules: String,
    pub cmdk_rules: String,
    pub protocol_rules: String,
}

impl Default for PromptConfig {
    fn default() -> Self {
        Self {
            persona: "You are a disciplined human copy-editor and thought partner collaborating with a technical writer on a Markdown/MDX draft.".to_string(),
            craft_rules: default_craft_rules(),
            conversation_rules: "MODE: EDITORIAL CONVERSATION.\n\
- You are in a multi-turn conversation with the author about their draft.\n\
- If the author asks a question, brainstorms ideas, asks for critique, or discusses structure/clarity: respond thoughtfully in `reply` and leave `edits: []` (DO NOT propose unrequested edits).\n\
- ONLY populate `edits` when the author explicitly asks you to edit, fix, tighten, rephrase, or apply a change.\n\
- When proposing edits, keep them surgical and preserve the author's voice strictly — never rewrite whole sections into generic prose.".to_string(),
            concise_rules: default_concise_rules(),
            cmdk_rules: "MODE: TARGETED INSTRUCTION (Cmd+K).\n\
- Follow the author's explicit instruction closely using minimal, surgical edits.\n\
- If a `<selection>` block is marked, ONLY propose edits inside that selection.\n\
- Preserve voice and keep untouched text verbatim.".to_string(),
            protocol_rules: "STRICT PROTOCOL RULES:\n\
1. Never return a full rewrite. Any proposed edit must be a discrete, localized replacement where `find` is a short verbatim substring (usually 3-25 words) copied character-for-character from the CURRENT `<document>`.\n\
2. Keep `find` as tight as possible around the words actually changing, while including enough words to be unambiguous.\n\
3. Always populate `context_before` and `context_after` (3-5 verbatim words) whenever `find` could appear more than once.\n\
4. NEVER modify ESM `import`/`export` lines, YAML frontmatter, fenced code blocks, JSX component tags (`<Component />`), or LaTeX math (`$...$` / `$$...$$`) unless the user explicitly selected them with an instruction to change them.\n\
5. Each edit's `rationale` must be concise (<= 15 words) and concrete.\n\
6. Avoid AI clichés ('delve', 'tapestry', 'crucial', 'it's worth noting', 'nuanced', 'landscape'). Respect the author's voice and dialect.\n\
7. Use unique sequential IDs (`e1`, `e2`, ... for edits; `c1`, `c2`, ... for comments).".to_string(),
        }
    }
}

pub fn resolve_prompt_config_path(app: &AppHandle) -> PathBuf {
    if let Ok(cfg_dir) = app.path().app_config_dir() {
        return cfg_dir.join("prompts.json");
    }
    PathBuf::from("prompts.json")
}

pub fn load_prompt_config(path: &Path) -> PromptConfig {
    let Ok(raw) = fs::read_to_string(path) else {
        return PromptConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_prompt_config(path: &Path, config: &PromptConfig) -> Result<PromptConfig, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create config directory: {err}"))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|err| format!("Failed to serialize prompt config: {err}"))?;
    write_file_atomic(path, &json)?;
    Ok(config.clone())
}

pub fn reset_prompt_config(path: &Path) -> Result<PromptConfig, String> {
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    Ok(PromptConfig::default())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurnRequest {
    pub content: String,
    /// Full conversation history ending with the latest user message.
    pub messages: Vec<ChatMessage>,
    /// Optional preset touch level (`None` = free-form editorial conversation).
    #[serde(default)]
    pub mode: Option<EditMode>,
    /// Solveit-style conversation mode (`craft` | `standard` | `concise`).
    #[serde(default)]
    pub chat_mode: ChatMode,
    /// Pinned messages curated by the author to remain anchored in system context.
    #[serde(default)]
    pub pinned_context: Vec<String>,
    /// Optional `/skill` loaded from `skills/*.md` or `<workspace>/.writer/skills/*.md`.
    #[serde(default)]
    pub skill: Option<SkillSpec>,
    /// Optional user-edited base prompts; falls back to `PromptConfig::default()`.
    #[serde(default)]
    pub prompt_config: Option<PromptConfig>,
    /// Optional UTF-16 selection range from CodeMirror 6 (used by `Cmd+K` or selection chat).
    #[serde(default)]
    pub selection_utf16: Option<(usize, usize)>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub active_file_path: Option<String>,
    #[serde(default)]
    pub writer_guide: Option<String>,
    pub provider: ProviderKind,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<EffortLevel>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurnResponse {
    pub reply: String,
    pub hunks: Vec<ResolvedHunk>,
    pub rejected: Vec<RejectedEdit>,
    pub comments: Vec<ResolvedComment>,
    pub provider_used: String,
    pub model_used: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditPassRequest {
    pub content: String,
    pub mode: EditMode,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub selection_utf16: Option<(usize, usize)>,
    #[serde(default)]
    pub writer_guide: Option<String>,
    pub provider: ProviderKind,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditPassResponse {
    pub hunks: Vec<ResolvedHunk>,
    pub rejected: Vec<RejectedEdit>,
    pub comments: Vec<ResolvedComment>,
    pub summary: String,
    pub provider_used: String,
    pub model_used: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub claude_cli_available: bool,
    pub claude_cli_path: Option<String>,
    pub agy_cli_available: bool,
    pub agy_cli_path: Option<String>,
    pub codex_cli_available: bool,
    pub codex_cli_path: Option<String>,
    pub anthropic_env_key_set: bool,
}

/// Raw JSON payload produced by any `EditProvider` before Rust validates anchors
/// and protected MDX spans.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RawModelOutput {
    #[serde(default, alias = "summary")]
    pub reply: String,
    #[serde(default)]
    pub edits: Vec<ProposedEdit>,
    #[serde(default)]
    pub comments: Vec<ProposedComment>,
}

/// Trait implemented by every LLM backend so prompts, multi-turn history,
/// schema validation, and Rust diff guardrails are shared identically across providers.
pub trait EditProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn run_turn<'a>(
        &'a self,
        system_prompt: &'a str,
        messages: &'a [ChatMessage],
        model: &'a str,
        effort: EffortLevel,
        workspace_root: Option<&'a Path>,
    ) -> Pin<Box<dyn Future<Output = Result<RawModelOutput, String>> + Send + 'a>>;
}

/// JSON Schema enforced on both Claude CLI (`--json-schema`) and Anthropic API (`tool_use`).
fn turn_response_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "reply": {
                "type": "string",
                "description": "Direct, helpful conversational reply to the author (Markdown allowed). If proposing edits, keep this concise (1-3 sentences)."
            },
            "edits": {
                "type": "array",
                "description": "Discrete, anchored edits to apply ONLY when the author asked for edits or ran an editing preset. Leave empty [] when answering questions, brainstorming, or critiquing.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "id": { "type": "string" },
                        "kind": {
                            "type": "string",
                            "enum": ["typo", "grammar", "conciseness", "clarity", "flow", "custom"]
                        },
                        "find": {
                            "type": "string",
                            "description": "Exact verbatim substring copied from the document to replace."
                        },
                        "replace": {
                            "type": "string",
                            "description": "Proposed replacement text."
                        },
                        "context_before": {
                            "type": "string",
                            "description": "3-6 verbatim words immediately preceding `find` to disambiguate duplicates."
                        },
                        "context_after": {
                            "type": "string",
                            "description": "3-6 verbatim words immediately following `find` to disambiguate duplicates."
                        },
                        "rationale": {
                            "type": "string",
                            "description": "Short reason for this edit (at most 15 words)."
                        }
                    },
                    "required": ["id", "kind", "find", "replace", "rationale"]
                }
            },
            "comments": {
                "type": "array",
                "description": "Optional anchored editorial notes on specific phrases in the document.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "id": { "type": "string" },
                        "anchor": {
                            "type": "string",
                            "description": "Exact verbatim phrase from the document that this note refers to."
                        },
                        "context_before": { "type": "string" },
                        "context_after": { "type": "string" },
                        "body": {
                            "type": "string",
                            "description": "Concise, specific editorial feedback or question."
                        }
                    },
                    "required": ["id", "anchor", "body"]
                }
            }
        },
        "required": ["reply", "edits", "comments"]
    })
}

/// OpenAI / Codex strict JSON Schema variant: every property in `properties` must be
/// listed in `required`, with optional strings typed as `["string", "null"]`.
fn strict_turn_response_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "reply": {
                "type": "string",
                "description": "Direct, helpful conversational reply to the author (Markdown allowed). If proposing edits, keep this concise (1-3 sentences)."
            },
            "edits": {
                "type": "array",
                "description": "Discrete, anchored edits to apply ONLY when the author asked for edits or ran an editing preset. Leave empty [] when answering questions, brainstorming, or critiquing.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "id": { "type": "string" },
                        "kind": {
                            "type": "string",
                            "enum": ["typo", "grammar", "conciseness", "clarity", "flow", "custom"]
                        },
                        "find": { "type": "string" },
                        "replace": { "type": "string" },
                        "context_before": { "type": ["string", "null"] },
                        "context_after": { "type": ["string", "null"] },
                        "rationale": { "type": "string" }
                    },
                    "required": [
                        "id",
                        "kind",
                        "find",
                        "replace",
                        "context_before",
                        "context_after",
                        "rationale"
                    ]
                }
            },
            "comments": {
                "type": "array",
                "description": "Optional anchored editorial notes on specific phrases in the document.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "id": { "type": "string" },
                        "anchor": { "type": "string" },
                        "context_before": { "type": ["string", "null"] },
                        "context_after": { "type": ["string", "null"] },
                        "body": { "type": "string" }
                    },
                    "required": ["id", "anchor", "context_before", "context_after", "body"]
                }
            }
        },
        "required": ["reply", "edits", "comments"]
    })
}

/// Checks which LLM backends are ready on this machine.
pub fn check_providers() -> ProviderStatus {
    let claude_path = find_claude_binary();
    let agy_path = find_agy_binary();
    let codex_path = find_codex_binary();
    let anthropic_env_key_set = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .is_some_and(|v| !v.trim().is_empty());

    ProviderStatus {
        claude_cli_available: claude_path.is_some(),
        claude_cli_path: claude_path.map(|p| p.to_string_lossy().to_string()),
        agy_cli_available: agy_path.is_some(),
        agy_cli_path: agy_path.map(|p| p.to_string_lossy().to_string()),
        codex_cli_available: codex_path.is_some(),
        codex_cli_path: codex_path.map(|p| p.to_string_lossy().to_string()),
        anthropic_env_key_set,
    }
}

/// Shared CLI lookup checking `PATH` plus standard macOS install locations
/// (since GUI macOS apps launched from Finder often inherit a minimal `PATH`).
fn find_cli_binary(name: &str, extra_home_relpaths: &[&str], extra_abs: &[&str]) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join(name));
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let home_path = PathBuf::from(home);
        candidates.push(home_path.join(".local/bin").join(name));
        for rel in extra_home_relpaths {
            candidates.push(home_path.join(rel));
        }
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(name));
    candidates.push(PathBuf::from("/usr/local/bin").join(name));
    for abs in extra_abs {
        candidates.push(PathBuf::from(abs));
    }

    candidates.into_iter().find(|p| p.is_file())
}

/// Builds a `PATH` string that includes common macOS tool locations (`~/.local/bin`,
/// `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) so child CLIs launched from a
/// Launchpad/Finder `.app` bundle can still find `node`, `git`, `bun`, etc.
pub fn augmented_gui_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut push_unique = |dir: String| {
        if !dir.is_empty() && !parts.iter().any(|p| p == &dir) {
            parts.push(dir);
        }
    };

    if let Ok(home) = std::env::var("HOME") {
        push_unique(format!("{home}/.local/bin"));
        push_unique(format!("{home}/.bun/bin"));
        push_unique(format!("{home}/.cargo/bin"));
    }
    push_unique("/opt/homebrew/bin".to_string());
    push_unique("/opt/homebrew/sbin".to_string());
    push_unique("/usr/local/bin".to_string());

    if let Ok(existing) = std::env::var("PATH") {
        for segment in existing.split(':') {
            push_unique(segment.to_string());
        }
    }

    parts.join(":")
}

pub fn find_claude_binary() -> Option<PathBuf> {
    find_cli_binary("claude", &[".claude/local/claude"], &[])
}

pub fn find_agy_binary() -> Option<PathBuf> {
    find_cli_binary("agy", &[".gemini/bin/agy"], &[])
}

pub fn find_codex_binary() -> Option<PathBuf> {
    find_cli_binary(
        "codex",
        &[],
        &["/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"],
    )
}

/// Builds the anti-slop system prompt tailored to either free-text conversation,
/// a file-based `/skill`, or a built-in touch-level preset, respecting any user prompt overrides.
pub fn build_system_prompt(
    mode: Option<EditMode>,
    chat_mode: ChatMode,
    skill: Option<&SkillSpec>,
    writer_guide: Option<&str>,
    prompt_config: Option<&PromptConfig>,
    pinned_context: &[String],
) -> String {
    let defaults = PromptConfig::default();
    let cfg = prompt_config.unwrap_or(&defaults);

    let owned_skill_rules;
    let mode_rules: &str = if let Some(s) = skill {
        owned_skill_rules = format!(
            "ACTIVE SKILL: /{} ({})\n{}",
            s.slug,
            s.name,
            s.instructions.trim()
        );
        &owned_skill_rules
    } else {
        match mode {
            None => match chat_mode {
                ChatMode::Craft => cfg.craft_rules.trim(),
                ChatMode::Standard => cfg.conversation_rules.trim(),
                ChatMode::Concise => cfg.concise_rules.trim(),
            },
            Some(EditMode::Proofread) => {
                "MODE: PROOFREAD (minimal touch).\n\
                 - ONLY fix objective typos, spelling mistakes, duplicated words (e.g. 'the the'), missing/broken punctuation, and clear grammatical errors.\n\
                 - NEVER rephrase sentences for style, tone, or vocabulary.\n\
                 - Preserve the author's dialect (e.g. British vs American spelling) and intentional fragments.\n\
                 - Leave `comments` empty (`[]`)."
            }
            Some(EditMode::Tighten) => {
                "MODE: TIGHTEN (light touch).\n\
                 - Fix typos/grammar, cut filler words, and untangle genuinely clunky phrasing.\n\
                 - Strictly preserve the author's voice, rhythm, spelling dialect, and short punchy sentences.\n\
                 - Leave strong, clear sentences completely untouched.\n\
                 - Leave `comments` empty (`[]`)."
            }
            Some(EditMode::LineEdit) => {
                "MODE: LINE EDIT (targeted craft edits).\n\
                 - Propose localized sentence-level improvements for clarity, precision, pacing, and transitions.\n\
                 - Keep every edit surgical: never rewrite intact paragraphs into generic prose.\n\
                 - Strictly avoid AI clichés ('delve', 'tapestry', 'crucial', 'it's worth noting', 'nuanced', 'landscape', excessive em-dashes).\n\
                 - Optional: add 1-3 brief `comments` for structural observations that shouldn't be silently rewritten."
            }
            Some(EditMode::Critique) => {
                "MODE: CRITIQUE ONLY (zero text edits).\n\
                 - Return `edits: []` (MUST be empty).\n\
                 - Give a sharp, concise overview in `reply` and return 3-7 specific editorial comments in `comments`, each anchored to an exact phrase.\n\
                 - Focus on clarity of argument, missing intuition, pacing, or claims that need sharpening."
            }
            Some(EditMode::Custom) => cfg.cmdk_rules.trim(),
        }
    };

    let mut prompt = format!(
        "{}\n\n{mode_rules}\n\n{}",
        cfg.persona.trim(),
        cfg.protocol_rules.trim()
    );

    if let Some(guide) = writer_guide.map(str::trim).filter(|g| !g.is_empty()) {
        prompt.push_str("\n\nPROJECT VOICE & STYLE GUIDE (`WRITER.md`):\n");
        prompt.push_str(guide);
    }

    let pinned_items: Vec<&str> = pinned_context
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if !pinned_items.is_empty() {
        prompt.push_str("\n\nPINNED DIALOGUE CONTEXT (explicitly pinned by the author):\n");
        for item in pinned_items {
            prompt.push_str("- ");
            prompt.push_str(item);
            prompt.push('\n');
        }
    }

    prompt.push_str(
        "\n\nWORKSPACE EXPLORATION:\n\
         - When a workspace is open, you may use read-only file/search tools to inspect other drafts, notes, references, or components in the workspace.\n\
         - NEVER write, create, or modify files on disk directly. Any proposed edits to the active `<document>` MUST be returned in the JSON `edits` array so the author can review them inline.",
    );

    prompt
}

/// Attaches the current live `<document>` (with optional `<selection>`) to the final
/// user turn so anchors always match the author's latest buffer even after earlier
/// edits were accepted, rejected, or tweaked manually.
pub fn build_turn_messages(
    history: &[ChatMessage],
    doc: &str,
    selection_bytes: Option<(usize, usize)>,
    active_file_path: Option<&str>,
    workspace_root: Option<&str>,
) -> Vec<ChatMessage> {
    let mut messages = history.to_vec();
    if messages.is_empty() || messages.last().is_some_and(|m| m.role != ChatRole::User) {
        messages.push(ChatMessage {
            role: ChatRole::User,
            content: "Review this document.".to_string(),
        });
    }

    let rel_file = match (active_file_path, workspace_root) {
        (Some(f), Some(root)) => f
            .strip_prefix(root)
            .map(|r| r.trim_start_matches('/'))
            .unwrap_or(f),
        (Some(f), None) => f,
        _ => "",
    };

    let doc_context = if doc.trim().is_empty() {
        let ws_note = workspace_root
            .map(|w| format!("Workspace root: `{w}`.\n"))
            .unwrap_or_default();
        format!(
            "{ws_note}No document is currently open in the editor. Answer in `reply` (leave `edits: []` and `comments: []`)."
        )
    } else {
        let header = if rel_file.is_empty() {
            "CURRENT DOCUMENT".to_string()
        } else {
            format!("CURRENT DOCUMENT (`{rel_file}`)")
        };
        match selection_bytes {
            Some((start, end)) if start < end && end <= doc.len() => {
                format!(
                    "{header} (scoped to `<selection>...</selection>`; surrounding text is context only):\n\
                     <document>\n{}<selection>{}</selection>{}\n</document>",
                    &doc[..start],
                    &doc[start..end],
                    &doc[end..]
                )
            }
            _ => format!("{header}:\n<document>\n{doc}\n</document>"),
        }
    };

    if let Some(last) = messages.last_mut() {
        last.content = format!("{doc_context}\n\nAUTHOR MESSAGE:\n{}", last.content);
    }

    messages
}

/// Renders a multi-turn conversation cleanly into a single stdin prompt for `claude -p`.
fn format_cli_transcript(messages: &[ChatMessage]) -> String {
    if messages.len() == 1 {
        return messages[0].content.clone();
    }

    let mut out = String::from("CONVERSATION HISTORY:\n\n");
    for msg in &messages[..messages.len() - 1] {
        let speaker = match msg.role {
            ChatRole::User => "AUTHOR",
            ChatRole::Assistant => "EDITOR",
        };
        out.push_str(speaker);
        out.push_str(":\n");
        out.push_str(&msg.content);
        out.push_str("\n\n");
    }

    out.push_str("---\n\nLATEST TURN:\n\n");
    out.push_str(&messages[messages.len() - 1].content);
    out
}

/// Combines the system prompt and conversation transcript for agent CLIs (`agy`, `codex`)
/// that do not expose a separate `--system-prompt` flag.
fn format_standalone_cli_prompt(
    system_prompt: &str,
    messages: &[ChatMessage],
    has_workspace: bool,
) -> String {
    let transcript = format_cli_transcript(messages);
    let tool_note = if has_workspace {
        "- You may use read-only file/search tools to inspect other files in the workspace when helpful.\n\
         - NEVER modify, write, or delete files on disk. Return any proposed edits to `<document>` in the JSON `edits` array.\n\
         - Respond with the required JSON object matching the output schema."
    } else {
        "- Do NOT invoke any shell commands, file writes, or external tools.\n\
         - Respond directly with the required JSON object matching the output schema."
    };
    format!(
        "SYSTEM INSTRUCTIONS:\n{system_prompt}\n\n\
         TOOL GUARDRAIL:\n\
         {tool_note}\n\n\
         ---\n\n\
         {transcript}"
    )
}

/// Executes a multi-turn chat or editorial pass and validates every edit & comment
/// through Rust's anchor resolver, MDX span guardrails, and word-level prose diff engine.
pub async fn run_chat_turn(req: ChatTurnRequest) -> Result<ChatTurnResponse, String> {
    let started = Instant::now();

    let selection_bytes = req.selection_utf16.and_then(|(u_start, u_end)| {
        let b_start = utf16_to_byte(&req.content, u_start);
        let b_end = utf16_to_byte(&req.content, u_end);
        (b_start < b_end).then_some((b_start, b_end))
    });

    let system_prompt = build_system_prompt(
        req.mode,
        req.chat_mode,
        req.skill.as_ref(),
        req.writer_guide.as_deref(),
        req.prompt_config.as_ref(),
        &req.pinned_context,
    );
    let turn_messages = build_turn_messages(
        &req.messages,
        &req.content,
        selection_bytes,
        req.active_file_path.as_deref(),
        req.workspace_root.as_deref(),
    );
    let workspace_dir = req
        .workspace_root
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir());

    let (provider, model_used): (Box<dyn EditProvider>, String) = match req.provider {
        ProviderKind::ClaudeCli => {
            let binary = find_claude_binary().ok_or_else(|| {
                "Could not find `claude` CLI on PATH or in ~/.local/bin. Switch backends or install Claude Code.".to_string()
            })?;
            let model = req
                .model
                .clone()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "sonnet".to_string());
            (Box::new(ClaudeCliProvider { binary }), model)
        }
        ProviderKind::AgyCli => {
            let binary = find_agy_binary().ok_or_else(|| {
                "Could not find `agy` (Antigravity CLI) on PATH or in ~/.local/bin.".to_string()
            })?;
            let model = req
                .model
                .clone()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "gemini-4-neon".to_string());
            (Box::new(AgyCliProvider { binary }), model)
        }
        ProviderKind::CodexCli => {
            let binary = find_codex_binary().ok_or_else(|| {
                "Could not find `codex` CLI on PATH or in /opt/homebrew/bin.".to_string()
            })?;
            let model = req
                .model
                .clone()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "gpt-6.2-sol".to_string());
            (Box::new(CodexCliProvider { binary }), model)
        }
        ProviderKind::AnthropicApi => {
            let key = req
                .api_key
                .clone()
                .filter(|k| !k.trim().is_empty())
                .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
                .filter(|k| !k.trim().is_empty())
                .ok_or_else(|| {
                    "No Anthropic API key found. Set ANTHROPIC_API_KEY or paste a key in the settings.".to_string()
                })?;
            let model = resolve_anthropic_model_id(req.model.as_deref());
            (Box::new(AnthropicApiProvider { api_key: key }), model)
        }
    };

    let effort = req.effort.unwrap_or(EffortLevel::Medium);
    let raw = provider
        .run_turn(
            &system_prompt,
            &turn_messages,
            &model_used,
            effort,
            workspace_dir.as_deref(),
        )
        .await?;

    // Critique mode, read-only skills (`allow_edits: false`), and Craft free-text chat
    // are hard-enforced in Rust so the model can never overwrite prose uninvited.
    let edits_disallowed = req.mode == Some(EditMode::Critique)
        || req.skill.as_ref().is_some_and(|s| !s.allow_edits)
        || (req.chat_mode == ChatMode::Craft && req.mode.is_none() && req.skill.is_none());
    let proposed_edits = if edits_disallowed {
        Vec::new()
    } else {
        raw.edits
    };

    let options = ResolveOptions {
        allowed_byte_range: selection_bytes,
        allow_protected_spans: selection_bytes.is_some(),
    };

    let diff_res = resolve_edits(&req.content, proposed_edits, &options);
    let comments = resolve_comments(&req.content, raw.comments, selection_bytes);

    Ok(ChatTurnResponse {
        reply: raw.reply,
        hunks: diff_res.hunks,
        rejected: diff_res.rejected,
        comments,
        provider_used: provider.name().to_string(),
        model_used,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Single-turn convenience wrapper kept for direct `Cmd+K` / preset callers.
pub async fn run_edit_pass(req: EditPassRequest) -> Result<EditPassResponse, String> {
    let prompt = req.instruction.unwrap_or_else(|| match req.mode {
        EditMode::Proofread => "Run a strict Proofread pass on the document.".to_string(),
        EditMode::Tighten => "Run a Tighten pass on the document.".to_string(),
        EditMode::LineEdit => "Run a Line Edit pass on the document.".to_string(),
        EditMode::Critique => "Run a Critique pass (margin comments only, no edits).".to_string(),
        EditMode::Custom => "Edit the selected passage.".to_string(),
    });

    let res = run_chat_turn(ChatTurnRequest {
        content: req.content,
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: prompt,
        }],
        mode: Some(req.mode),
        chat_mode: ChatMode::Standard,
        pinned_context: Vec::new(),
        skill: None,
        prompt_config: None,
        selection_utf16: req.selection_utf16,
        workspace_root: None,
        active_file_path: None,
        writer_guide: req.writer_guide,
        provider: req.provider,
        model: req.model,
        effort: None,
        api_key: req.api_key,
    })
    .await?;

    Ok(EditPassResponse {
        hunks: res.hunks,
        rejected: res.rejected,
        comments: res.comments,
        summary: res.reply,
        provider_used: res.provider_used,
        model_used: res.model_used,
        duration_ms: res.duration_ms,
    })
}

fn resolve_anthropic_model_id(requested: Option<&str>) -> String {
    match requested.map(str::trim).unwrap_or("sonnet") {
        "" | "sonnet" => "claude-sonnet-4-5".to_string(),
        "opus" => "claude-opus-4-1".to_string(),
        "haiku" => "claude-haiku-4-5".to_string(),
        other => other.to_string(),
    }
}

/// Provider 1: invokes the locally authenticated `claude` CLI in non-interactive JSON mode.
pub struct ClaudeCliProvider {
    pub binary: PathBuf,
}

impl EditProvider for ClaudeCliProvider {
    fn name(&self) -> &'static str {
        "claude_cli"
    }

    fn run_turn<'a>(
        &'a self,
        system_prompt: &'a str,
        messages: &'a [ChatMessage],
        model: &'a str,
        effort: EffortLevel,
        workspace_root: Option<&'a Path>,
    ) -> Pin<Box<dyn Future<Output = Result<RawModelOutput, String>> + Send + 'a>> {
        Box::pin(async move {
            let schema_str = turn_response_schema().to_string();
            let prompt_text = format_cli_transcript(messages);
            let tools_arg = if workspace_root.is_some() {
                "Read,Grep,Glob"
            } else {
                ""
            };

            let mut cmd = Command::new(&self.binary);
            cmd.env("PATH", augmented_gui_path())
                .args([
                "-p",
                "--output-format",
                "json",
                "--json-schema",
                &schema_str,
                "--model",
                model,
                "--effort",
                effort.as_claude_str(),
                "--system-prompt",
                system_prompt,
                "--no-session-persistence",
                "--tools",
                tools_arg,
                "--disable-slash-commands",
                "--setting-sources",
                "",
                "--strict-mcp-config",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

            if let Some(dir) = workspace_root {
                cmd.current_dir(dir);
            }

            let mut child = cmd
                .spawn()
                .map_err(|err| format!("Failed to start claude CLI: {err}"))?;

            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(prompt_text.as_bytes())
                    .await
                    .map_err(|err| format!("Failed to write prompt to claude CLI: {err}"))?;
            }

            let output = child
                .wait_with_output()
                .await
                .map_err(|err| format!("Failed waiting for claude CLI: {err}"))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if !output.status.success() {
                let detail = if !stderr.trim().is_empty() {
                    stderr.trim()
                } else {
                    stdout.trim()
                };
                return Err(format!("claude CLI failed: {detail}"));
            }

            parse_claude_cli_output(&stdout)
        })
    }
}

/// Extracts `RawModelOutput` from `claude -p --output-format json --json-schema ...`.
pub fn parse_claude_cli_output(stdout: &str) -> Result<RawModelOutput, String> {
    let envelope: Value = serde_json::from_str(stdout.trim())
        .map_err(|err| format!("Invalid JSON from claude CLI: {err}"))?;

    if envelope.get("is_error").and_then(Value::as_bool) == Some(true) {
        let msg = envelope
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("Unknown claude CLI error");
        return Err(msg.to_string());
    }

    if let Some(structured) = envelope.get("structured_output").filter(|v| !v.is_null()) {
        return serde_json::from_value(structured.clone())
            .map_err(|err| format!("Failed to decode structured_output: {err}"));
    }

    if let Some(result_str) = envelope.get("result").and_then(Value::as_str) {
        let cleaned = strip_json_fence(result_str);
        return serde_json::from_str(cleaned)
            .map_err(|err| format!("Failed to decode result JSON: {err}"));
    }

    serde_json::from_value(envelope)
        .map_err(|err| format!("Unexpected claude CLI JSON structure: {err}"))
}

fn strip_json_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("```json") {
        if let Some(body) = rest.strip_suffix("```") {
            return body.trim();
        }
    }
    if let Some(rest) = trimmed.strip_prefix("```") {
        if let Some(body) = rest.strip_suffix("```") {
            return body.trim();
        }
    }
    trimmed
}

/// Provider 2: direct HTTP call to Anthropic's Messages API with native multi-turn
/// `messages[]` and forced `tool_use` for guaranteed schema-compliant structured replies.
pub struct AnthropicApiProvider {
    pub api_key: String,
}

impl EditProvider for AnthropicApiProvider {
    fn name(&self) -> &'static str {
        "anthropic_api"
    }

    fn run_turn<'a>(
        &'a self,
        system_prompt: &'a str,
        messages: &'a [ChatMessage],
        model: &'a str,
        effort: EffortLevel,
        _workspace_root: Option<&'a Path>,
    ) -> Pin<Box<dyn Future<Output = Result<RawModelOutput, String>> + Send + 'a>> {
        Box::pin(async move {
            let client = reqwest::Client::new();
            let api_messages: Vec<Value> = messages
                .iter()
                .map(|m| {
                    json!({
                        "role": match m.role {
                            ChatRole::User => "user",
                            ChatRole::Assistant => "assistant",
                        },
                        "content": m.content,
                    })
                })
                .collect();

            let body = json!({
                "model": model,
                "max_tokens": 4096,
                "system": system_prompt,
                "output_config": { "effort": effort.as_claude_str() },
                "tools": [{
                    "name": "submit_turn",
                    "description": "Reply to the author and optionally submit discrete, anchored prose edits or margin comments.",
                    "input_schema": turn_response_schema(),
                }],
                "tool_choice": { "type": "tool", "name": "submit_turn" },
                "messages": api_messages,
            });

            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|err| format!("Anthropic API request failed: {err}"))?;

            let status = resp.status();
            let payload: Value = resp
                .json()
                .await
                .map_err(|err| format!("Failed to parse Anthropic API response: {err}"))?;

            if !status.is_success() {
                let msg = payload
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Anthropic API error");
                return Err(format!("HTTP {status}: {msg}"));
            }

            parse_anthropic_api_output(&payload)
        })
    }
}

pub fn parse_anthropic_api_output(payload: &Value) -> Result<RawModelOutput, String> {
    let blocks = payload
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic response missing `content` array".to_string())?;

    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("tool_use")
            && matches!(
                block.get("name").and_then(Value::as_str),
                Some("submit_turn" | "submit_edits")
            )
        {
            if let Some(input) = block.get("input") {
                return serde_json::from_value(input.clone())
                    .map_err(|err| format!("Failed to decode tool_use input: {err}"));
            }
        }
    }

    Err("Anthropic response did not include a `submit_turn` tool call".to_string())
}

/// Provider 3: invokes the locally authenticated Antigravity CLI (`agy`) in print JSON mode.
pub struct AgyCliProvider {
    pub binary: PathBuf,
}

impl EditProvider for AgyCliProvider {
    fn name(&self) -> &'static str {
        "agy_cli"
    }

    fn run_turn<'a>(
        &'a self,
        system_prompt: &'a str,
        messages: &'a [ChatMessage],
        model: &'a str,
        effort: EffortLevel,
        workspace_root: Option<&'a Path>,
    ) -> Pin<Box<dyn Future<Output = Result<RawModelOutput, String>> + Send + 'a>> {
        Box::pin(async move {
            let schema_str = turn_response_schema().to_string();
            let prompt_text =
                format_standalone_cli_prompt(system_prompt, messages, workspace_root.is_some());

            if prompt_text.len() > 850_000 {
                return Err(
                    "Document + conversation exceeds macOS CLI argument limit for `agy --print`. Try clearing chat or selecting a passage."
                        .to_string(),
                );
            }

            let mut cmd = Command::new(&self.binary);
            cmd.env("PATH", augmented_gui_path())
                .args([
                "--output-format",
                "json",
                "--json-schema",
                &schema_str,
                "--model",
                model,
                "--effort",
                effort.as_str(),
                "--disable-slash-commands",
            ]);
            if let Some(dir) = workspace_root {
                cmd.arg("--sandbox").current_dir(dir);
            }
            cmd.args(["--print", &prompt_text])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            let output = cmd
                .output()
                .await
                .map_err(|err| format!("Failed to start agy CLI: {err}"))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if !output.status.success() {
                if let Err(parsed_err) = parse_agy_cli_output(&stdout) {
                    if !parsed_err.starts_with("Invalid JSON") {
                        return Err(parsed_err);
                    }
                }
                let detail = if !stderr.trim().is_empty() {
                    stderr.trim()
                } else {
                    stdout.trim()
                };
                return Err(format!("agy CLI failed: {detail}"));
            }

            parse_agy_cli_output(&stdout)
        })
    }
}

/// Extracts `RawModelOutput` from `agy --output-format json --json-schema ... --print ...`.
pub fn parse_agy_cli_output(stdout: &str) -> Result<RawModelOutput, String> {
    let trimmed = stdout.trim();
    // `agy` normally writes a single JSON object; if anything precedes it on stdout,
    // fall back to the last line starting with `{`.
    let json_slice = if trimmed.starts_with('{') {
        trimmed
    } else {
        trimmed
            .lines()
            .rev()
            .map(str::trim)
            .find(|line| line.starts_with('{'))
            .unwrap_or(trimmed)
    };

    let envelope: Value = serde_json::from_str(json_slice)
        .map_err(|err| format!("Invalid JSON from agy CLI: {err}"))?;

    if envelope
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|s| s.eq_ignore_ascii_case("error"))
    {
        let msg = envelope
            .get("error")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Unknown agy CLI error");
        return Err(msg.to_string());
    }

    if let Some(structured) = envelope.get("structured_output").filter(|v| !v.is_null()) {
        return serde_json::from_value(structured.clone())
            .map_err(|err| format!("Failed to decode agy structured_output: {err}"));
    }

    if let Some(resp_str) = envelope.get("response").and_then(Value::as_str) {
        let cleaned = strip_json_fence(resp_str);
        return serde_json::from_str(cleaned)
            .map_err(|err| format!("Failed to decode agy response JSON: {err}"));
    }

    serde_json::from_value(envelope)
        .map_err(|err| format!("Unexpected agy CLI JSON structure: {err}"))
}

/// RAII guard that removes a temporary file automatically when dropped — even on early `?` returns.
struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Provider 4: invokes the locally authenticated OpenAI Codex CLI (`codex exec`) in
/// ephemeral, read-only, strict-JSON-schema mode with prompt piped on stdin.
pub struct CodexCliProvider {
    pub binary: PathBuf,
}

impl EditProvider for CodexCliProvider {
    fn name(&self) -> &'static str {
        "codex_cli"
    }

    fn run_turn<'a>(
        &'a self,
        system_prompt: &'a str,
        messages: &'a [ChatMessage],
        model: &'a str,
        effort: EffortLevel,
        workspace_root: Option<&'a Path>,
    ) -> Pin<Box<dyn Future<Output = Result<RawModelOutput, String>> + Send + 'a>> {
        Box::pin(async move {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let pid = std::process::id();
            let tmp = std::env::temp_dir();

            let schema_guard = TempFileGuard(tmp.join(format!("writer-codex-schema-{pid}-{stamp}.json")));
            let out_guard = TempFileGuard(tmp.join(format!("writer-codex-out-{pid}-{stamp}.json")));

            let schema_bytes = serde_json::to_vec(&strict_turn_response_schema())
                .map_err(|err| format!("Failed to serialize Codex schema: {err}"))?;
            tokio::fs::write(&schema_guard.0, schema_bytes)
                .await
                .map_err(|err| format!("Failed to write Codex schema temp file: {err}"))?;

            let prompt_text =
                format_standalone_cli_prompt(system_prompt, messages, workspace_root.is_some());
            let effort_override = format!("model_reasoning_effort=\"{}\"", effort.as_str());

            let mut cmd = Command::new(&self.binary);
            cmd.env("PATH", augmented_gui_path())
                .args([
                "exec",
                "--model",
                model,
                "--sandbox",
                "read-only",
                "--ephemeral",
                "--skip-git-repo-check",
                "--ignore-user-config",
                "--ignore-rules",
                "-c",
                &effort_override,
            ]);
            if let Some(dir) = workspace_root {
                cmd.arg("-C").arg(dir);
            }
            let mut child = cmd
                .arg("--output-schema")
                .arg(&schema_guard.0)
                .arg("-o")
                .arg(&out_guard.0)
                .arg("-")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|err| format!("Failed to start codex CLI: {err}"))?;

            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(prompt_text.as_bytes())
                    .await
                    .map_err(|err| format!("Failed to write prompt to codex CLI: {err}"))?;
            }

            let output = child
                .wait_with_output()
                .await
                .map_err(|err| format!("Failed waiting for codex CLI: {err}"))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if !output.status.success() {
                let detail = if !stderr.trim().is_empty() {
                    stderr.trim()
                } else {
                    stdout.trim()
                };
                return Err(format!("codex CLI failed: {detail}"));
            }

            let raw_last_msg = tokio::fs::read_to_string(&out_guard.0)
                .await
                .unwrap_or_else(|_| stdout.to_string());

            parse_codex_cli_output(&raw_last_msg)
        })
    }
}

/// Extracts `RawModelOutput` from the final JSON message written by `codex exec -o`.
pub fn parse_codex_cli_output(raw: &str) -> Result<RawModelOutput, String> {
    let cleaned = strip_json_fence(raw);
    serde_json::from_str(cleaned)
        .map_err(|err| format!("Failed to decode codex CLI JSON output: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::EditKind;

    #[test]
    fn parses_claude_cli_structured_output_envelope() {
        let json = r#"{
          "type": "result",
          "is_error": false,
          "structured_output": {
            "reply": "Fixed one spelling mistake.",
            "edits": [
              {
                "id": "e1",
                "kind": "typo",
                "find": "identical to the orginal.",
                "replace": "identical to the original.",
                "rationale": "Spelling fix."
              }
            ],
            "comments": []
          }
        }"#;

        let parsed = parse_claude_cli_output(json).unwrap();
        assert_eq!(parsed.reply, "Fixed one spelling mistake.");
        assert_eq!(parsed.edits.len(), 1);
        assert_eq!(parsed.edits[0].kind, EditKind::Typo);
    }

    #[test]
    fn parses_anthropic_tool_use_response() {
        let payload = json!({
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_123",
                    "name": "submit_turn",
                    "input": {
                        "reply": "Left one critique note without editing your prose.",
                        "edits": [],
                        "comments": [
                            {
                                "id": "c1",
                                "anchor": "discard the phase",
                                "body": "Explain briefly why phase is harder to model than magnitude."
                            }
                        ]
                    }
                }
            ]
        });

        let parsed = parse_anthropic_api_output(&payload).unwrap();
        assert_eq!(
            parsed.reply,
            "Left one critique note without editing your prose."
        );
        assert!(parsed.edits.is_empty());
        assert_eq!(parsed.comments.len(), 1);
    }

    #[test]
    fn builds_multiturn_messages_and_cli_transcript_with_live_document() {
        let sys = build_system_prompt(
            None,
            ChatMode::Standard,
            None,
            Some("Always use British spelling."),
            None,
            &[],
        );
        assert!(sys.contains("MODE: EDITORIAL CONVERSATION"));
        assert!(sys.contains("Always use British spelling."));

        let craft_sys = build_system_prompt(
            None,
            ChatMode::Craft,
            None,
            None,
            None,
            &["Audience: ML engineers who already know FFTs.".into()],
        );
        assert!(craft_sys.contains("MODE: CRAFT"));
        assert!(craft_sys.contains("PINNED DIALOGUE CONTEXT"));
        assert!(craft_sys.contains("Audience: ML engineers"));

        let skill = SkillSpec {
            slug: "proofread".into(),
            name: "Proofread".into(),
            instructions: "Only fix typos.".into(),
            allow_edits: true,
        };
        let skill_sys = build_system_prompt(None, ChatMode::Craft, Some(&skill), None, None, &[]);
        assert!(skill_sys.contains("ACTIVE SKILL: /proofread (Proofread)"));
        assert!(skill_sys.contains("Only fix typos."));

        let history = vec![
            ChatMessage {
                role: ChatRole::User,
                content: "Does the intro drag?".into(),
            },
            ChatMessage {
                role: ChatRole::Assistant,
                content: "The second sentence repeats the first.".into(),
            },
            ChatMessage {
                role: ChatRole::User,
                content: "Tighten that sentence.".into(),
            },
        ];

        let doc = "Intro sentence. Target sentence here. Outro.";
        let start = doc.find("Target").unwrap();
        let end = start + "Target sentence here.".len();
        let built = build_turn_messages(
            &history,
            doc,
            Some((start, end)),
            Some("/Users/henry/blog/intro.mdx"),
            Some("/Users/henry/blog"),
        );
        assert_eq!(built.len(), 3);
        assert!(built[2].content.contains("CURRENT DOCUMENT (`intro.mdx`)"));
        assert!(built[2]
            .content
            .contains("<selection>Target sentence here.</selection>"));
        assert!(built[2].content.contains("Tighten that sentence."));

        let transcript = format_cli_transcript(&built);
        assert!(transcript.contains("AUTHOR:\nDoes the intro drag?"));
        assert!(transcript.contains("EDITOR:\nThe second sentence repeats the first."));
        assert!(transcript.contains("LATEST TURN:"));
    }

    #[test]
    fn parses_agy_cli_structured_output_and_errors() {
        let ok_json = r#"{
          "conversation_id": "abc",
          "status": "SUCCESS",
          "response": "{\"reply\":\"Tightened one phrase.\",\"edits\":[],\"comments\":[]}",
          "structured_output": {
            "reply": "Tightened one phrase.",
            "edits": [
              {
                "id": "e1",
                "kind": "conciseness",
                "find": "in order to",
                "replace": "to",
                "rationale": "Cut filler."
              }
            ],
            "comments": []
          }
        }"#;
        let parsed = parse_agy_cli_output(ok_json).unwrap();
        assert_eq!(parsed.reply, "Tightened one phrase.");
        assert_eq!(parsed.edits.len(), 1);
        assert_eq!(parsed.edits[0].kind, EditKind::Conciseness);

        let err_json = r#"{"status":"ERROR","error":"Please sign in."}"#;
        let err = parse_agy_cli_output(err_json).unwrap_err();
        assert!(err.contains("Please sign in"));
    }

    #[test]
    fn parses_codex_cli_output_and_validates_strict_schema() {
        let raw = r#"{"reply":"Looks solid.","edits":[],"comments":[]}"#;
        let parsed = parse_codex_cli_output(raw).unwrap();
        assert_eq!(parsed.reply, "Looks solid.");
        assert!(parsed.edits.is_empty());

        let schema = strict_turn_response_schema();
        let edit_item = &schema["properties"]["edits"]["items"];
        let edit_props = edit_item["properties"].as_object().unwrap();
        let edit_req = edit_item["required"].as_array().unwrap();
        assert_eq!(edit_props.len(), edit_req.len());
    }
}
