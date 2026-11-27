import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  Cpu,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  AGY_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  supportsXhighEffort,
} from "./ReviewDrawer";
import type {
  ApiKeyService,
  ApiKeyStatus,
  EffortLevel,
  PromptConfig,
  ProviderKind,
  ProviderStatus,
  SaveSkillInput,
  SecretSource,
  Skill,
  SkillRunner,
  SkillsCatalog,
  SkillSource,
} from "../types";

export type SettingsSection = "skills" | "prompts" | "models" | "editor";

interface SettingsPageProps {
  initialSection?: SettingsSection;
  skillsCatalog: SkillsCatalog | null;
  promptConfig: PromptConfig | null;
  apiKeyStatus: ApiKeyStatus | null;
  workspacePath: string | null;
  writerGuidePath: string | null;
  writerGuide: string | null;
  provider: ProviderKind;
  onProviderChange: (provider: ProviderKind) => void;
  model: string;
  onSelectModel: (provider: ProviderKind, model: string) => void;
  effort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  providerStatus: ProviderStatus | null;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  showAllFiles: boolean;
  onToggleShowAllFiles: () => void;
  inlineIslandsEnabled: boolean;
  onToggleInlineIslands: () => void;
  onSaveSkill: (input: SaveSkillInput) => Promise<Skill>;
  onDeleteSkill: (skill: Skill) => Promise<void>;
  onReloadSkills: () => void;
  onOpenSkillsFolder: () => void;
  onRevealPath: (path: string) => void;
  onSavePromptConfig: (config: PromptConfig) => Promise<void>;
  onResetPromptConfig: () => Promise<void>;
  onSaveApiKey: (service: ApiKeyService, key: string) => Promise<void>;
  onClearApiKey: (service: ApiKeyService) => Promise<void>;
  onOpenFileInEditor: (path: string) => void;
  softwareUpdates: ReactNode;
  onClose: () => void;
}

interface SkillDraft {
  existingPath: string | null;
  slug: string;
  name: string;
  description: string;
  allowEdits: boolean;
  runner: SkillRunner;
  defaultPrompt: string;
  instructions: string;
  source: SkillSource;
  order: number;
}

function skillToDraft(skill: Skill): SkillDraft {
  return {
    existingPath: skill.path,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    allowEdits: skill.allow_edits,
    runner: skill.runner ?? "llm",
    defaultPrompt: skill.default_prompt,
    instructions: skill.instructions,
    source: skill.source,
    order: skill.order,
  };
}

function emptySkillDraft(source: SkillSource): SkillDraft {
  return {
    existingPath: null,
    slug: "",
    name: "",
    description: "",
    allowEdits: true,
    runner: "llm",
    defaultPrompt: "",
    instructions: "",
    source,
    order: 50,
  };
}

function formatSecretSource(source: SecretSource | null): string {
  switch (source) {
    case "saved":
      return "Saved locally";
    case "env":
      return "Environment";
    case "dotenv":
      return "From .env";
    default:
      return "Not set";
  }
}

