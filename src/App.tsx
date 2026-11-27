import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
<<<<<<< HEAD
  Download,
=======
  Columns2,
  Download,
  Eye,
>>>>>>> b92d6d5ac290468eb2f0e6bbc40ebaae6333336e
  FilePlus,
  FolderOpen,
  Hexagon,
  Loader2,
  Moon,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Save,
  Settings,
  Sun,
  X,
} from "lucide-react";
import {
  checkProviders,
  clearApiKey,
  confirmAction,
  copyEntry,
  copyTextToClipboard,
  createFile,
  createFolder,
  deleteSkill,
  duplicateFile,
  ensureMdxServer,
  getApiKeyStatus,
  getPromptConfig,
  listSkills,
  loadDocumentThreads,
  moveEntry,
  onWorkspaceFileChanged,
  onWorkspaceTreeChanged,
  openWithDefaultApp,
  openWorkspace,
  pickWorkspaceFolder,
  pushMdxBuffer,
  readDocument,
  refreshWorkspace,
  remapDocumentThreads,
  renameEntry,
  resetPromptConfig,
  revealInFinder,
  runChatTurn,
  runPangramCheck,
  saveApiKey,
  saveDocument,
  saveDocumentThreads,
  savePromptConfig,
  saveSkill,
  trashEntry,
} from "./api";
import {
  defaultModelForProvider,
  ReviewDrawer,
  supportsXhighEffort,
} from "./components/ReviewDrawer";
import {
  SettingsPage,
  type SettingsSection,
} from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { useWriterUpdates, WriterUpdates } from "./components/WriterUpdates";
import type { ActiveComment, DiffOverlayState } from "./editor/diffExtension";
import { getDocumentModeInfo } from "./editor/codeMode";
import {
  EditorCanvas,
  type EditorCanvasHandle,
  type SelectionSnapshot,
} from "./editor/EditorCanvas";
import type {
  ApiKeyService,
  ApiKeyStatus,
  ChatMessage,
  ChatMode,
  ChatThread,
  ChatThreadItem,
  DocumentThreadsFileWire,
  EditMode,
  EffortLevel,
  FileNode,
  HeadingItem,
  PageMetadata,
  PromptConfig,
  ProviderKind,
  ProviderStatus,
  RejectedEdit,
  SaveSkillInput,
  Skill,
  SkillsCatalog,
} from "./types";

const WORKSPACE_STORAGE_KEY = "writer:last-workspace";
const LAST_FILE_STORAGE_KEY = "writer:last-file";
const RECENT_WORKSPACES_KEY = "writer:recent-workspaces";
const THEME_STORAGE_KEY = "writer:theme";
const PROVIDER_STORAGE_KEY = "writer:provider";
const MODEL_STORAGE_KEY = "writer:model";
const EFFORT_STORAGE_KEY = "writer:effort";
const CHAT_MODE_STORAGE_KEY = "writer:chat-mode";
const LEFT_WIDTH_STORAGE_KEY = "writer:left-width";
const RIGHT_WIDTH_STORAGE_KEY = "writer:right-width";

const DEFAULT_LEFT_WIDTH = 248;
const MIN_LEFT_WIDTH = 180;
const MAX_LEFT_WIDTH = 480;

const DEFAULT_RIGHT_WIDTH = 344;
const MIN_RIGHT_WIDTH = 260;
const MAX_RIGHT_WIDTH = 640;

function loadPanelWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function loadRecentWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_WORKSPACES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

function recordRecentWorkspace(path: string): string[] {
  const next = [path, ...loadRecentWorkspaces().filter((p) => p !== path)].slice(
    0,
    5,
  );
  localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next));
  return next;
}

/**
 * Updates `activePath` if either the file itself or one of its ancestor folders
 * was renamed or moved from `oldPath` to `newPath`.
 */
function remapAffectedPath(
  activePath: string | null,
  oldPath: string,
  newPath: string,
): string | null {
  if (!activePath) return null;
  if (activePath === oldPath) return newPath;
  if (activePath.startsWith(`${oldPath}/`)) {
    return `${newPath}${activePath.slice(oldPath.length)}`;
  }
  return activePath;
}

function wireToThreads(wire: DocumentThreadsFileWire): ChatThread[] {
  return wire.threads.map((t) => ({
    id: t.id,
    title: t.title,
    createdAtMs: t.created_at_ms,
    updatedAtMs: t.updated_at_ms,
    messages: t.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      mode: m.mode ?? null,
      skillSlug: m.skill_slug ?? null,
      selectionPreview: m.selection_preview ?? null,
      editCount: m.edit_count ?? undefined,
      commentCount: m.comment_count ?? undefined,
      meta: m.meta ?? null,
      pinned: Boolean(m.pinned),
      hidden: Boolean(m.hidden),
    })),
  }));
}

function threadsToWire(
  filePath: string,
  activeThreadId: string | null,
  threads: ChatThread[],
): DocumentThreadsFileWire {
  return {
    file_path: filePath,
    active_thread_id: activeThreadId,
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title,
      created_at_ms: t.createdAtMs,
      updated_at_ms: t.updatedAtMs,
      messages: t.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        mode: m.mode ?? null,
        skill_slug: m.skillSlug ?? null,
        selection_preview: m.selectionPreview ?? null,
        edit_count: m.editCount ?? null,
        comment_count: m.commentCount ?? null,
        meta: m.meta ?? null,
        pinned: Boolean(m.pinned),
        hidden: Boolean(m.hidden),
      })),
    })),
  };
}

function buildThreadTitle(userText: string, skillSlug?: string | null): string {
  const clean = userText.replace(/\s+/g, " ").trim();
  const prefix = skillSlug ? `/${skillSlug} · ` : "";
  const combined = `${prefix}${clean}`;
  return combined.length > 56 ? `${combined.slice(0, 53)}…` : combined;
}

