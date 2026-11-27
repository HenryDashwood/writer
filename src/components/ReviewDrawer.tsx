import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  History,
  Loader2,
  MessageSquare,
  Pencil,
  Pin,
  Plus,
  Settings2,
  ShieldAlert,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import type { ActiveComment, ActiveHunk } from "../editor/diffExtension";
import type { SelectionSnapshot } from "../editor/EditorCanvas";
import { ChatMarkdown } from "./ChatMarkdown";
import type {
  ChatMode,
  ChatThread,
  ChatThreadItem,
  EditKind,
  EffortLevel,
  ProviderKind,
  ProviderStatus,
  RejectedEdit,
  Skill,
} from "../types";

interface ReviewDrawerProps {
  messages: ChatThreadItem[];
  threads: ChatThread[];
  activeThreadId: string | null;
  skills: Skill[];
  chatMode: ChatMode;
  onChatModeChange: (mode: ChatMode) => void;
  provider: ProviderKind;
  model: string;
  onSelectModel: (provider: ProviderKind, model: string) => void;
  effort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  providerStatus: ProviderStatus | null;
  running: boolean;
  error: string | null;
  hunks: ActiveHunk[];
  focusedId: string | null;
  comments: ActiveComment[];
  focusedCommentId: string | null;
  rejected: RejectedEdit[];
  writerGuidePath: string | null;
  activeSelection: SelectionSnapshot | null;
  onSendMessage: (text: string, useSelection: boolean, skill?: Skill | null) => void;
  onOpenSettings: () => void;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onTogglePinMessage: (messageId: string) => void;
  onToggleHideMessage: (messageId: string) => void;
  onEditMessage: (messageId: string, nextContent: string) => void;
  onFocusHunk: (id: string) => void;
  onAcceptHunk: (id: string) => void;
  onRejectHunk: (id: string) => void;
  onAcceptKind: (kind: EditKind) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onFocusComment: (id: string) => void;
  onDismissComment: (id: string) => void;
  onTurnCommentIntoEdit: (comment: ActiveComment) => void;
}

export interface ModelOption {
  provider: ProviderKind;
  model: string;
  label: string;
  shortLabel: string;
}

export const CLAUDE_MODELS: ModelOption[] = [
  { provider: "claude_cli", model: "sonnet", label: "Claude Sonnet", shortLabel: "Sonnet" },
  { provider: "claude_cli", model: "opus", label: "Claude Opus", shortLabel: "Opus" },
  { provider: "claude_cli", model: "haiku", label: "Claude Haiku", shortLabel: "Haiku" },
];

