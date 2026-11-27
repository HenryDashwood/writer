export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileNode[];
}

export interface HeadingItem {
  level: number;
  text: string;
  line: number;
  utf16_offset: number;
}

export interface PageMetadata {
  title: string | null;
  description: string | null;
  date: string | null;
  tags: string[];
  source: "mdx_export" | "frontmatter" | "sibling_page_tsx" | null;
}

export interface DocumentData {
  path: string;
  content: string;
  outline: HeadingItem[];
  metadata: PageMetadata | null;
  writer_guide: string | null;
  writer_guide_path: string | null;
  word_count: number;
}

export interface SaveResult {
  path: string;
  outline: HeadingItem[];
  metadata: PageMetadata | null;
  word_count: number;
}

export interface MutationResult {
  path: string;
  tree: FileNode[];
}

export type SpanKind =
  | "frontmatter"
  | "import"
  | "export"
  | "code_fence"
  | "inline_code"
  | "display_math"
  | "inline_math"
  | "jsx_tag";

export interface ProtectedSpan {
  kind: SpanKind;
  byte_start: number;
  byte_end: number;
  utf16_start: number;
  utf16_end: number;
}

export type EditKind =
  | "typo"
  | "grammar"
  | "conciseness"
  | "clarity"
  | "flow"
  | "custom";

export interface ProposedEdit {
  id: string;
  kind: EditKind;
  find: string;
  replace: string;
  context_before?: string | null;
  context_after?: string | null;
  rationale: string;
}

export type DiffOp = "equal" | "delete" | "insert";

export interface DiffToken {
  op: DiffOp;
  text: string;
}

export interface ResolvedHunk {
  id: string;
  kind: EditKind;
  byte_start: number;
  byte_end: number;
  utf16_start: number;
  utf16_end: number;
  original: string;
  replacement: string;
  rationale: string;
  tokens: DiffToken[];
}

export type RejectionReason =
  | { code: "no_op" }
  | { code: "empty_anchor" }
  | { code: "anchor_not_found" }
  | { code: "ambiguous_anchor" }
  | { code: "touches_protected_span"; span_kind: SpanKind }
  | { code: "overlaps_existing_hunk" }
  | { code: "outside_allowed_range" };

export interface RejectedEdit {
  id: string;
  reason: RejectionReason;
}

export interface ResolveOptions {
  allowed_byte_range?: [number, number] | null;
  allow_protected_spans: boolean;
}

export interface DiffResolution {
  hunks: ResolvedHunk[];
  rejected: RejectedEdit[];
}

export interface FileChangeEvent {
  path: string;
  kind: string;
}

export type EditMode =
  | "proofread"
  | "tighten"
  | "line_edit"
  | "critique"
  | "custom";

export type ProviderKind = "claude_cli" | "agy_cli" | "codex_cli" | "anthropic_api";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type SkillSource = "app" | "workspace";

export type SkillRunner = "llm" | "pangram";

export interface Skill {
  slug: string;
  name: string;
  description: string;
  allow_edits: boolean;
  runner: SkillRunner;
  default_prompt: string;
  instructions: string;
  source: SkillSource;
  path: string;
  order: number;
}

export interface SaveSkillInput {
  existing_path: string | null;
  slug: string;
  name: string;
  description: string;
  allow_edits: boolean;
  runner: SkillRunner;
  default_prompt: string;
  instructions: string;
  source: SkillSource;
  order: number;
}

export interface SaveSkillResult {
  skill: Skill;
  catalog: SkillsCatalog;
}

export type ChatMode = "craft" | "standard" | "concise";

export interface PromptConfig {
  persona: string;
  craft_rules: string;
  conversation_rules: string;
  concise_rules: string;
  cmdk_rules: string;
  protocol_rules: string;
}

export interface SkillsCatalog {
  skills: Skill[];
  app_skills_dir: string;
  workspace_skills_dir: string | null;
}