export default function App() {
  const editorRef = useRef<EditorCanvasHandle | null>(null);
  const cmdKInputRef = useRef<HTMLInputElement | null>(null);

  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light",
  );
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [leftWidth, setLeftWidth] = useState<number>(() =>
    loadPanelWidth(
      LEFT_WIDTH_STORAGE_KEY,
      DEFAULT_LEFT_WIDTH,
      MIN_LEFT_WIDTH,
      MAX_LEFT_WIDTH,
    ),
  );
  const [rightWidth, setRightWidth] = useState<number>(() =>
    loadPanelWidth(
      RIGHT_WIDTH_STORAGE_KEY,
      DEFAULT_RIGHT_WIDTH,
      MIN_RIGHT_WIDTH,
      MAX_RIGHT_WIDTH,
    ),
  );
  const [resizingSide, setResizingSide] = useState<"left" | "right" | null>(
    null,
  );

  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() =>
    loadRecentWorkspaces(),
  );
  const [showAllFiles, setShowAllFiles] = useState(true);
  const [createFileTrigger, setCreateFileTrigger] = useState(0);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [outline, setOutline] = useState<HeadingItem[]>([]);
  const [pageMetadata, setPageMetadata] = useState<PageMetadata | null>(null);
  const [wordCount, setWordCount] = useState<number>(0);
  const [writerGuide, setWriterGuide] = useState<string | null>(null);
  const [writerGuidePath, setWriterGuidePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const updates = useWriterUpdates();
  const [externalChange, setExternalChange] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // MDX live inline component rendering state
  const [sourceMode, setSourceMode] = useState(false);
  const [inlineIslandsEnabled, setInlineIslandsEnabled] = useState(true);
  const [mdxServerUrl, setMdxServerUrl] = useState<string | null>(null);
  const [islandRev, setIslandRev] = useState(0);
  const bufferSyncTimerRef = useRef<number | null>(null);

  // LLM / Persistent per-document multi-turn conversation state
  const [docThreads, setDocThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const docThreadsRef = useRef<ChatThread[]>(docThreads);
  docThreadsRef.current = docThreads;
  const activeThreadIdRef = useRef<string | null>(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const [activeSelection, setActiveSelection] =
    useState<SelectionSnapshot | null>(null);
  const [provider, setProvider] = useState<ProviderKind>(() => {
    const saved = localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (
      saved === "claude_cli" ||
      saved === "agy_cli" ||
      saved === "codex_cli" ||
      saved === "anthropic_api"
    ) {
      return saved;
    }
    return "claude_cli";
  });
  const [model, setModel] = useState<string>(
    () => localStorage.getItem(MODEL_STORAGE_KEY) || "sonnet",
  );
  const [effort, setEffort] = useState<EffortLevel>(() => {
    const saved = localStorage.getItem(EFFORT_STORAGE_KEY);
    if (
      saved === "low" ||
      saved === "medium" ||
      saved === "high" ||
      saved === "xhigh" ||
      saved === "max"
    ) {
      return saved;
    }
    return "medium";
  });
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    const saved = localStorage.getItem(CHAT_MODE_STORAGE_KEY);
    if (saved === "craft" || saved === "standard" || saved === "concise") {
      return saved;
    }
    return "craft";
  });
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(
    null,
  );
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [skillsCatalog, setSkillsCatalog] = useState<SkillsCatalog | null>(
    null,
  );
  const [promptConfig, setPromptConfig] = useState<PromptConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("skills");
  const [runningPass, setRunningPass] = useState(false);
  const [passError, setPassError] = useState<string | null>(null);

  // Cmd+K prompt bar state
  const [cmdKOpen, setCmdKOpen] = useState(false);
  const [cmdKSelection, setCmdKSelection] = useState<SelectionSnapshot | null>(
    null,
  );
  const [cmdKPrompt, setCmdKPrompt] = useState("");

  const [diffState, setDiffState] = useState<DiffOverlayState>({
    hunks: [],
    focusedId: null,
    comments: [],
    focusedCommentId: null,
  });
  const [rejectedEdits, setRejectedEdits] = useState<RejectedEdit[]>([]);

  const activeFileRef = useRef<string | null>(null);
  activeFileRef.current = activeFilePath;
  const workspacePathRef = useRef<string | null>(null);
  workspacePathRef.current = workspacePath;
  const showAllFilesRef = useRef<boolean>(true);
  showAllFilesRef.current = showAllFiles;
  const mdxServerUrlRef = useRef<string | null>(null);
  mdxServerUrlRef.current = mdxServerUrl;

  const isMdxFile = Boolean(activeFilePath?.toLowerCase().endsWith(".mdx"));
  const isProseFile = !getDocumentModeInfo(activeFilePath).isCode;

  // Lazily start the local Bun MDX sidecar when an `.mdx` file is opened.
  useEffect(() => {
    if (!activeFilePath || !isMdxFile || mdxServerUrl) return;

    ensureMdxServer()
      .then((info) => {
        setMdxServerUrl(info.base_url);
      })
      .catch(() => {});
  }, [activeFilePath, isMdxFile, mdxServerUrl]);

  // Keep the sidecar's live buffer primed when opening an `.mdx` file or once the server boots.
  useEffect(() => {
    if (!mdxServerUrl || !activeFilePath || !isMdxFile) return;
    const content = editorRef.current?.getContent() ?? "";
    void pushMdxBuffer(mdxServerUrl, activeFilePath, content).then(() => {
      setIslandRev((r) => r + 1);
    });
  }, [mdxServerUrl, activeFilePath, isMdxFile]);

  const scheduleBufferSync = useCallback((text: string) => {
    const url = mdxServerUrlRef.current;
    const file = activeFileRef.current;
    if (!url || !file || !file.toLowerCase().endsWith(".mdx")) return;
    if (bufferSyncTimerRef.current) {
      window.clearTimeout(bufferSyncTimerRef.current);
    }
    bufferSyncTimerRef.current = window.setTimeout(() => {
      void pushMdxBuffer(url, file, text);
    }, 350);
  }, []);

  const mdxIslandConfig = useMemo(
    () => ({
      baseUrl: mdxServerUrl,
      filePath: isMdxFile ? activeFilePath : null,
      theme,
      enabled: inlineIslandsEnabled && isMdxFile && Boolean(mdxServerUrl),
      revision: islandRev,
      pageMetadata,
    }),
    [
      activeFilePath,
      inlineIslandsEnabled,
      isMdxFile,
      islandRev,
      mdxServerUrl,
      pageMetadata,
      theme,
    ],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
  }, [provider]);

  useEffect(() => {
    localStorage.setItem(MODEL_STORAGE_KEY, model);
  }, [model]);

  useEffect(() => {
    localStorage.setItem(EFFORT_STORAGE_KEY, effort);
  }, [effort]);

  useEffect(() => {
    localStorage.setItem(CHAT_MODE_STORAGE_KEY, chatMode);
  }, [chatMode]);

  useEffect(() => {
    localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, String(leftWidth));
  }, [leftWidth]);

  useEffect(() => {
    localStorage.setItem(RIGHT_WIDTH_STORAGE_KEY, String(rightWidth));
  }, [rightWidth]);

  const startResize = useCallback(
    (side: "left" | "right", startX: number) => {
      const startWidth = side === "left" ? leftWidth : rightWidth;
      const otherWidth =
        side === "left"
          ? showRight
            ? rightWidth
            : 0
          : showLeft
            ? leftWidth
            : 0;
      const minW = side === "left" ? MIN_LEFT_WIDTH : MIN_RIGHT_WIDTH;
      const maxHard = side === "left" ? MAX_LEFT_WIDTH : MAX_RIGHT_WIDTH;

      setResizingSide(side);

      const onMouseMove = (e: MouseEvent) => {
        const delta = side === "left" ? e.clientX - startX : startX - e.clientX;
        const maxByWindow = Math.max(
          minW,
          window.innerWidth - otherWidth - 320,
        );
        const clamped = Math.max(
          minW,
          Math.min(maxHard, maxByWindow, Math.round(startWidth + delta)),
        );
        if (side === "left") {
          setLeftWidth(clamped);
        } else {
          setRightWidth(clamped);
        }
      };

      const onMouseUp = () => {
        setResizingSide(null);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [leftWidth, rightWidth, showLeft, showRight],
  );

  const handleProviderChange = useCallback((nextProvider: ProviderKind) => {
    setProvider(nextProvider);
    setModel(defaultModelForProvider(nextProvider));
    if (!supportsXhighEffort(nextProvider)) {
      setEffort((prev) => (prev === "xhigh" ? "high" : prev));
    }
  }, []);

  const handleSelectModel = useCallback(
    (nextProvider: ProviderKind, nextModel: string) => {
      setProvider(nextProvider);
      setModel(nextModel);
      if (!supportsXhighEffort(nextProvider)) {
        setEffort((prev) => (prev === "xhigh" ? "high" : prev));
      }
    },
    [],
  );

  useEffect(() => {
    checkProviders()
      .then((status) => {
        setProviderStatus(status);
        setProvider((current) => {
          const isReady =
            (current === "claude_cli" && status.claude_cli_available) ||
            (current === "agy_cli" && status.agy_cli_available) ||
            (current === "codex_cli" && status.codex_cli_available) ||
            current === "anthropic_api";
          if (isReady) return current;
          const fallback: ProviderKind = status.claude_cli_available
            ? "claude_cli"
            : status.agy_cli_available
              ? "agy_cli"
              : status.codex_cli_available
                ? "codex_cli"
                : status.anthropic_env_key_set
                  ? "anthropic_api"
                  : current;
          if (fallback !== current) {
            setModel(defaultModelForProvider(fallback));
          }
          return fallback;
        });
      })
      .catch(() => {});
  }, []);

  const reloadSkills = useCallback((root: string | null) => {
    listSkills(root)
      .then((catalog) => setSkillsCatalog(catalog))
      .catch(() => {});
  }, []);

  useEffect(() => {
    reloadSkills(workspacePath);
    getApiKeyStatus(workspacePath)
      .then((status) => setApiKeyStatus(status))
      .catch(() => {});
  }, [reloadSkills, workspacePath]);

  // Scope saved conversation history to the open workspace so switching between files
  // keeps your active thread open while agents explore other files in the workspace.
  const threadScopeKey = workspacePath ?? activeFilePath;
  const threadScopeRef = useRef<string | null>(threadScopeKey);
  threadScopeRef.current = threadScopeKey;

  useEffect(() => {
    if (!threadScopeKey) {
      setDocThreads([]);
      setActiveThreadId(null);
      return;
    }
    let cancelled = false;
    loadDocumentThreads(threadScopeKey)
      .then((wire) => {
        if (cancelled) return;
        const loaded = wireToThreads(wire);
        setDocThreads(loaded);
        const preferred =
          wire.active_thread_id &&
          loaded.some((t) => t.id === wire.active_thread_id)
            ? wire.active_thread_id
            : loaded[0]?.id ?? null;
        setActiveThreadId(preferred);
      })
      .catch(() => {
        if (!cancelled) {
          setDocThreads([]);
          setActiveThreadId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [threadScopeKey]);

  const persistWorkspaceThreads = useCallback(
    (scopeKey: string | null, nextActiveId: string | null, nextThreads: ChatThread[]) => {
      if (!scopeKey) return;
      void saveDocumentThreads(
        threadsToWire(scopeKey, nextActiveId, nextThreads),
      ).catch(() => {});
    },
    [],
  );

  const handleSaveApiKey = useCallback(
    async (service: ApiKeyService, key: string) => {
      const updated = await saveApiKey(service, key, workspacePathRef.current);
      setApiKeyStatus(updated);
    },
    [],
  );

  const handleClearApiKey = useCallback(async (service: ApiKeyService) => {
    const updated = await clearApiKey(service, workspacePathRef.current);
    setApiKeyStatus(updated);
  }, []);

  useEffect(() => {
    getPromptConfig()
      .then((cfg) => setPromptConfig(cfg))
      .catch(() => {});
  }, []);

  const handleOpenSettings = useCallback((section: SettingsSection = "skills") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const handleSaveSkill = useCallback(async (input: SaveSkillInput) => {
    const res = await saveSkill(workspacePathRef.current, input);
    setSkillsCatalog(res.catalog);
    return res.skill;
  }, []);

  const handleDeleteSkill = useCallback(async (skill: Skill) => {
    const ok = await confirmAction(
      `Move skill "/${skill.slug}" to Trash? You can restore it from Finder Trash.`,
      "Delete Skill",
    );
    if (!ok) return;
    const catalog = await deleteSkill(workspacePathRef.current, skill.path);
    setSkillsCatalog(catalog);
  }, []);

  const handleSavePromptConfig = useCallback(async (cfg: PromptConfig) => {
    const saved = await savePromptConfig(cfg);
    setPromptConfig(saved);
  }, []);

  const handleResetPromptConfig = useCallback(async () => {
    const defaults = await resetPromptConfig();
    setPromptConfig(defaults);
  }, []);

  const handleOpenSkillsFolder = useCallback(async () => {
    const dir = skillsCatalog?.app_skills_dir;
    if (!dir) return;
    try {
      await openWithDefaultApp(dir);
    } catch (err) {
      setStatusMessage(String(err));
    }
  }, [skillsCatalog?.app_skills_dir]);

  const flashStatus = useCallback((msg: string, ms = 2500) => {
    setStatusMessage(msg);
    if (ms > 0) {
      window.setTimeout(() => {
        setStatusMessage((prev) => (prev === msg ? null : prev));
      }, ms);
    }
  }, []);

  const loadWorkspace = useCallback(
    async (path: string, includeAll = showAllFilesRef.current) => {
      try {
        const nodes = await openWorkspace(path, includeAll);
        setWorkspacePath(path);
        setTree(nodes);
        localStorage.setItem(WORKSPACE_STORAGE_KEY, path);
        setRecentWorkspaces(recordRecentWorkspace(path));
        setStatusMessage(null);
      } catch (err) {
        setStatusMessage(`Could not open folder: ${String(err)}`);
      }
    },
    [],
  );

  const handleOpenParentFolder = useCallback(async () => {
    const current = workspacePathRef.current;
    if (!current) return;
    const trimmed = current.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    const parent = idx > 0 ? trimmed.slice(0, idx) : "/";
    if (parent && parent !== current) {
      await loadWorkspace(parent);
    }
  }, [loadWorkspace]);

  const handleRefreshWorkspace = useCallback(async () => {
    const root = workspacePathRef.current;
    if (!root) return;
    try {
      const nodes = await refreshWorkspace(root, showAllFilesRef.current);
      setTree(nodes);
    } catch (err) {
      setStatusMessage(`Refresh failed: ${String(err)}`);
    }
  }, []);

  const handleToggleShowAllFiles = useCallback(async () => {
    const next = !showAllFilesRef.current;
    setShowAllFiles(next);
    const root = workspacePathRef.current;
    if (root) {
      try {
        const nodes = await refreshWorkspace(root, next);
        setTree(nodes);
      } catch (err) {
        setStatusMessage(`Filter failed: ${String(err)}`);
      }
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!saved) return;
    void loadWorkspace(saved).then(() => {
      const lastFile = localStorage.getItem(LAST_FILE_STORAGE_KEY);
      if (lastFile && lastFile.startsWith(saved)) {
        void readDocument(lastFile, saved)
          .then((doc) => {
            setActiveFilePath(doc.path);
            setOutline(doc.outline);
            setPageMetadata(doc.metadata);
            setWordCount(doc.word_count);
            setWriterGuide(doc.writer_guide);
            setWriterGuidePath(doc.writer_guide_path);
            setDirty(false);
            editorRef.current?.setDocument(doc.content, doc.path);
          })
          .catch(() => {
            localStorage.removeItem(LAST_FILE_STORAGE_KEY);
          });
      }
    });
  }, [loadWorkspace]);

  useEffect(() => {
    let unlistenFile: (() => void) | null = null;
    let unlistenTree: (() => void) | null = null;
    let refreshTimer: number | null = null;

    onWorkspaceFileChanged((event) => {
      if (activeFileRef.current && event.path === activeFileRef.current) {
        setExternalChange(true);
      }
    })
      .then((fn) => {
        unlistenFile = fn;
      })
      .catch(() => {});

    onWorkspaceTreeChanged(() => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void handleRefreshWorkspace();
      }, 200);
    })
      .then((fn) => {
        unlistenTree = fn;
      })
      .catch(() => {});

    return () => {
      unlistenFile?.();
      unlistenTree?.();
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, [handleRefreshWorkspace]);

  const handleOpenFolder = useCallback(async () => {
    try {
      const picked = await pickWorkspaceFolder();
      if (picked) {
        await loadWorkspace(picked);
      }
    } catch (err) {
      setStatusMessage(`Folder picker failed: ${String(err)}`);
    }
  }, [loadWorkspace]);

  const handleSelectFile = useCallback(
    async (path: string) => {
      try {
        const doc = await readDocument(path, workspacePathRef.current);
        setActiveFilePath(doc.path);
        localStorage.setItem(LAST_FILE_STORAGE_KEY, doc.path);
        setOutline(doc.outline);
        setPageMetadata(doc.metadata);
        setWordCount(doc.word_count);
        setWriterGuide(doc.writer_guide);
        setWriterGuidePath(doc.writer_guide_path);
        setDirty(false);
        setExternalChange(false);
        setRejectedEdits([]);
        setPassError(null);
        setActiveSelection(null);
        setStatusMessage(null);
        editorRef.current?.setDocument(doc.content, doc.path);
      } catch (err) {
        setStatusMessage(`Failed to read file: ${String(err)}`);
      }
    },
    [],
  );

  const handleCreateFile = useCallback(
    async (parentDir: string, name: string) => {
      const root = workspacePathRef.current;
      if (!root) return;
      try {
        const res = await createFile(root, parentDir, name, showAllFilesRef.current);
        setTree(res.tree);
        await handleSelectFile(res.path);
      } catch (err) {
        setStatusMessage(String(err));
      }
    },
    [handleSelectFile],
  );

  const handleCreateFolder = useCallback(
    async (parentDir: string, name: string) => {
      const root = workspacePathRef.current;
      if (!root) return;
      try {
        const res = await createFolder(
          root,
          parentDir,
          name,
          showAllFilesRef.current,
        );
        setTree(res.tree);
      } catch (err) {
        setStatusMessage(String(err));
      }
    },
    [],
  );

  const handleRenameEntry = useCallback(
    async (oldPath: string, newName: string) => {
      const root = workspacePathRef.current;
      if (!root) return;
      try {
        const res = await renameEntry(
          root,
          oldPath,
          newName,
          showAllFilesRef.current,
        );
        setTree(res.tree);
        void remapDocumentThreads(oldPath, res.path).catch(() => {});
        setActiveFilePath((curr) => remapAffectedPath(curr, oldPath, res.path));
      } catch (err) {
        setStatusMessage(String(err));
      }
    },
    [],
  );

  const handleMoveEntry = useCallback(
    async (sourcePath: string, targetDir: string) => {
      const root = workspacePathRef.current;
      if (!root) return;
      try {
        const res = await moveEntry(
          root,
          sourcePath,
          targetDir,
          showAllFilesRef.current,
        );
        setTree(res.tree);
        void remapDocumentThreads(sourcePath, res.path).catch(() => {});
        setActiveFilePath((curr) =>
          remapAffectedPath(curr, sourcePath, res.path),
        );
      } catch (err) {
        setStatusMessage(String(err));
      }
    },
    [],
  );

  const handleDuplicateFile = useCallback(
    async (path: string) => {
      const root = workspacePathRef.current;
      if (!root) return;
      try {
        const res = await duplicateFile(root, path, showAllFilesRef.current);
        setTree(res.tree);
        await handleSelectFile(res.path);
      } catch (err) {
        setStatusMessage(String(err));
      }
    },
    [handleSelectFile],
  );

  const handleTrashEntry = useCallback(
    async (node: FileNode) => {
      const root = workspacePathRef.current;
      if (!root) return;
      const confirmed = await confirmAction(
        `Move "${node.name}" to Trash? You can restore it from Finder Trash.`,
        "Move to Trash",
      );
      if (!confirmed) return;

      try {
        const nextTree = await trashEntry(root, node.path, showAllFilesRef.current);
        setTree(nextTree);
        if (
          activeFileRef.current &&
          (activeFileRef.current === node.path ||
            activeFileRef.current.startsWith(`${node.path}/`))
        ) {
          setActiveFilePath(null);
          localStorage.removeItem(LAST_FILE_STORAGE_KEY);
          setOutline([]);
          setPageMetadata(null);
          setWordCount(0);
          setDirty(false);
          editorRef.current?.setDocument("");
        }
        flashStatus(`Moved "${node.name}" to Trash`);
      } catch (err) {
        setStatusMessage(String(err));
      }
    },
    [flashStatus],
  );

  const handleCopyEntry = useCallback(
    async (sourcePath: string, targetDir: string) => {
      const root = workspacePathRef.current;
      if (!root) return;
      try {
        const res = await copyEntry(
          root,
          sourcePath,
          targetDir,
          showAllFilesRef.current,
        );
        setTree(res.tree);
        flashStatus("Pasted copy");
      } catch (err) {
        setStatusMessage(String(err));
      }
    },
    [flashStatus],
  );

  const handleOpenWithDefaultApp = useCallback(async (path: string) => {
    try {
      await openWithDefaultApp(path);
    } catch (err) {
      setStatusMessage(String(err));
    }
  }, []);

  const handleCopyPath = useCallback(
    async (path: string, relative: boolean) => {
      let text = path;
      if (relative && workspacePathRef.current) {
        const prefix = workspacePathRef.current.endsWith("/")
          ? workspacePathRef.current
          : `${workspacePathRef.current}/`;
        if (path.startsWith(prefix)) {
          text = path.slice(prefix.length);
        }
      }
      try {
        await copyTextToClipboard(text);
        flashStatus(relative ? "Copied relative path" : "Copied path", 1500);
      } catch (err) {
        setStatusMessage(`Clipboard copy failed: ${String(err)}`);
      }
    },
    [flashStatus],
  );

  const handleRevealInFinder = useCallback(async (path: string) => {
    try {
      await revealInFinder(path);
    } catch (err) {
      setStatusMessage(String(err));
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!activeFilePath || !editorRef.current) return;
    try {
      const content = editorRef.current.getContent();
      const result = await saveDocument(activeFilePath, content);
      setOutline(result.outline);
      setPageMetadata(result.metadata);
      setWordCount(result.word_count);
      setDirty(false);
      setExternalChange(false);
      flashStatus("Saved", 1500);
      if (mdxServerUrlRef.current && activeFilePath.toLowerCase().endsWith(".mdx")) {
        void pushMdxBuffer(mdxServerUrlRef.current, activeFilePath, content).then(
          () => {
            setIslandRev((r) => r + 1);
          },
        );
      }
    } catch (err) {
      setStatusMessage(`Save failed: ${String(err)}`);
    }
  }, [activeFilePath, flashStatus]);

  const handleReloadFromDisk = useCallback(async () => {
    if (activeFilePath) {
      await handleSelectFile(activeFilePath);
    }
  }, [activeFilePath, handleSelectFile]);

  const activeThreadObj = useMemo(
    () => docThreads.find((t) => t.id === activeThreadId) ?? null,
    [activeThreadId, docThreads],
  );
  const activeMessages = activeThreadObj?.messages ?? [];

  const sendChatTurn = useCallback(
    async (opts: {
      userText: string;
      passMode?: EditMode | null;
      skill?: Skill | null;
      selection?: SelectionSnapshot | null;
    }) => {
      const content = editorRef.current?.getContent() ?? "";
      const wsRoot = workspacePathRef.current;
      const targetFile = activeFileRef.current;
      const scopeKey = threadScopeRef.current;

      if (!content.trim() && !wsRoot) {
        setPassError("Open a folder or file to start chatting.");
        return;
      }
      if (opts.skill?.runner === "pangram" && !content.trim()) {
        setPassError("Open a document with text before running /pangram.");
        return;
      }

      const now = Date.now();
      const existingThreads = docThreadsRef.current;
      const currentId = activeThreadIdRef.current;
      const existingThread =
        currentId ? existingThreads.find((t) => t.id === currentId) : undefined;
      const threadId = existingThread?.id ?? `t-${now}`;
      const prevItems = existingThread?.messages ?? [];

      const selectionPreview = opts.selection
        ? opts.selection.text.length > 72
          ? `${opts.selection.text.slice(0, 69)}…`
          : opts.selection.text
        : null;

      const userItem: ChatThreadItem = {
        id: `u-${now}`,
        role: "user",
        content: opts.userText,
        mode: opts.passMode ?? null,
        skillSlug: opts.skill?.slug ?? null,
        selectionPreview,
      };

      const nextItems = [...prevItems, userItem];
      const updatedThread: ChatThread = existingThread
        ? {
            ...existingThread,
            updatedAtMs: now,
            messages: nextItems,
          }
        : {
            id: threadId,
            title: buildThreadTitle(opts.userText, opts.skill?.slug),
            createdAtMs: now,
            updatedAtMs: now,
            messages: nextItems,
          };

      const threadsAfterUser = [
        updatedThread,
        ...existingThreads.filter((t) => t.id !== threadId),
      ];
      setDocThreads(threadsAfterUser);
      setActiveThreadId(threadId);
      persistWorkspaceThreads(scopeKey, threadId, threadsAfterUser);

      setRunningPass(true);
      setPassError(null);
      setShowRight(true);

      // Respect dialogue engineering curation: exclude hidden messages and lift pinned notes.
      const historyPayload: ChatMessage[] = nextItems
        .filter((m) => !m.hidden)
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));
      const pinnedContext: string[] = prevItems
        .filter((m) => m.pinned && !m.hidden)
        .map((m) => `[${m.role === "user" ? "AUTHOR" : "EDITOR"}] ${m.content}`);

      const appendAssistantItem = (assistantItem: ChatThreadItem) => {
        const doneAt = Date.now();
        const latestList = docThreadsRef.current;
        const base =
          latestList.find((t) => t.id === threadId) ?? updatedThread;
        const nextThread: ChatThread = {
          ...base,
          updatedAtMs: doneAt,
          messages: [...base.messages, assistantItem],
        };
        const nextList = [
          nextThread,
          ...latestList.filter((t) => t.id !== threadId),
        ];
        if (threadScopeRef.current === scopeKey) {
          setDocThreads(nextList);
        }
        persistWorkspaceThreads(scopeKey, threadId, nextList);
      };

      try {
        if (opts.skill?.runner === "pangram") {
          const pg = await runPangramCheck({
            content,
            selection_utf16: opts.selection
              ? [opts.selection.from, opts.selection.to]
              : null,
            workspace_root: wsRoot,
          });

          if (activeFileRef.current === targetFile) {
            editorRef.current?.setPassResults([], pg.comments);
          }
          setRejectedEdits([]);

          const secs = (pg.duration_ms / 1000).toFixed(1);
          appendAssistantItem({
            id: `a-${Date.now()}`,
            role: "assistant",
            content: pg.reply,
            commentCount: pg.flagged_windows,
            meta: `${pg.version} · ${secs}s`,
          });
          return;
        }

        const res = await runChatTurn({
          content,
          messages: historyPayload,
          mode: opts.passMode ?? null,
          chat_mode: chatMode,
          pinned_context: pinnedContext,
          skill: opts.skill
            ? {
                slug: opts.skill.slug,
                name: opts.skill.name,
                instructions: opts.skill.instructions,
                allow_edits: opts.skill.allow_edits,
              }
            : null,
          selection_utf16: opts.selection
            ? [opts.selection.from, opts.selection.to]
            : null,
          workspace_root: wsRoot,
          active_file_path: targetFile,
          writer_guide: writerGuide,
          provider,
          model,
          effort,
          api_key: null,
        });

        // Only apply inline diff/comment overlays if the user is still viewing the same file.
        if (
          activeFileRef.current === targetFile &&
          (res.hunks.length > 0 || res.comments.length > 0)
        ) {
          editorRef.current?.setPassResults(res.hunks, res.comments);
        }
        setRejectedEdits(res.rejected);

        const secs = (res.duration_ms / 1000).toFixed(1);
        appendAssistantItem({
          id: `a-${Date.now()}`,
          role: "assistant",
          content:
            res.reply ||
            (res.hunks.length === 0 && res.comments.length === 0
              ? "Looks clean — no edits needed."
              : "Proposed targeted edits inline."),
          editCount: res.hunks.length,
          commentCount: res.comments.length,
          meta: `${res.model_used} · ${secs}s`,
        });
      } catch (err) {
        setPassError(String(err));
      } finally {
        setRunningPass(false);
      }
    },
    [chatMode, effort, model, persistWorkspaceThreads, provider, writerGuide],
  );

  const handleSendChatMessage = useCallback(
    (text: string, useSelection: boolean, skill?: Skill | null) => {
      void sendChatTurn({
        userText: text,
        passMode: null,
        skill: skill ?? null,
        selection: useSelection ? activeSelection : null,
      });
    },
    [activeSelection, sendChatTurn],
  );

  const handleNewThread = useCallback(() => {
    setActiveThreadId(null);
    setPassError(null);
    setRejectedEdits([]);
    editorRef.current?.setPassResults([], []);
    persistWorkspaceThreads(threadScopeRef.current, null, docThreadsRef.current);
  }, [persistWorkspaceThreads]);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      setActiveThreadId(threadId);
      setPassError(null);
      setRejectedEdits([]);
      editorRef.current?.setPassResults([], []);
      persistWorkspaceThreads(
        threadScopeRef.current,
        threadId,
        docThreadsRef.current,
      );
    },
    [persistWorkspaceThreads],
  );

  const handleDeleteThread = useCallback(
    (threadId: string) => {
      const remaining = docThreadsRef.current.filter((t) => t.id !== threadId);
      const nextActive =
        activeThreadIdRef.current === threadId
          ? remaining[0]?.id ?? null
          : activeThreadIdRef.current;
      setDocThreads(remaining);
      setActiveThreadId(nextActive);
      persistWorkspaceThreads(threadScopeRef.current, nextActive, remaining);
    },
    [persistWorkspaceThreads],
  );

  const mutateActiveThreadMessages = useCallback(
    (updater: (msg: ChatThreadItem) => ChatThreadItem) => {
      const currentId = activeThreadIdRef.current;
      if (!currentId) return;
      const nextThreads = docThreadsRef.current.map((t) =>
        t.id === currentId
          ? {
              ...t,
              updatedAtMs: Date.now(),
              messages: t.messages.map(updater),
            }
          : t,
      );
      setDocThreads(nextThreads);
      persistWorkspaceThreads(threadScopeRef.current, currentId, nextThreads);
    },
    [persistWorkspaceThreads],
  );

  const handleTogglePinMessage = useCallback(
    (messageId: string) => {
      mutateActiveThreadMessages((m) =>
        m.id === messageId ? { ...m, pinned: !m.pinned } : m,
      );
    },
    [mutateActiveThreadMessages],
  );

  const handleToggleHideMessage = useCallback(
    (messageId: string) => {
      mutateActiveThreadMessages((m) =>
        m.id === messageId ? { ...m, hidden: !m.hidden } : m,
      );
    },
    [mutateActiveThreadMessages],
  );

  const handleEditMessage = useCallback(
    (messageId: string, nextContent: string) => {
      mutateActiveThreadMessages((m) =>
        m.id === messageId ? { ...m, content: nextContent } : m,
      );
    },
    [mutateActiveThreadMessages],
  );

  const handleOpenCmdK = useCallback(() => {
    const sel = editorRef.current?.getSelection() ?? null;
    setCmdKSelection(sel);
    setCmdKPrompt("");
    setCmdKOpen(true);
    window.setTimeout(() => cmdKInputRef.current?.focus(), 0);
  }, []);

  const handleSubmitCmdK = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!cmdKPrompt.trim() || runningPass) return;
      const instruction = cmdKPrompt.trim();
      setCmdKOpen(false);
      await sendChatTurn({
        userText: instruction,
        passMode: "custom",
        selection: cmdKSelection,
      });
    },
    [cmdKPrompt, cmdKSelection, runningPass, sendChatTurn],
  );

  const handleTurnCommentIntoEdit = useCallback(
    (comment: ActiveComment) => {
      const isAiFlag =
        comment.kind === "ai_generated" || comment.kind === "ai_assisted";
      const userText = isAiFlag
        ? "Rewrite this Pangram-flagged passage so it reads naturally in my own voice (no AI clichés, preserve exact technical meaning and keep untouched text verbatim)."
        : `Address this margin note with a minimal, surgical edit: ${comment.body}`;
      void sendChatTurn({
        userText,
        passMode: "custom",
        selection: {
          from: comment.from,
          to: comment.to,
          text: comment.anchor,
        },
      });
    },
    [sendChatTurn],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      } else if (e.key === "Escape" && settingsOpen) {
        e.preventDefault();
        setSettingsOpen(false);
      } else if (e.metaKey && e.key === "\\") {
        e.preventDefault();
        setShowLeft((v) => !v);
      } else if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setShowRight((v) => !v);
      } else if (e.metaKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        handleOpenCmdK();
      } else if (e.metaKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void handleOpenFolder();
      } else if (e.metaKey && e.key.toLowerCase() === "n") {
        if (workspacePathRef.current) {
          e.preventDefault();
          setShowLeft(true);
          setCreateFileTrigger((n) => n + 1);
        }
      } else if (e.key === "Escape" && cmdKOpen) {
        setCmdKOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cmdKOpen, handleOpenCmdK, handleOpenFolder, settingsOpen]);

  const fileName = activeFilePath
    ? activeFilePath.split("/").slice(-2).join("/")
    : "Writer";

  const docMode = getDocumentModeInfo(activeFilePath);

  const focusedHunkIndex = diffState.hunks.findIndex(
    (h) => h.id === diffState.focusedId,
  );
  const focusedHunk =
    focusedHunkIndex >= 0 ? diffState.hunks[focusedHunkIndex] : null;

  return (
    <div
      className={`app-shell ${resizingSide ? "is-resizing" : ""}`}
      style={
        {
          "--left-sidebar-width": `${leftWidth}px`,
          "--right-drawer-width": `${rightWidth}px`,
        } as React.CSSProperties
      }
    >
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar-left" data-tauri-drag-region>
          <button
            type="button"
            className={`icon-btn ${showLeft ? "is-on" : ""}`}
            onClick={() => setShowLeft((v) => !v)}
            title="Toggle Sidebar (⌘\)"
          >
            <PanelLeft size={16} />
          </button>
          <span className="file-title" data-tauri-drag-region>
            {fileName}
            {activeFilePath && (
              <span className="lang-badge">{docMode.label}</span>
            )}
            {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          </span>
        </div>

        <div className="topbar-spacer" data-tauri-drag-region />

        <div className="topbar-right">
          {statusMessage && (
            <span className="status-text">{statusMessage}</span>
          )}
          <span className="word-count">
            {wordCount > 0 ? `${wordCount.toLocaleString()} words` : ""}
          </span>

          {activeFilePath && isProseFile && (
            <div className="view-mode-group" role="group" aria-label="Editor view">
              <button
                type="button"
                className={`view-mode-btn ${sourceMode ? "is-on" : ""}`}
                onClick={() => setSourceMode((v) => !v)}
                title={
                  sourceMode
                    ? "Raw Markdown/MDX source ON (click for Live Preview)"
                    : "Switch to raw Markdown/MDX source"
                }
              >
                <Code2 size={13} />
              </button>
              {isMdxFile && !sourceMode && (
                <button
                  type="button"
                  className={`view-mode-btn ${inlineIslandsEnabled ? "is-on" : ""}`}
                  onClick={() => setInlineIslandsEnabled((v) => !v)}
                  title={
                    inlineIslandsEnabled
                      ? "Live inline MDX components ON (click for compact pills)"
                      : "Live inline MDX components OFF (click to render live inline)"
                  }
                >
                  <Hexagon size={13} />
                </button>
              )}
            </div>
          )}

          {activeFilePath && (
            <button
              type="button"
              className="icon-btn"
              onClick={handleSave}
              disabled={!dirty}
              title="Save (⌘S)"
            >
              <Save size={15} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            title="Toggle light/dark paper"
          >
            {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
          </button>
          {(updates.state.status === "available" || updates.state.status === "installed") && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => handleOpenSettings("editor")}
              title={updates.state.status === "available" ? "Writer update available" : "Restart to finish updating"}
              aria-label="Software updates"
            >
              <Download size={15} />
            </button>
          )}
          <button
            type="button"
            className={`icon-btn ${settingsOpen ? "is-on" : ""}`}
            onClick={() => setSettingsOpen((v) => !v)}
            title="Settings (⌘,)"
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            className={`icon-btn ${showRight ? "is-on" : ""}`}
            onClick={() => setShowRight((v) => !v)}
            title="Toggle Review Drawer (⌘⇧L)"
          >
            <PanelRight size={16} />
          </button>
        </div>
      </header>

      {externalChange && (
        <div className="external-banner">
          <span>This file was modified on disk outside Writer.</span>
          <button
            type="button"
            className="small-btn"
            onClick={handleReloadFromDisk}
          >
            <RefreshCw size={12} /> Reload from disk
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => setExternalChange(false)}
          >
            Keep my buffer
          </button>
        </div>
      )}

      {settingsOpen && (
        <SettingsPage
          initialSection={settingsSection}
          skillsCatalog={skillsCatalog}
          promptConfig={promptConfig}
          apiKeyStatus={apiKeyStatus}
          workspacePath={workspacePath}
          writerGuidePath={writerGuidePath}
          writerGuide={writerGuide}
          provider={provider}
          onProviderChange={handleProviderChange}
          model={model}
          onSelectModel={handleSelectModel}
          effort={effort}
          onEffortChange={setEffort}
          providerStatus={providerStatus}
          theme={theme}
          onThemeChange={setTheme}
          showAllFiles={showAllFiles}
          onToggleShowAllFiles={() => void handleToggleShowAllFiles()}
          inlineIslandsEnabled={inlineIslandsEnabled}
          onToggleInlineIslands={() => setInlineIslandsEnabled((v) => !v)}
          onSaveSkill={handleSaveSkill}
          onDeleteSkill={handleDeleteSkill}
          onReloadSkills={() => {
            reloadSkills(workspacePathRef.current);
            flashStatus("Reloaded skills", 1500);
          }}
          onOpenSkillsFolder={() => void handleOpenSkillsFolder()}
          onRevealPath={(p) => void handleRevealInFinder(p)}
          onSavePromptConfig={handleSavePromptConfig}
          onResetPromptConfig={handleResetPromptConfig}
          onSaveApiKey={handleSaveApiKey}
          onClearApiKey={handleClearApiKey}
          onOpenFileInEditor={(p) => void handleSelectFile(p)}
          softwareUpdates={updates.enabled ? <WriterUpdates updates={updates} dirty={dirty} /> : null}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <div
        className="workspace-body"
        style={{ display: settingsOpen ? "none" : undefined }}
      >
        {showLeft && (
          <Sidebar
            workspacePath={workspacePath}
            recentWorkspaces={recentWorkspaces}
            tree={tree}
            activeFilePath={activeFilePath}
            outline={outline}
            showAllFiles={showAllFiles}
            externalCreateTrigger={createFileTrigger}
            onToggleShowAllFiles={() => void handleToggleShowAllFiles()}
            onOpenFolder={() => void handleOpenFolder()}
            onOpenParentFolder={() => void handleOpenParentFolder()}
            onOpenRecentFolder={(p) => void loadWorkspace(p)}
            onRefreshWorkspace={() => void handleRefreshWorkspace()}
            onSelectFile={(p) => void handleSelectFile(p)}
            onSelectHeading={(offset) =>
              editorRef.current?.jumpToOffset(offset)
            }
            onCreateFile={handleCreateFile}
            onCreateFolder={handleCreateFolder}
            onRenameEntry={handleRenameEntry}
            onMoveEntry={handleMoveEntry}
            onCopyEntry={handleCopyEntry}
            onDuplicateFile={handleDuplicateFile}
            onTrashEntry={handleTrashEntry}
            onRevealInFinder={handleRevealInFinder}
            onOpenWithDefaultApp={handleOpenWithDefaultApp}
            onCopyPath={handleCopyPath}
          />
        )}

        {showLeft && (
          <div
            className={`panel-resizer ${resizingSide === "left" ? "is-active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Drag to resize · Double-click to reset"
            onMouseDown={(e) => {
              e.preventDefault();
              startResize("left", e.clientX);
            }}
            onDoubleClick={() => setLeftWidth(DEFAULT_LEFT_WIDTH)}
          />
        )}

        <main className="center-stage">
          <div className="editor-pane">
            {cmdKOpen && (
              <form className="cmdk-bar" onSubmit={handleSubmitCmdK}>
                <div className="cmdk-scope">
                  <span className="cmdk-badge">⌘K</span>
                  <span>
                    {cmdKSelection
                      ? `Scoped to selection (${cmdKSelection.text.trim().split(/\s+/).length} words)`
                      : "Whole document"}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setCmdKOpen(false)}
                    title="Close (Esc)"
                  >
                    <X size={14} />
                  </button>
                </div>
                {cmdKSelection && (
                  <p className="cmdk-preview">
                    “
                    {cmdKSelection.text.length > 140
                      ? `${cmdKSelection.text.slice(0, 137)}…`
                      : cmdKSelection.text}
                    ”
                  </p>
                )}
                <div className="cmdk-input-row">
                  <input
                    ref={cmdKInputRef}
                    type="text"
                    className="cmdk-input"
                    placeholder="Describe a targeted edit… (e.g. tighten this analogy, cut 15 words)"
                    value={cmdKPrompt}
                    onChange={(e) => setCmdKPrompt(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="primary-btn cmdk-submit"
                    disabled={runningPass || !cmdKPrompt.trim()}
                  >
                    {runningPass ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      "Edit ↵"
                    )}
                  </button>
                </div>
              </form>
            )}

            {!activeFilePath && (
              <div className="editor-empty-state">
                <p className="editor-empty-title">No file open</p>
                <p className="editor-empty-sub">
                  {workspacePath
                    ? "Select a file from the sidebar or create a new one."
                    : "Open a writing folder to get started."}
                </p>
                <div className="editor-empty-actions">
                  {workspacePath ? (
                    <button
                      type="button"
                      className="small-btn"
                      onClick={() => {
                        setShowLeft(true);
                        setCreateFileTrigger((n) => n + 1);
                      }}
                    >
                      <FilePlus size={13} /> New File (⌘N)
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="small-btn"
                    onClick={() => void handleOpenFolder()}
                  >
                    <FolderOpen size={13} /> Open Folder (⌘O)
                  </button>
                </div>
              </div>
            )}

            <div
              className="editor-canvas-shell"
              style={{ display: activeFilePath ? "flex" : "none" }}
            >
              <EditorCanvas
                ref={editorRef}
                initialContent=""
                filePath={activeFilePath}
                forceSourceMode={isProseFile && sourceMode}
                mdxIslandConfig={mdxIslandConfig}
                onChange={(text) => {
                  setDirty(true);
                  setWordCount(
                    text.trim() ? text.trim().split(/\s+/).length : 0,
                  );
                  scheduleBufferSync(text);
                }}
                onSelectionChange={setActiveSelection}
                onDiffStateChange={setDiffState}
                onSaveShortcut={handleSave}
                onCmdKShortcut={handleOpenCmdK}
              />
            </div>

            {focusedHunk && (
              <div
                className="hunk-dock"
                role="region"
                aria-label="Focused edit"
              >
                <div className="hunk-dock-meta">
                  <span
                    className={`cm-hunk-badge cm-hunk-badge-${focusedHunk.kind}`}
                  >
                    {focusedHunk.kind}
                  </span>
                  <span className="hunk-dock-counter">
                    {focusedHunkIndex + 1} / {diffState.hunks.length}
                  </span>
                  <span
                    className="hunk-dock-rationale"
                    title={focusedHunk.rationale}
                  >
                    {focusedHunk.rationale}
                  </span>
                </div>

                <div className="hunk-dock-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => editorRef.current?.stepHunk(-1)}
                    title="Previous edit (⌘[)"
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => editorRef.current?.stepHunk(1)}
                    title="Next edit (⌘])"
                  >
                    <ChevronRight size={15} />
                  </button>
                  <button
                    type="button"
                    className="cm-hunk-btn cm-hunk-btn-accept"
                    onClick={() =>
                      editorRef.current?.acceptHunk(focusedHunk.id)
                    }
                  >
                    <Check size={13} /> Accept ⌘↵
                  </button>
                  <button
                    type="button"
                    className="cm-hunk-btn cm-hunk-btn-reject"
                    onClick={() =>
                      editorRef.current?.rejectHunk(focusedHunk.id)
                    }
                  >
                    <X size={13} /> Reject ⌘⌫
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>

        {showRight && (
          <div
            className={`panel-resizer ${resizingSide === "right" ? "is-active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize editor panel"
            title="Drag to resize · Double-click to reset"
            onMouseDown={(e) => {
              e.preventDefault();
              startResize("right", e.clientX);
            }}
            onDoubleClick={() => setRightWidth(DEFAULT_RIGHT_WIDTH)}
          />
        )}

        {showRight && (
          <ReviewDrawer
            messages={activeMessages}
            threads={docThreads}
            activeThreadId={activeThreadId}
            skills={skillsCatalog?.skills ?? []}
            chatMode={chatMode}
            onChatModeChange={setChatMode}
            provider={provider}
            model={model}
            onSelectModel={handleSelectModel}
            effort={effort}
            onEffortChange={setEffort}
            providerStatus={providerStatus}
            running={runningPass}
            error={passError}
            hunks={diffState.hunks}
            focusedId={diffState.focusedId}
            comments={diffState.comments}
            focusedCommentId={diffState.focusedCommentId}
            rejected={rejectedEdits}
            writerGuidePath={writerGuidePath}
            activeSelection={activeSelection}
            onSendMessage={handleSendChatMessage}
            onOpenSettings={() => handleOpenSettings("skills")}
            onNewThread={handleNewThread}
            onSelectThread={handleSelectThread}
            onDeleteThread={handleDeleteThread}
            onTogglePinMessage={handleTogglePinMessage}
            onToggleHideMessage={handleToggleHideMessage}
            onEditMessage={handleEditMessage}
            onFocusHunk={(id) => editorRef.current?.focusHunk(id)}
            onAcceptHunk={(id) => editorRef.current?.acceptHunk(id)}
            onRejectHunk={(id) => editorRef.current?.rejectHunk(id)}
            onAcceptKind={(kind) => editorRef.current?.acceptHunksByKind(kind)}
            onAcceptAll={() => editorRef.current?.acceptAllHunks()}
            onRejectAll={() => editorRef.current?.rejectAllHunks()}
            onFocusComment={(id) => editorRef.current?.focusComment(id)}
            onDismissComment={(id) => editorRef.current?.dismissComment(id)}
            onTurnCommentIntoEdit={handleTurnCommentIntoEdit}
          />
        )}
      </div>
    </div>
  );
}