export const AGY_MODELS: ModelOption[] = [
  { provider: "agy_cli", model: "gemini-4-neon", label: "Gemini 4 Neon", shortLabel: "Neon" },
  { provider: "agy_cli", model: "gemini-4-carbon", label: "Gemini 4 Carbon", shortLabel: "Carbon" },
  { provider: "agy_cli", model: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", shortLabel: "Hydrogen" },
  { provider: "agy_cli", model: "gemini-4-argon", label: "Gemini 4 Argon", shortLabel: "Argon" },
  { provider: "agy_cli", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", shortLabel: "Flash" },
  { provider: "agy_cli", model: "claude-opus-5-5", label: "Opus 5.5 (agy)", shortLabel: "Opus 5.5" },
  { provider: "agy_cli", model: "claude-sonnet-5-5", label: "Sonnet 5.5 (agy)", shortLabel: "Sonnet 5.5" },
];

export const CODEX_MODELS: ModelOption[] = [
  { provider: "codex_cli", model: "gpt-6.2-sol", label: "GPT-6.2-Sol", shortLabel: "GPT-6.2" },
  { provider: "codex_cli", model: "gpt-6.2-astra", label: "GPT-6.2-Astra", shortLabel: "6.2 Astra" },
  { provider: "codex_cli", model: "gpt-6.1-sol", label: "GPT-6.1-Sol", shortLabel: "GPT-6.1" },
  { provider: "codex_cli", model: "gpt-6.1-terra", label: "GPT-6.1 Terra", shortLabel: "6.1 Terra" },
  { provider: "codex_cli", model: "gpt-6-luna", label: "GPT-6-Luna", shortLabel: "GPT-6" },
];

const CHAT_MODE_OPTIONS: Array<{ id: ChatMode; label: string; desc: string }> = [
  {
    id: "craft",
    label: "Craft",
    desc: "Socratic coaching — zero automatic rewrites",
  },
  {
    id: "standard",
    label: "Standard",
    desc: "Balanced chat & surgical edits when asked",
  },
  {
    id: "concise",
    label: "Concise",
    desc: "Ultra-terse, zero-preamble responses",
  },
];

const EFFORT_LABELS: Record<EffortLevel, { label: string; short: string }> = {
  low: { label: "Low", short: "Low" },
  medium: { label: "Medium", short: "Med" },
  high: { label: "High", short: "High" },
  xhigh: { label: "Extra High", short: "XHigh" },
  max: { label: "Max", short: "Max" },
};

export function defaultModelForProvider(provider: ProviderKind): string {
  switch (provider) {
    case "claude_cli":
    case "anthropic_api":
      return "sonnet";
    case "agy_cli":
      return "gemini-4-neon";
    case "codex_cli":
      return "gpt-6.2-sol";
  }
}

export function supportsXhighEffort(provider: ProviderKind): boolean {
  return provider === "agy_cli" || provider === "codex_cli";
}

const KIND_LABELS: Record<EditKind, string> = {
  typo: "Typos",
  grammar: "Grammar",
  conciseness: "Conciseness",
  clarity: "Clarity",
  flow: "Flow",
  custom: "Targeted",
};

function formatRejection(edit: RejectedEdit): string {
  switch (edit.reason.code) {
    case "touches_protected_span":
      return `Blocked edit on protected ${edit.reason.span_kind.replace("_", " ")}`;
    case "anchor_not_found":
      return "Anchor text not found in document";
    case "ambiguous_anchor":
      return "Anchor matched multiple locations";
    case "overlaps_existing_hunk":
      return "Overlapped an earlier edit";
    case "outside_allowed_range":
      return "Outside selected range";
    case "no_op":
      return "No-op edit discarded";
    case "empty_anchor":
      return "Empty anchor discarded";
  }
}

function formatRelativeTime(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "Just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function ReviewDrawer({
  messages,
  threads,
  activeThreadId,
  skills,
  chatMode,
  onChatModeChange,
  provider,
  model,
  onSelectModel,
  effort,
  onEffortChange,
  providerStatus,
  running,
  error,
  hunks,
  focusedId,
  comments,
  focusedCommentId,
  rejected,
  writerGuidePath,
  activeSelection,
  onSendMessage,
  onOpenSettings,
  onNewThread,
  onSelectThread,
  onDeleteThread,
  onTogglePinMessage,
  onToggleHideMessage,
  onEditMessage,
  onFocusHunk,
  onAcceptHunk,
  onRejectHunk,
  onAcceptKind,
  onAcceptAll,
  onRejectAll,
  onFocusComment,
  onDismissComment,
  onTurnCommentIntoEdit,
}: ReviewDrawerProps) {
  const [showChangesTray, setShowChangesTray] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [openMenu, setOpenMenu] = useState<"mode" | "model" | "effort" | null>(
    null,
  );
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingMsgText, setEditingMsgText] = useState("");
  const [draft, setDraft] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [scopeToSelection, setScopeToSelection] = useState(true);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

  // Close composer popover menus when clicking outside or pressing Escape.
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        composerRef.current &&
        !composerRef.current.contains(e.target as Node)
      ) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  const activeModelOption =
    [...CLAUDE_MODELS, ...AGY_MODELS, ...CODEX_MODELS].find(
      (opt) =>
        opt.model === model &&
        (opt.provider === provider ||
          (provider === "anthropic_api" && opt.provider === "claude_cli")),
    ) ?? null;
  const activeModelShort = activeModelOption?.shortLabel ?? model;
  const activeModeLabel =
    CHAT_MODE_OPTIONS.find((m) => m.id === chatMode)?.label ?? "Craft";
  const effortOptions: EffortLevel[] = supportsXhighEffort(provider)
    ? ["low", "medium", "high", "xhigh", "max"]
    : ["low", "medium", "high", "max"];

  // Detect active `/query` autocomplete token at the start of the composer.
  const slashMatch = draft.match(/^\/([a-zA-Z0-9_-]*)$/);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const matchedSkills =
    slashQuery !== null
      ? skills.filter(
          (s) =>
            s.slug.toLowerCase().includes(slashQuery) ||
            s.name.toLowerCase().includes(slashQuery) ||
            s.description.toLowerCase().includes(slashQuery),
        )
      : [];
  const showSlashMenu =
    slashQuery !== null && !slashDismissed && !running;

  useEffect(() => {
    setSlashIndex(0);
    setSlashDismissed(false);
  }, [slashQuery]);

  // Re-enable selection scoping whenever the user highlights a fresh passage.
  useEffect(() => {
    if (activeSelection) {
      setScopeToSelection(true);
    }
  }, [activeSelection?.from, activeSelection?.to]);

  // Keep latest message visible as the conversation grows.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, running]);

  // Auto-open the pending changes tray when new edits arrive.
  useEffect(() => {
    if (hunks.length > 0) {
      setShowChangesTray(true);
    }
  }, [hunks.length]);

  const grouped = new Map<EditKind, ActiveHunk[]>();
  for (const hunk of hunks) {
    const list = grouped.get(hunk.kind) ?? [];
    list.push(hunk);
    grouped.set(hunk.kind, list);
  }

  const resetComposer = () => {
    setDraft("");
    setSlashDismissed(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const runSkill = (skill: Skill, extraInstruction?: string) => {
    if (running) return;
    resetComposer();
    const prompt = extraInstruction?.trim() || skill.default_prompt;
    onSendMessage(prompt, Boolean(activeSelection && scopeToSelection), skill);
  };

  const completeSkill = (skill: Skill) => {
    setDraft(`/${skill.slug} `);
    setSlashDismissed(true);
    textareaRef.current?.focus();
  };

  const handleSubmit = () => {
    const trimmed = draft.trim();
    if (!trimmed || running) return;

    const cmdMatch = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
    if (cmdMatch) {
      const slug = cmdMatch[1].toLowerCase();
      const extra = cmdMatch[2]?.trim() ?? "";
      const exact = skills.find((s) => s.slug.toLowerCase() === slug);
      if (exact) {
        runSkill(exact, extra);
        return;
      }
    }

    resetComposer();
    onSendMessage(trimmed, Boolean(activeSelection && scopeToSelection), null);
  };

  const selectionWordCount = activeSelection
    ? activeSelection.text.trim().split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <aside className="review-drawer">
      <div className="drawer-header">
        <div className="drawer-header-left">
          <span className="drawer-title">Editor</span>
          {writerGuidePath && (
            <span className="composer-guide-dot" title={writerGuidePath}>
              WRITER.md
            </span>
          )}
        </div>
        <div className="drawer-header-right">
          {hunks.length > 0 && (
            <span className="count-pill">{hunks.length} edits</span>
          )}
          <button
            type="button"
            className={`icon-btn icon-btn-sm history-trigger-btn ${showHistory ? "is-on" : ""}`}
            onClick={() => setShowHistory((v) => !v)}
            disabled={running}
            title={`Conversation history (${threads.length})`}
          >
            <History size={14} />
            {threads.length > 0 && (
              <span className="history-count-dot">{threads.length}</span>
            )}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={() => {
              setShowHistory(false);
              onNewThread();
            }}
            disabled={
              running ||
              (messages.length === 0 &&
                hunks.length === 0 &&
                comments.length === 0)
            }
            title="New Conversation"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={onOpenSettings}
            title="Settings — Skills, Prompts & Models (⌘,)"
          >
            <Settings2 size={14} />
          </button>
        </div>
      </div>

      {showHistory && (
        <div className="thread-history-panel">
          <div className="thread-history-header">
            <span>Saved conversations ({threads.length})</span>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setShowHistory(false);
                onNewThread();
              }}
            >
              + New
            </button>
          </div>
          {threads.length === 0 ? (
            <p className="thread-history-empty">
              No saved conversations in this workspace yet.
            </p>
          ) : (
            <div className="thread-history-list">
              {threads.map((thread) => {
                const isActive = thread.id === activeThreadId;
                return (
                  <div
                    key={thread.id}
                    className={`thread-history-item ${isActive ? "is-active" : ""}`}
                    onClick={() => {
                      onSelectThread(thread.id);
                      setShowHistory(false);
                    }}
                  >
                    <div className="thread-history-main">
                      <span className="thread-history-title">
                        {thread.title}
                      </span>
                      <span className="thread-history-meta">
                        {thread.messages.length}{" "}
                        {thread.messages.length === 1 ? "msg" : "msgs"} ·{" "}
                        {formatRelativeTime(thread.updatedAtMs)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="row-action-btn thread-delete-btn"
                      title="Delete conversation"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteThread(thread.id);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Main scrollable conversation thread + critique notes */}
      <div className="chat-scroll">
        {messages.length === 0 && comments.length === 0 && hunks.length === 0 ? (
          <div className="chat-empty">
            <p className="chat-empty-title">
              <Sparkles size={14} /> Talk through your draft or run a{" "}
              <code>/skill</code>.
            </p>
            <p className="chat-empty-sub">
              Questions and critique won’t touch your text. Type{" "}
              <code>/</code> below for skills (or click one to run) and review
              proposed changes inline.
            </p>
            {skills.length > 0 && (
              <div className="empty-skill-hints">
                {skills.map((skill) => (
                  <button
                    key={skill.slug}
                    type="button"
                    className="empty-skill-pill"
                    disabled={running}
                    title={skill.description}
                    onClick={() => runSkill(skill)}
                  >
                    /{skill.slug}
                  </button>
                ))}
              </div>
            )}
            {writerGuidePath && (
              <p className="guide-pill" title={writerGuidePath}>
                Voice guide active: <code>WRITER.md</code>
              </p>
            )}
            <p className="shortcuts-note">
              Shortcuts: <code>/</code> skills · <code>⌘K</code> selection edit ·{" "}
              <code>⌘]</code> / <code>⌘[</code> step · <code>⌘↵</code> accept ·{" "}
              <code>⌘⌫</code> reject
            </p>
          </div>
        ) : (
          <div className="chat-thread">
            {messages.map((msg) => {
              const isEditing = editingMsgId === msg.id;
              return (
                <div
                  key={msg.id}
                  className={`chat-msg chat-msg-${msg.role} ${msg.hidden ? "is-hidden" : ""} ${msg.pinned ? "is-pinned" : ""}`}
                >
                  <div className="chat-msg-toolbar">
                    {msg.pinned && (
                      <span className="chat-curate-badge is-pin">
                        <Pin size={9} /> Pinned
                      </span>
                    )}
                    {msg.hidden && (
                      <span className="chat-curate-badge is-hidden">
                        <EyeOff size={9} /> Hidden from AI
                      </span>
                    )}
                    <div className="chat-msg-actions">
                      <button
                        type="button"
                        className={`msg-action-btn ${msg.pinned ? "is-on" : ""}`}
                        onClick={() => onTogglePinMessage(msg.id)}
                        title={
                          msg.pinned
                            ? "Unpin from AI context"
                            : "Pin to AI context"
                        }
                      >
                        <Pin size={11} />
                      </button>
                      <button
                        type="button"
                        className={`msg-action-btn ${msg.hidden ? "is-on" : ""}`}
                        onClick={() => onToggleHideMessage(msg.id)}
                        title={
                          msg.hidden
                            ? "Include in AI context again"
                            : "Hide from AI context"
                        }
                      >
                        {msg.hidden ? <Eye size={11} /> : <EyeOff size={11} />}
                      </button>
                      <button
                        type="button"
                        className="msg-action-btn"
                        onClick={() => {
                          setEditingMsgId(msg.id);
                          setEditingMsgText(msg.content);
                        }}
                        title="Edit message"
                      >
                        <Pencil size={11} />
                      </button>
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="chat-inline-edit">
                      <textarea
                        className="chat-inline-textarea"
                        rows={4}
                        value={editingMsgText}
                        autoFocus
                        onChange={(e) => setEditingMsgText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setEditingMsgId(null);
                          } else if (e.key === "Enter" && e.metaKey) {
                            e.preventDefault();
                            if (editingMsgText.trim()) {
                              onEditMessage(msg.id, editingMsgText.trim());
                            }
                            setEditingMsgId(null);
                          }
                        }}
                      />
                      <div className="chat-inline-edit-actions">
                        <button
                          type="button"
                          className="small-btn"
                          onClick={() => setEditingMsgId(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="small-btn small-btn-accept"
                          onClick={() => {
                            if (editingMsgText.trim()) {
                              onEditMessage(msg.id, editingMsgText.trim());
                            }
                            setEditingMsgId(null);
                          }}
                        >
                          <Check size={11} /> Save (⌘↵)
                        </button>
                      </div>
                    </div>
                  ) : msg.role === "user" ? (
                    <div className="chat-bubble-user">
                      {msg.skillSlug && (
                        <div className="chat-skill-tag">/{msg.skillSlug}</div>
                      )}
                      {msg.selectionPreview && (
                        <div className="chat-selection-tag">
                          Selection: “{msg.selectionPreview}”
                        </div>
                      )}
                      <div className="chat-user-text">{msg.content}</div>
                    </div>
                  ) : (
                    <div className="chat-bubble-assistant">
                      <ChatMarkdown text={msg.content} />
                      {(msg.editCount || msg.commentCount || msg.meta) && (
                        <div className="chat-msg-footer">
                          {msg.editCount ? (
                            <span className="chat-stat-pill">
                              {msg.editCount}{" "}
                              {msg.editCount === 1 ? "edit" : "edits"} proposed
                            </span>
                          ) : null}
                          {msg.commentCount ? (
                            <span className="chat-stat-pill">
                              {msg.commentCount}{" "}
                              {msg.commentCount === 1 ? "note" : "notes"}
                            </span>
                          ) : null}
                          {msg.meta && (
                            <span className="chat-meta">{msg.meta}</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {comments.length > 0 && (
              <div className="hunk-group">
                <div className="hunk-group-header">
                  <span className="cm-hunk-badge">
                    <MessageSquare
                      size={10}
                      style={{ marginRight: 4, verticalAlign: -1 }}
                    />
                    {comments.every(
                      (c) =>
                        c.kind === "ai_generated" || c.kind === "ai_assisted",
                    )
                      ? `Pangram flags (${comments.length})`
                      : `Highlights & notes (${comments.length})`}
                  </span>
                </div>

                {comments.map((comment) => {
                  const isFocused = comment.id === focusedCommentId;
                  const isAiFlag =
                    comment.kind === "ai_generated" ||
                    comment.kind === "ai_assisted";
                  return (
                    <div
                      key={comment.id}
                      className={`hunk-card comment-card ${isFocused ? "is-focused" : ""} ${
                        comment.kind === "ai_generated"
                          ? "comment-card-ai"
                          : comment.kind === "ai_assisted"
                            ? "comment-card-assisted"
                            : ""
                      }`}
                      onClick={() => onFocusComment(comment.id)}
                    >
                      {comment.label && (
                        <span
                          className={`comment-severity-pill ${
                            comment.kind === "ai_generated"
                              ? "is-ai"
                              : "is-assisted"
                          }`}
                        >
                          {comment.label}
                        </span>
                      )}
                      <p className="comment-anchor">“{comment.anchor}”</p>
                      <div className="comment-body">
                        <ChatMarkdown text={comment.body} />
                      </div>
                      <div className="hunk-card-actions">
                        <button
                          type="button"
                          className="small-btn"
                          disabled={running}
                          onClick={(e) => {
                            e.stopPropagation();
                            onTurnCommentIntoEdit(comment);
                          }}
                        >
                          <Wand2 size={12} />{" "}
                          {isAiFlag ? "Rewrite in my voice" : "Propose edit"}
                        </button>
                        <button
                          type="button"
                          className="small-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDismissComment(comment.id);
                          }}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {rejected.length > 0 && (
              <div className="rejected-box">
                <div className="rejected-title">
                  <ShieldAlert size={13} /> Filtered by Rust guardrails (
                  {rejected.length})
                </div>
                <ul>
                  {rejected.map((r) => (
                    <li key={r.id}>{formatRejection(r)}</li>
                  ))}
                </ul>
              </div>
            )}

            {running && (
              <div className="chat-thinking">
                <Loader2 size={13} className="spin" />
                <span>Thinking…</span>
              </div>
            )}

            {error && <p className="drawer-error">{error}</p>}

            <div ref={threadEndRef} />
          </div>
        )}
      </div>

      {/* Collapsible Pending Inline Edits Tray pinned cleanly above the composer */}
      {hunks.length > 0 && (
        <div className="pending-tray">
          <div className="pending-tray-header">
            <button
              type="button"
              className="pending-tray-toggle"
              onClick={() => setShowChangesTray((v) => !v)}
            >
              {showChangesTray ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronUp size={13} />
              )}
              <span>
                {hunks.length} pending {hunks.length === 1 ? "edit" : "edits"}
              </span>
            </button>
            <div className="pending-tray-bulk">
              {chatMode !== "craft" && (
                <button
                  type="button"
                  className="small-btn small-btn-accept"
                  onClick={onAcceptAll}
                >
                  <CheckCheck size={12} /> All
                </button>
              )}
              <button
                type="button"
                className="small-btn small-btn-reject"
                onClick={onRejectAll}
              >
                <X size={12} /> Clear
              </button>
            </div>
          </div>

          {showChangesTray && (
            <div className="pending-tray-list">
              {Array.from(grouped.entries()).map(([kind, items]) => (
                <div key={kind} className="hunk-group">
                  <div className="hunk-group-header">
                    <span className={`cm-hunk-badge cm-hunk-badge-${kind}`}>
                      {KIND_LABELS[kind]} ({items.length})
                    </span>
                    {items.length > 1 && (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => onAcceptKind(kind)}
                      >
                        Accept all {KIND_LABELS[kind].toLowerCase()}
                      </button>
                    )}
                  </div>

                  {items.map((hunk) => {
                    const isFocused = hunk.id === focusedId;
                    return (
                      <div
                        key={hunk.id}
                        className={`hunk-card ${isFocused ? "is-focused" : ""}`}
                        onClick={() => onFocusHunk(hunk.id)}
                      >
                        <p className="hunk-card-diff">
                          {hunk.tokens.map((tok, i) => (
                            <span
                              key={i}
                              className={
                                tok.op === "delete"
                                  ? "card-del"
                                  : tok.op === "insert"
                                    ? "card-ins"
                                    : "card-eq"
                              }
                            >
                              {tok.text}
                            </span>
                          ))}
                        </p>
                        <p className="hunk-card-rationale">{hunk.rationale}</p>
                        <div className="hunk-card-actions">
                          <button
                            type="button"
                            className="small-btn small-btn-accept"
                            onClick={(e) => {
                              e.stopPropagation();
                              onAcceptHunk(hunk.id);
                            }}
                          >
                            <Check size={12} /> Accept
                          </button>
                          <button
                            type="button"
                            className="small-btn small-btn-reject"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRejectHunk(hunk.id);
                            }}
                          >
                            <X size={12} /> Reject
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Multi-turn Free-Text Composer with `/` Slash Command & Popover Pickers */}
      <div className="chat-composer" ref={composerRef}>
        {openMenu === "mode" && (
          <div className="composer-popover" role="menu" aria-label="Conversation mode">
            {CHAT_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="menuitemradio"
                aria-checked={chatMode === opt.id}
                className={`composer-popover-item ${chatMode === opt.id ? "is-selected" : ""}`}
                onClick={() => {
                  onChatModeChange(opt.id);
                  setOpenMenu(null);
                }}
              >
                <div className="composer-popover-row">
                  <span className="composer-popover-label">{opt.label}</span>
                  {chatMode === opt.id && <Check size={12} />}
                </div>
                <span className="composer-popover-desc">{opt.desc}</span>
              </button>
            ))}
          </div>
        )}

        {openMenu === "model" && (
          <div className="composer-popover composer-popover-scroll" role="menu" aria-label="Model">
            <div className="composer-popover-group">
              {provider === "anthropic_api"
                ? "Anthropic API"
                : providerStatus?.claude_cli_available === false
                  ? "Claude CLI (not found)"
                  : "Claude CLI"}
            </div>
            {CLAUDE_MODELS.map((opt) => {
              const effProvider: ProviderKind =
                provider === "anthropic_api" ? "anthropic_api" : "claude_cli";
              const isSelected = provider === effProvider && model === opt.model;
              const isDisabled =
                effProvider === "claude_cli" &&
                providerStatus?.claude_cli_available === false;
              return (
                <button
                  key={`${effProvider}::${opt.model}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  disabled={isDisabled}
                  className={`composer-popover-item ${isSelected ? "is-selected" : ""}`}
                  onClick={() => {
                    onSelectModel(effProvider, opt.model);
                    setOpenMenu(null);
                  }}
                >
                  <div className="composer-popover-row">
                    <span className="composer-popover-label">{opt.label}</span>
                    {isSelected && <Check size={12} />}
                  </div>
                </button>
              );
            })}

            <div className="composer-popover-group">
              {providerStatus?.agy_cli_available === false
                ? "Antigravity CLI (not found)"
                : "Antigravity (agy)"}
            </div>
            {AGY_MODELS.map((opt) => {
              const isSelected = provider === "agy_cli" && model === opt.model;
              return (
                <button
                  key={`agy_cli::${opt.model}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  disabled={providerStatus?.agy_cli_available === false}
                  className={`composer-popover-item ${isSelected ? "is-selected" : ""}`}
                  onClick={() => {
                    onSelectModel("agy_cli", opt.model);
                    setOpenMenu(null);
                  }}
                >
                  <div className="composer-popover-row">
                    <span className="composer-popover-label">{opt.label}</span>
                    {isSelected && <Check size={12} />}
                  </div>
                </button>
              );
            })}

            <div className="composer-popover-group">
              {providerStatus?.codex_cli_available === false
                ? "Codex CLI (not found)"
                : "Codex"}
            </div>
            {CODEX_MODELS.map((opt) => {
              const isSelected = provider === "codex_cli" && model === opt.model;
              return (
                <button
                  key={`codex_cli::${opt.model}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  disabled={providerStatus?.codex_cli_available === false}
                  className={`composer-popover-item ${isSelected ? "is-selected" : ""}`}
                  onClick={() => {
                    onSelectModel("codex_cli", opt.model);
                    setOpenMenu(null);
                  }}
                >
                  <div className="composer-popover-row">
                    <span className="composer-popover-label">{opt.label}</span>
                    {isSelected && <Check size={12} />}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {openMenu === "effort" && (
          <div className="composer-popover composer-popover-compact" role="menu" aria-label="Thinking effort">
            <div className="composer-popover-group">Thinking effort</div>
            {effortOptions.map((lvl) => (
              <button
                key={lvl}
                type="button"
                role="menuitemradio"
                aria-checked={effort === lvl}
                className={`composer-popover-item ${effort === lvl ? "is-selected" : ""}`}
                onClick={() => {
                  onEffortChange(lvl);
                  setOpenMenu(null);
                }}
              >
                <div className="composer-popover-row">
                  <span className="composer-popover-label">
                    {EFFORT_LABELS[lvl].label}
                  </span>
                  {effort === lvl && <Check size={12} />}
                </div>
              </button>
            ))}
          </div>
        )}

        {showSlashMenu && (
          <div className="slash-menu" role="listbox" aria-label="Skills">
            {matchedSkills.length > 0 ? (
              <>
                <div className="slash-menu-list">
                  {matchedSkills.map((skill, idx) => {
                    const isSelected = idx === slashIndex;
                    return (
                      <button
                        key={skill.slug}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`slash-item ${isSelected ? "is-selected" : ""}`}
                        onMouseEnter={() => setSlashIndex(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          runSkill(skill);
                        }}
                      >
                        <div className="slash-item-top">
                          <span className="slash-slug">/{skill.slug}</span>
                          {skill.runner === "pangram" && (
                            <span className="slash-badge">pangram</span>
                          )}
                          {!skill.allow_edits && skill.runner !== "pangram" && (
                            <span className="slash-badge">notes only</span>
                          )}
                          {skill.source === "workspace" && (
                            <span className="slash-badge">workspace</span>
                          )}
                        </div>
                        <span className="slash-desc">{skill.description}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="slash-hint-bar">
                  <span>↵ run</span>
                  <span>⇥ add args</span>
                  <span>esc close</span>
                </div>
              </>
            ) : (
              <div className="slash-empty">
                No skill matching <code>/{slashQuery}</code>
              </div>
            )}
          </div>
        )}

        {activeSelection && scopeToSelection && (
          <div className="composer-selection-pill">
            <span>
              Scoped to selection ({selectionWordCount}{" "}
              {selectionWordCount === 1 ? "word" : "words"})
            </span>
            <button
              type="button"
              className="composer-selection-clear"
              onClick={() => setScopeToSelection(false)}
              title="Talk about the full document instead"
            >
              <X size={11} />
            </button>
          </div>
        )}

        <div className="composer-box">
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            rows={2}
            placeholder={
              activeSelection && scopeToSelection
                ? "Ask about this selection or type /…"
                : "Ask or type / for skills…"
            }
            value={draft}
            disabled={running}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (showSlashMenu && matchedSkills.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIndex((i) => (i + 1) % matchedSkills.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIndex(
                    (i) => (i - 1 + matchedSkills.length) % matchedSkills.length,
                  );
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  const picked = matchedSkills[slashIndex] ?? matchedSkills[0];
                  if (picked) completeSkill(picked);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const picked = matchedSkills[slashIndex] ?? matchedSkills[0];
                  if (picked) runSkill(picked);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }

              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <div className="composer-footer">
            <div className="composer-pickers">
              <button
                type="button"
                className={`composer-pill ${openMenu === "mode" ? "is-open" : ""}`}
                disabled={running}
                onClick={() =>
                  setOpenMenu((m) => (m === "mode" ? null : "mode"))
                }
                title={`Mode: ${activeModeLabel}`}
              >
                <span>{activeModeLabel}</span>
                <ChevronDown size={11} className="composer-pill-chevron" />
              </button>

              <span className="composer-sep" aria-hidden="true" />

              <button
                type="button"
                className={`composer-pill ${openMenu === "model" ? "is-open" : ""}`}
                disabled={running}
                onClick={() =>
                  setOpenMenu((m) => (m === "model" ? null : "model"))
                }
                title={`Model: ${activeModelOption?.label ?? model}`}
              >
                <span>{activeModelShort}</span>
                <ChevronDown size={11} className="composer-pill-chevron" />
              </button>

              <button
                type="button"
                className={`composer-pill ${openMenu === "effort" ? "is-open" : ""}`}
                disabled={running}
                onClick={() =>
                  setOpenMenu((m) => (m === "effort" ? null : "effort"))
                }
                title={`Thinking effort: ${EFFORT_LABELS[effort].label}`}
              >
                <span>{EFFORT_LABELS[effort].short}</span>
                <ChevronDown size={11} className="composer-pill-chevron" />
              </button>
            </div>

            <button
              type="button"
              className="composer-send-btn"
              disabled={running || !draft.trim()}
              onClick={handleSubmit}
              title="Send (Enter)"
            >
              {running ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <ArrowUp size={13} />
              )}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