export interface SkillSpec {
  slug: string;
  name: string;
  instructions: string;
  allow_edits: boolean;
}

export interface ChatTurnRequest {
  content: string;
  messages: ChatMessage[];
  mode?: EditMode | null;
  chat_mode?: ChatMode;
  pinned_context?: string[];
  skill?: SkillSpec | null;
  selection_utf16?: [number, number] | null;
  workspace_root?: string | null;
  active_file_path?: string | null;
  writer_guide?: string | null;
  provider: ProviderKind;
  model?: string | null;
  effort?: EffortLevel | null;
  api_key?: string | null;
}

export interface ChatTurnResponse {
  reply: string;
  hunks: ResolvedHunk[];
  rejected: RejectedEdit[];
  comments: ResolvedComment[];
  provider_used: string;
  model_used: string;
  duration_ms: number;
}

export interface ChatThreadItem {
  id: string;
  role: ChatRole;
  content: string;
  mode?: EditMode | null;
  skillSlug?: string | null;
  selectionPreview?: string | null;
  editCount?: number;
  commentCount?: number;
  meta?: string | null;
  pinned?: boolean;
  hidden?: boolean;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  messages: ChatThreadItem[];
}

export interface SavedThreadItemWire {
  id: string;
  role: ChatRole;
  content: string;
  mode?: EditMode | null;
  skill_slug?: string | null;
  selection_preview?: string | null;
  edit_count?: number | null;
  comment_count?: number | null;
  meta?: string | null;
  pinned?: boolean;
  hidden?: boolean;
}

export interface SavedThreadWire {
  id: string;
  title: string;
  created_at_ms: number;
  updated_at_ms: number;
  messages: SavedThreadItemWire[];
}

export interface DocumentThreadsFileWire {
  file_path: string;
  active_thread_id: string | null;
  threads: SavedThreadWire[];
}

export type CommentKind = "note" | "ai_generated" | "ai_assisted";

export interface ResolvedComment {
  id: string;
  byte_start: number;
  byte_end: number;
  utf16_start: number;
  utf16_end: number;
  anchor: string;
  body: string;
  kind?: CommentKind;
  label?: string | null;
}

export type ApiKeyService = "pangram" | "anthropic";

export type SecretSource = "saved" | "env" | "dotenv";

export interface SingleKeyStatus {
  configured: boolean;
  source: SecretSource | null;
  masked_preview: string | null;
}

export interface ApiKeyStatus {
  pangram: SingleKeyStatus;
  anthropic: SingleKeyStatus;
  secrets_path: string;
}

export interface PangramCheckRequest {
  content: string;
  selection_utf16?: [number, number] | null;
  workspace_root?: string | null;
}

export interface PangramCheckResponse {
  reply: string;
  headline: string;
  prediction: string;
  version: string;
  fraction_ai: number;
  fraction_ai_assisted: number;
  fraction_human: number;
  comments: ResolvedComment[];
  total_windows: number;
  flagged_windows: number;
  duration_ms: number;
}

export interface EditPassRequest {
  content: string;
  mode: EditMode;
  instruction?: string | null;
  selection_utf16?: [number, number] | null;
  writer_guide?: string | null;
  provider: ProviderKind;
  model?: string | null;
  api_key?: string | null;
}

export interface EditPassResponse {
  hunks: ResolvedHunk[];
  rejected: RejectedEdit[];
  comments: ResolvedComment[];
  summary: string;
  provider_used: string;
  model_used: string;
  duration_ms: number;
}

export interface ProviderStatus {
  claude_cli_available: boolean;
  claude_cli_path: string | null;
  agy_cli_available: boolean;
  agy_cli_path: string | null;
  codex_cli_available: boolean;
  codex_cli_path: string | null;
  anthropic_env_key_set: boolean;
}

export interface MdxServerInfo {
  port: number;
  base_url: string;
}

export type ViewMode = "write" | "split" | "preview";