export function SettingsPage({
  initialSection = "skills",
  skillsCatalog,
  promptConfig,
  apiKeyStatus,
  workspacePath,
  writerGuidePath,
  writerGuide,
  provider,
  onProviderChange,
  model,
  onSelectModel,
  effort,
  onEffortChange,
  providerStatus,
  theme,
  onThemeChange,
  showAllFiles,
  onToggleShowAllFiles,
  inlineIslandsEnabled,
  onToggleInlineIslands,
  onSaveSkill,
  onDeleteSkill,
  onReloadSkills,
  onOpenSkillsFolder,
  onRevealPath,
  onSavePromptConfig,
  onResetPromptConfig,
  onSaveApiKey,
  onClearApiKey,
  onOpenFileInEditor,
  softwareUpdates,
  onClose,
}: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [pangramKeyInput, setPangramKeyInput] = useState("");
  const [anthropicKeyInput, setAnthropicKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState<ApiKeyService | null>(null);
  const [keyFeedback, setKeyFeedback] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Sync if caller re-opens Settings targeted at a specific tab.
  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  const skills = skillsCatalog?.skills ?? [];

  // Skills editor state
  const [selectedPath, setSelectedPath] = useState<string | "__new__" | null>(
    () => skills[0]?.path ?? null,
  );
  const [skillDraft, setSkillDraft] = useState<SkillDraft>(() =>
    skills[0] ? skillToDraft(skills[0]) : emptySkillDraft("app"),
  );
  const [skillDirty, setSkillDirty] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillFeedback, setSkillFeedback] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);

  // Keep a valid skill selected whenever the catalog loads/changes.
  useEffect(() => {
    if (selectedPath === "__new__") return;
    const match = skills.find((s) => s.path === selectedPath) ?? skills[0] ?? null;
    if (match && (!skillDirty || match.path !== selectedPath)) {
      setSelectedPath(match.path);
      setSkillDraft(skillToDraft(match));
      setSkillDirty(false);
    } else if (!match && skills.length === 0) {
      setSelectedPath("__new__");
      setSkillDraft(emptySkillDraft("app"));
      setSkillDirty(false);
    }
  }, [skills, selectedPath, skillDirty]);

  // System prompt config editor state
  const [promptDraft, setPromptDraft] = useState<PromptConfig | null>(
    promptConfig,
  );
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptFeedback, setPromptFeedback] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);

  useEffect(() => {
    if (promptConfig && !promptDirty) {
      setPromptDraft(promptConfig);
    }
  }, [promptConfig, promptDirty]);

  const selectSkill = (skill: Skill) => {
    setSelectedPath(skill.path);
    setSkillDraft(skillToDraft(skill));
    setSkillDirty(false);
    setSkillError(null);
    setSkillFeedback(null);
  };

  const startNewSkill = () => {
    setSelectedPath("__new__");
    setSkillDraft(emptySkillDraft("app"));
    setSkillDirty(true);
    setSkillError(null);
    setSkillFeedback(null);
  };

  const updateSkillDraft = <K extends keyof SkillDraft>(
    key: K,
    value: SkillDraft[K],
  ) => {
    setSkillDraft((prev) => ({ ...prev, [key]: value }));
    setSkillDirty(true);
    setSkillError(null);
    setSkillFeedback(null);
  };

  const handleSaveSkillSubmit = async () => {
    setSkillSaving(true);
    setSkillError(null);
    setSkillFeedback(null);
    try {
      const saved = await onSaveSkill({
        existing_path: skillDraft.existingPath,
        slug: skillDraft.slug,
        name: skillDraft.name,
        description: skillDraft.description,
        allow_edits: skillDraft.allowEdits,
        runner: skillDraft.runner,
        default_prompt: skillDraft.defaultPrompt,
        instructions: skillDraft.instructions,
        source: skillDraft.source,
        order: Number.isFinite(skillDraft.order) ? skillDraft.order : 100,
      });
      setSelectedPath(saved.path);
      setSkillDraft(skillToDraft(saved));
      setSkillDirty(false);
      setSkillFeedback(`Saved /${saved.slug}`);
    } catch (err) {
      setSkillError(String(err));
    } finally {
      setSkillSaving(false);
    }
  };

  const handleDeleteCurrentSkill = async () => {
    if (!skillDraft.existingPath) return;
    const current = skills.find((s) => s.path === skillDraft.existingPath);
    if (!current) return;
    setSkillError(null);
    try {
      await onDeleteSkill(current);
      setSelectedPath(null);
      setSkillDirty(false);
      setSkillFeedback(`Moved /${current.slug} to Trash`);
    } catch (err) {
      setSkillError(String(err));
    }
  };

  const handleRevertSkill = () => {
    if (selectedPath === "__new__") {
      if (skills[0]) {
        selectSkill(skills[0]);
      } else {
        setSkillDraft(emptySkillDraft("app"));
        setSkillDirty(false);
      }
      return;
    }
    const orig = skills.find((s) => s.path === selectedPath);
    if (orig) {
      setSkillDraft(skillToDraft(orig));
      setSkillDirty(false);
      setSkillError(null);
    }
  };

  const updatePromptField = <K extends keyof PromptConfig>(
    key: K,
    value: string,
  ) => {
    setPromptDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    setPromptDirty(true);
    setPromptError(null);
    setPromptFeedback(null);
  };

  const handleSavePrompts = async () => {
    if (!promptDraft) return;
    setPromptSaving(true);
    setPromptError(null);
    setPromptFeedback(null);
    try {
      await onSavePromptConfig(promptDraft);
      setPromptDirty(false);
      setPromptFeedback("Saved base prompts");
    } catch (err) {
      setPromptError(String(err));
    } finally {
      setPromptSaving(false);
    }
  };

  const handleResetPrompts = async () => {
    setPromptSaving(true);
    setPromptError(null);
    setPromptFeedback(null);
    try {
      await onResetPromptConfig();
      setPromptDirty(false);
      setPromptFeedback("Restored default prompts");
    } catch (err) {
      setPromptError(String(err));
    } finally {
      setPromptSaving(false);
    }
  };

  const handleSaveKeySubmit = async (service: ApiKeyService) => {
    const val =
      service === "pangram" ? pangramKeyInput.trim() : anthropicKeyInput.trim();
    if (!val) return;
    setKeyBusy(service);
    setKeyError(null);
    setKeyFeedback(null);
    try {
      await onSaveApiKey(service, val);
      if (service === "pangram") setPangramKeyInput("");
      else setAnthropicKeyInput("");
      setKeyFeedback(
        `Saved ${service === "pangram" ? "Pangram" : "Anthropic"} key securely`,
      );
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setKeyBusy(null);
    }
  };

  const handleClearKeySubmit = async (service: ApiKeyService) => {
    setKeyBusy(service);
    setKeyError(null);
    setKeyFeedback(null);
    try {
      await onClearApiKey(service);
      setKeyFeedback(
        `Cleared saved ${service === "pangram" ? "Pangram" : "Anthropic"} key`,
      );
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setKeyBusy(null);
    }
  };

  const currentProviderModels =
    provider === "agy_cli"
      ? AGY_MODELS
      : provider === "codex_cli"
        ? CODEX_MODELS
        : CLAUDE_MODELS;

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label="Settings sections">
        <button
          type="button"
          className="settings-back-btn"
          onClick={onClose}
        >
          <ArrowLeft size={14} /> Back to Editor
        </button>

        <div className="settings-nav-group">
          <button
            type="button"
            className={`settings-nav-item ${section === "skills" ? "is-active" : ""}`}
            onClick={() => setSection("skills")}
          >
            <Sparkles size={14} />
            <span>Skills</span>
            <span className="settings-nav-count">{skills.length}</span>
          </button>

          <button
            type="button"
            className={`settings-nav-item ${section === "prompts" ? "is-active" : ""}`}
            onClick={() => setSection("prompts")}
          >
            <FileCode2 size={14} />
            <span>System Prompts</span>
          </button>

          <button
            type="button"
            className={`settings-nav-item ${section === "models" ? "is-active" : ""}`}
            onClick={() => setSection("models")}
          >
            <Cpu size={14} />
            <span>Models &amp; Keys</span>
          </button>

          <button
            type="button"
            className={`settings-nav-item ${section === "editor" ? "is-active" : ""}`}
            onClick={() => setSection("editor")}
          >
            <SlidersHorizontal size={14} />
            <span>Editor &amp; Theme</span>
          </button>
        </div>

        <div className="settings-nav-footer">
          <span>Shortcut: <code>⌘,</code></span>
        </div>
      </nav>

      <div className="settings-content">
        {section === "skills" && (
          <div className="settings-skills-layout">
            <div className="settings-section-header">
              <div>
                <h1 className="settings-h1">Skills</h1>
                <p className="settings-lead">
                  Markdown files invoked with <code>/</code> in chat. Edit any
                  skill’s prompt right here — changes save directly to disk.
                </p>
              </div>
              <div className="settings-header-actions">
                <button
                  type="button"
                  className="small-btn"
                  onClick={onReloadSkills}
                  title="Reload skill files from disk"
                >
                  <RefreshCw size={12} /> Reload
                </button>
                {skillsCatalog?.app_skills_dir && (
                  <button
                    type="button"
                    className="small-btn"
                    onClick={onOpenSkillsFolder}
                    title={skillsCatalog.app_skills_dir}
                  >
                    <FolderOpen size={12} /> Open Folder
                  </button>
                )}
                <button
                  type="button"
                  className="primary-btn settings-new-btn"
                  onClick={startNewSkill}
                >
                  <Plus size={13} /> New Skill
                </button>
              </div>
            </div>

            <div className="skills-master-detail">
              <div className="skills-list" role="listbox" aria-label="Skills list">
                {skills.map((skill) => {
                  const isActive = selectedPath === skill.path;
                  return (
                    <button
                      key={skill.path}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={`skills-list-item ${isActive ? "is-active" : ""}`}
                      onClick={() => selectSkill(skill)}
                    >
                      <div className="skills-list-top">
                        <span className="slash-slug">/{skill.slug}</span>
                        {skill.source === "workspace" && (
                          <span className="slash-badge">workspace</span>
                        )}
                        {!skill.allow_edits && (
                          <span className="slash-badge">notes only</span>
                        )}
                      </div>
                      <span className="skills-list-desc">
                        {skill.description}
                      </span>
                    </button>
                  );
                })}

                {selectedPath === "__new__" && (
                  <div className="skills-list-item is-active">
                    <div className="skills-list-top">
                      <span className="slash-slug">
                        /{skillDraft.slug || "new-skill"}
                      </span>
                      <span className="slash-badge">unsaved</span>
                    </div>
                    <span className="skills-list-desc">
                      {skillDraft.description || "Drafting new skill…"}
                    </span>
                  </div>
                )}
              </div>

              <div className="skill-editor-card">
                <div className="skill-form-grid">
                  <label className="settings-field">
                    <span className="settings-label">Command slug</span>
                    <div className="slug-input-wrap">
                      <span className="slug-prefix">/</span>
                      <input
                        type="text"
                        className="settings-input slug-input"
                        placeholder="proofread"
                        value={skillDraft.slug}
                        onChange={(e) =>
                          updateSkillDraft("slug", e.target.value)
                        }
                      />
                    </div>
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">Display name</span>
                    <input
                      type="text"
                      className="settings-input"
                      placeholder="Proofread"
                      value={skillDraft.name}
                      onChange={(e) => updateSkillDraft("name", e.target.value)}
                    />
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">Scope</span>
                    <select
                      className="settings-input"
                      value={skillDraft.source}
                      disabled={Boolean(skillDraft.existingPath)}
                      onChange={(e) =>
                        updateSkillDraft("source", e.target.value as SkillSource)
                      }
                    >
                      <option value="app">App (skills/)</option>
                      <option value="workspace" disabled={!workspacePath}>
                        Workspace (.writer/skills/)
                        {!workspacePath ? " — open a folder" : ""}
                      </option>
                    </select>
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">Menu order</span>
                    <input
                      type="number"
                      className="settings-input"
                      value={skillDraft.order}
                      onChange={(e) =>
                        updateSkillDraft("order", Number(e.target.value) || 0)
                      }
                    />
                  </label>
                </div>

                <label className="settings-field">
                  <span className="settings-label">
                    Short description (shown in the <code>/</code> menu)
                  </span>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="Typos, doubled words, and broken grammar only"
                    value={skillDraft.description}
                    onChange={(e) =>
                      updateSkillDraft("description", e.target.value)
                    }
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-label">
                    Default user prompt (used when running <code>/{skillDraft.slug || "skill"}</code> with no extra text)
                  </span>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="Proofread this draft…"
                    value={skillDraft.defaultPrompt}
                    onChange={(e) =>
                      updateSkillDraft("defaultPrompt", e.target.value)
                    }
                  />
                </label>

                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={skillDraft.allowEdits}
                    onChange={(e) =>
                      updateSkillDraft("allowEdits", e.target.checked)
                    }
                  />
                  <div>
                    <div className="settings-toggle-title">
                      Allow inline text edits
                    </div>
                    <div className="settings-toggle-sub">
                      When off, Rust hard-enforces zero edits (margin notes and
                      chat replies only, like <code>/critique</code>).
                    </div>
                  </div>
                </label>

                <label className="settings-field settings-field-grow">
                  <span className="settings-label">
                    Skill prompt / instructions (Markdown sent to the model)
                  </span>
                  <textarea
                    className="settings-textarea"
                    rows={10}
                    placeholder="Describe exactly how the model should behave when this skill is invoked…"
                    value={skillDraft.instructions}
                    onChange={(e) =>
                      updateSkillDraft("instructions", e.target.value)
                    }
                  />
                </label>

                {skillError && <p className="drawer-error">{skillError}</p>}

                <div className="skill-editor-footer">
                  <div className="skill-path-meta">
                    {skillDraft.existingPath ? (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => onRevealPath(skillDraft.existingPath!)}
                        title={skillDraft.existingPath}
                      >
                        <ExternalLink size={11} />{" "}
                        {skillDraft.existingPath.split("/").slice(-2).join("/")}
                      </button>
                    ) : (
                      <span>New .md file will be created on save</span>
                    )}
                    {skillFeedback && (
                      <span className="settings-saved-pill">
                        <Check size={11} /> {skillFeedback}
                      </span>
                    )}
                  </div>

                  <div className="skill-footer-actions">
                    {skillDraft.existingPath && (
                      <button
                        type="button"
                        className="small-btn small-btn-reject"
                        onClick={() => void handleDeleteCurrentSkill()}
                        disabled={skillSaving}
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    )}
                    <button
                      type="button"
                      className="small-btn"
                      onClick={handleRevertSkill}
                      disabled={!skillDirty || skillSaving}
                    >
                      Revert
                    </button>
                    <button
                      type="button"
                      className="primary-btn settings-save-btn"
                      onClick={() => void handleSaveSkillSubmit()}
                      disabled={
                        skillSaving ||
                        !skillDraft.slug.trim() ||
                        !skillDraft.instructions.trim()
                      }
                    >
                      <Save size={12} /> {skillSaving ? "Saving…" : "Save Skill"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {section === "prompts" && promptDraft && (
          <div className="settings-scroll-pane">
            <div className="settings-section-header">
              <div>
                <h1 className="settings-h1">System Prompts &amp; Guardrails</h1>
                <p className="settings-lead">
                  Every prompt wrapped around your conversations,{" "}
                  <code>/skills</code>, and <code>⌘K</code> edits. Nothing is
                  hidden.
                </p>
              </div>
              <div className="settings-header-actions">
                <button
                  type="button"
                  className="small-btn"
                  onClick={() => void handleResetPrompts()}
                  disabled={promptSaving}
                >
                  <RotateCcw size={12} /> Reset Defaults
                </button>
                <button
                  type="button"
                  className="primary-btn settings-save-btn"
                  onClick={() => void handleSavePrompts()}
                  disabled={!promptDirty || promptSaving}
                >
                  <Save size={12} /> {promptSaving ? "Saving…" : "Save Prompts"}
                </button>
              </div>
            </div>

            {promptFeedback && (
              <p className="settings-saved-banner">
                <Check size={12} /> {promptFeedback}
              </p>
            )}
            {promptError && <p className="drawer-error">{promptError}</p>}

            <div className="settings-card-stack">
              <div className="settings-card">
                <label className="settings-field">
                  <span className="settings-label">Editorial Persona</span>
                  <span className="settings-sub">
                    Prepended to every request across all skills and modes.
                  </span>
                  <textarea
                    className="settings-textarea"
                    rows={3}
                    value={promptDraft.persona}
                    onChange={(e) =>
                      updatePromptField("persona", e.target.value)
                    }
                  />
                </label>
              </div>

              <div className="settings-card">
                <label className="settings-field">
                  <span className="settings-label">
                    Craft Mode Rules (Solveit / Socratic)
                  </span>
                  <span className="settings-sub">
                    Active in <strong>Craft</strong> mode: human-in-the-loop
                    coaching with Rust-enforced zero automatic rewrites.
                  </span>
                  <textarea
                    className="settings-textarea"
                    rows={7}
                    value={promptDraft.craft_rules}
                    onChange={(e) =>
                      updatePromptField("craft_rules", e.target.value)
                    }
                  />
                </label>
              </div>

              <div className="settings-card">
                <label className="settings-field">
                  <span className="settings-label">
                    Standard Conversation Rules
                  </span>
                  <span className="settings-sub">
                    Used in <strong>Standard</strong> mode when chatting without
                    a <code>/skill</code>.
                  </span>
                  <textarea
                    className="settings-textarea"
                    rows={6}
                    value={promptDraft.conversation_rules}
                    onChange={(e) =>
                      updatePromptField("conversation_rules", e.target.value)
                    }
                  />
                </label>
              </div>

              <div className="settings-card">
                <label className="settings-field">
                  <span className="settings-label">Concise Mode Rules</span>
                  <span className="settings-sub">
                    Used in <strong>Concise</strong> mode for ultra-terse,
                    zero-preamble replies.
                  </span>
                  <textarea
                    className="settings-textarea"
                    rows={4}
                    value={promptDraft.concise_rules}
                    onChange={(e) =>
                      updatePromptField("concise_rules", e.target.value)
                    }
                  />
                </label>
              </div>

              <div className="settings-card">
                <label className="settings-field">
                  <span className="settings-label">
                    ⌘K Targeted Edit Rules
                  </span>
                  <span className="settings-sub">
                    Used when pressing <code>⌘K</code> or turning a margin note
                    into an edit.
                  </span>
                  <textarea
                    className="settings-textarea"
                    rows={5}
                    value={promptDraft.cmdk_rules}
                    onChange={(e) =>
                      updatePromptField("cmdk_rules", e.target.value)
                    }
                  />
                </label>
              </div>

              <div className="settings-card">
                <label className="settings-field">
                  <span className="settings-label">
                    Strict Protocol &amp; Anti-Slop Rules
                  </span>
                  <span className="settings-sub">
                    Appended to every turn to enforce surgical anchors, voice
                    preservation, and MDX/LaTeX safety.
                  </span>
                  <textarea
                    className="settings-textarea"
                    rows={9}
                    value={promptDraft.protocol_rules}
                    onChange={(e) =>
                      updatePromptField("protocol_rules", e.target.value)
                    }
                  />
                </label>
              </div>

              <div className="settings-card">
                <div className="settings-card-row">
                  <div>
                    <div className="settings-label">
                      Workspace Voice Guide (<code>WRITER.md</code>)
                    </div>
                    <div className="settings-sub">
                      {writerGuidePath
                        ? writerGuidePath
                        : "Place a WRITER.md file in your writing folder to automatically append project voice rules."}
                    </div>
                  </div>
                  {writerGuidePath && (
                    <button
                      type="button"
                      className="small-btn"
                      onClick={() => {
                        onOpenFileInEditor(writerGuidePath);
                        onClose();
                      }}
                    >
                      Edit in Writer
                    </button>
                  )}
                </div>
                {writerGuide && (
                  <pre className="settings-code-preview">{writerGuide}</pre>
                )}
              </div>
            </div>
          </div>
        )}

        {section === "models" && (
          <div className="settings-scroll-pane">
            <div className="settings-section-header">
              <div>
                <h1 className="settings-h1">Models &amp; CLI Backends</h1>
                <p className="settings-lead">
                  Writer invokes your locally signed-in CLIs or Anthropic’s
                  Messages API through the same Rust guardrail pipeline.
                </p>
              </div>
            </div>

            <div className="settings-card-stack">
              <div className="provider-status-grid">
                <div
                  className={`provider-card ${provider === "claude_cli" ? "is-selected" : ""}`}
                  onClick={() => onProviderChange("claude_cli")}
                >
                  <div className="provider-card-top">
                    <span className="provider-card-name">Claude CLI</span>
                    <span
                      className={`status-dot ${providerStatus?.claude_cli_available ? "is-ready" : "is-missing"}`}
                    >
                      {providerStatus?.claude_cli_available
                        ? "Ready"
                        : "Not found"}
                    </span>
                  </div>
                  <div className="provider-card-path">
                    {providerStatus?.claude_cli_path ?? "claude not on PATH"}
                  </div>
                </div>

                <div
                  className={`provider-card ${provider === "agy_cli" ? "is-selected" : ""}`}
                  onClick={() => onProviderChange("agy_cli")}
                >
                  <div className="provider-card-top">
                    <span className="provider-card-name">
                      Antigravity CLI (<code>agy</code>)
                    </span>
                    <span
                      className={`status-dot ${providerStatus?.agy_cli_available ? "is-ready" : "is-missing"}`}
                    >
                      {providerStatus?.agy_cli_available
                        ? "Ready"
                        : "Not found"}
                    </span>
                  </div>
                  <div className="provider-card-path">
                    {providerStatus?.agy_cli_path ?? "agy not on PATH"}
                  </div>
                </div>

                <div
                  className={`provider-card ${provider === "codex_cli" ? "is-selected" : ""}`}
                  onClick={() => onProviderChange("codex_cli")}
                >
                  <div className="provider-card-top">
                    <span className="provider-card-name">
                      Codex CLI (<code>codex</code>)
                    </span>
                    <span
                      className={`status-dot ${providerStatus?.codex_cli_available ? "is-ready" : "is-missing"}`}
                    >
                      {providerStatus?.codex_cli_available
                        ? "Ready"
                        : "Not found"}
                    </span>
                  </div>
                  <div className="provider-card-path">
                    {providerStatus?.codex_cli_path ?? "codex not on PATH"}
                  </div>
                </div>

                <div
                  className={`provider-card ${provider === "anthropic_api" ? "is-selected" : ""}`}
                  onClick={() => onProviderChange("anthropic_api")}
                >
                  <div className="provider-card-top">
                    <span className="provider-card-name">Anthropic API</span>
                    <span
                      className={`status-dot ${apiKeyStatus?.anthropic.configured ? "is-ready" : "is-missing"}`}
                    >
                      {apiKeyStatus?.anthropic.configured
                        ? formatSecretSource(apiKeyStatus.anthropic.source)
                        : "Needs key"}
                    </span>
                  </div>
                  <div className="provider-card-path">
                    Direct HTTPS to api.anthropic.com
                  </div>
                </div>
              </div>

              <div className="settings-card">
                <div className="skill-form-grid">
                  <label className="settings-field">
                    <span className="settings-label">Active model</span>
                    <select
                      className="settings-input"
                      value={model}
                      onChange={(e) => onSelectModel(provider, e.target.value)}
                    >
                      {currentProviderModels.map((opt) => (
                        <option key={opt.model} value={opt.model}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-field">
                    <span className="settings-label">Thinking effort</span>
                    <select
                      className="settings-input"
                      value={effort}
                      onChange={(e) =>
                        onEffortChange(e.target.value as EffortLevel)
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      {supportsXhighEffort(provider) && (
                        <option value="xhigh">XHigh</option>
                      )}
                      <option value="max">Max</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="settings-card">
                <div className="settings-card-row" style={{ marginBottom: 10 }}>
                  <div>
                    <div className="settings-label">API Keys</div>
                    <div className="settings-sub">
                      Stored locally outside your git repository (
                      <code>0600</code> permissions) — never committed. Also
                      reads local <code>.env</code> and environment variables.
                    </div>
                  </div>
                  {keyFeedback && (
                    <span className="settings-saved-pill">
                      <Check size={11} /> {keyFeedback}
                    </span>
                  )}
                </div>

                {keyError && <p className="drawer-error">{keyError}</p>}

                <div className="api-key-block">
                  <div className="api-key-header">
                    <span className="settings-label">
                      Pangram API Key (<code>/pangram</code>)
                    </span>
                    <span
                      className={`status-dot ${apiKeyStatus?.pangram.configured ? "is-ready" : "is-missing"}`}
                    >
                      {apiKeyStatus?.pangram.configured
                        ? `${formatSecretSource(apiKeyStatus.pangram.source)} (${apiKeyStatus.pangram.masked_preview ?? "set"})`
                        : "Not set"}
                    </span>
                  </div>
                  <div className="api-key-form-row">
                    <input
                      type="password"
                      className="settings-input"
                      placeholder="Paste PANGRAM_API_KEY…"
                      value={pangramKeyInput}
                      onChange={(e) => setPangramKeyInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="primary-btn settings-save-btn"
                      disabled={
                        keyBusy === "pangram" || !pangramKeyInput.trim()
                      }
                      onClick={() => void handleSaveKeySubmit("pangram")}
                    >
                      Save
                    </button>
                    {apiKeyStatus?.pangram.source === "saved" && (
                      <button
                        type="button"
                        className="small-btn small-btn-reject"
                        disabled={keyBusy === "pangram"}
                        onClick={() => void handleClearKeySubmit("pangram")}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                <div className="api-key-block">
                  <div className="api-key-header">
                    <span className="settings-label">
                      Anthropic API Key (optional)
                    </span>
                    <span
                      className={`status-dot ${apiKeyStatus?.anthropic.configured ? "is-ready" : "is-missing"}`}
                    >
                      {apiKeyStatus?.anthropic.configured
                        ? `${formatSecretSource(apiKeyStatus.anthropic.source)} (${apiKeyStatus.anthropic.masked_preview ?? "set"})`
                        : "Not set"}
                    </span>
                  </div>
                  <div className="api-key-form-row">
                    <input
                      type="password"
                      className="settings-input"
                      placeholder="sk-ant-…"
                      value={anthropicKeyInput}
                      onChange={(e) => setAnthropicKeyInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="primary-btn settings-save-btn"
                      disabled={
                        keyBusy === "anthropic" || !anthropicKeyInput.trim()
                      }
                      onClick={() => void handleSaveKeySubmit("anthropic")}
                    >
                      Save
                    </button>
                    {apiKeyStatus?.anthropic.source === "saved" && (
                      <button
                        type="button"
                        className="small-btn small-btn-reject"
                        disabled={keyBusy === "anthropic"}
                        onClick={() => void handleClearKeySubmit("anthropic")}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {section === "editor" && (
          <div className="settings-scroll-pane">
            <div className="settings-section-header">
              <div>
                <h1 className="settings-h1">Editor &amp; Appearance</h1>
                <p className="settings-lead">
                  Visual preferences and keyboard shortcuts.
                </p>
              </div>
            </div>

            <div className="settings-card-stack">
              <div className="settings-card">
                <div className="settings-card-row">
                  <div>
                    <div className="settings-label">Paper theme</div>
                    <div className="settings-sub">
                      Warm editorial light paper or dark studio mode.
                    </div>
                  </div>
                  <div className="settings-segmented">
                    <button
                      type="button"
                      className={`small-btn ${theme === "light" ? "is-on" : ""}`}
                      onClick={() => onThemeChange("light")}
                    >
                      Warm Paper
                    </button>
                    <button
                      type="button"
                      className={`small-btn ${theme === "dark" ? "is-on" : ""}`}
                      onClick={() => onThemeChange("dark")}
                    >
                      Dark
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-card">
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={inlineIslandsEnabled}
                    onChange={onToggleInlineIslands}
                  />
                  <div>
                    <div className="settings-toggle-title">
                      Render live MDX React components inline
                    </div>
                    <div className="settings-toggle-sub">
                      Mounts interactive visualisations directly inside Live
                      Preview instead of compact component pills.
                    </div>
                  </div>
                </label>
              </div>

              <div className="settings-card">
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={showAllFiles}
                    onChange={onToggleShowAllFiles}
                  />
                  <div>
                    <div className="settings-toggle-title">
                      Show all files in sidebar
                    </div>
                    <div className="settings-toggle-sub">
                      When off, the sidebar filters to Markdown/MDX files only.
                    </div>
                  </div>
                </label>
              </div>

              {softwareUpdates}

              <div className="settings-card">
                <div className="settings-label" style={{ marginBottom: 8 }}>
                  Keyboard shortcuts
                </div>
                <div className="shortcuts-grid">
                  <div><code>⌘,</code> Open / close Settings</div>
                  <div><code>/</code> Run a skill in chat</div>
                  <div><code>⌘K</code> Targeted selection edit</div>
                  <div><code>⌘S</code> Save document</div>
                  <div><code>⌘O</code> Open writing folder</div>
                  <div><code>⌘N</code> New file</div>
                  <div><code>⌘\</code> Toggle sidebar</div>
                  <div><code>⌘⇧L</code> Toggle editor drawer</div>
                  <div><code>⌘]</code> / <code>⌘[</code> Next / previous edit</div>
                  <div><code>⌘↵</code> / <code>⌘⌫</code> Accept / reject edit</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
