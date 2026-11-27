import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FilePlus,
  FileText,
  Filter,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { FileNode, HeadingItem } from "../types";

export interface InlineCreateRequest {
  kind: "file" | "folder";
  parentDir: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode | null;
}

interface ClipboardItem {
  mode: "cut" | "copy";
  path: string;
  name: string;
}

interface SidebarProps {
  workspacePath: string | null;
  recentWorkspaces: string[];
  tree: FileNode[];
  activeFilePath: string | null;
  outline: HeadingItem[];
  showAllFiles: boolean;
  externalCreateTrigger: number;
  onToggleShowAllFiles: () => void;
  onOpenFolder: () => void;
  onOpenParentFolder: () => void;
  onOpenRecentFolder: (path: string) => void;
  onRefreshWorkspace: () => void;
  onSelectFile: (path: string) => void;
  onSelectHeading: (utf16Offset: number) => void;
  onCreateFile: (parentDir: string, name: string) => Promise<void>;
  onCreateFolder: (parentDir: string, name: string) => Promise<void>;
  onRenameEntry: (oldPath: string, newName: string) => Promise<void>;
  onMoveEntry: (sourcePath: string, targetDir: string) => Promise<void>;
  onCopyEntry: (sourcePath: string, targetDir: string) => Promise<void>;
  onDuplicateFile: (path: string) => Promise<void>;
  onTrashEntry: (node: FileNode) => Promise<void>;
  onRevealInFinder: (path: string) => Promise<void>;
  onOpenWithDefaultApp: (path: string) => Promise<void>;
  onCopyPath: (path: string, relative: boolean) => Promise<void>;
}

function parentDirectoryOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.is_dir) {
      const matchedChildren = filterTree(node.children, q);
      if (node.name.toLowerCase().includes(q) || matchedChildren.length > 0) {
        result.push({ ...node, children: matchedChildren });
      }
    } else if (node.name.toLowerCase().includes(q)) {
      result.push(node);
    }
  }
  return result;
}

function collectDefaultExpanded(nodes: FileNode[], depth = 0): Set<string> {
  const set = new Set<string>();
  if (depth >= 1) return set;
  for (const n of nodes) {
    if (n.is_dir) {
      set.add(n.path);
      for (const sub of collectDefaultExpanded(n.children, depth + 1)) {
        set.add(sub);
      }
    }
  }
  return set;
}

function InlineNameInput({
  initialValue,
  placeholder,
  isFile,
  depth,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  placeholder: string;
  isFile: boolean;
  depth: number;
  onCommit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select filename stem (before extension) when renaming, just like VS Code & Finder.
    if (initialValue) {
      const dot = isFile ? initialValue.lastIndexOf(".") : -1;
      el.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
    }
  }, [initialValue, isFile]);

  const finish = async (shouldSave: boolean) => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (shouldSave && trimmed && trimmed !== initialValue) {
      await onCommit(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <div
      className="tree-inline-row"
      style={{ paddingLeft: `${12 + depth * 12}px` }}
    >
      {isFile ? (
        <FileText size={13} className="tree-icon" />
      ) : (
        <Folder size={13} className="tree-icon" />
      )}
      <input
        ref={inputRef}
        type="text"
        className="tree-inline-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            void finish(false);
          }
        }}
        onBlur={() => {
          void finish(true);
        }}
      />
    </div>
  );
}

export function Sidebar({
  workspacePath,
  recentWorkspaces,
  tree,
  activeFilePath,
  outline,
  showAllFiles,
  externalCreateTrigger,
  onToggleShowAllFiles,
  onOpenFolder,
  onOpenParentFolder,
  onOpenRecentFolder,
  onRefreshWorkspace,
  onSelectFile,
  onSelectHeading,
  onCreateFile,
  onCreateFolder,
  onRenameEntry,
  onMoveEntry,
  onCopyEntry,
  onDuplicateFile,
  onTrashEntry,
  onRevealInFinder,
  onOpenWithDefaultApp,
  onCopyPath,
}: SidebarProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() =>
    collectDefaultExpanded(tree),
  );
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [creating, setCreating] = useState<InlineCreateRequest | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null);
  const [dragSourcePath, setDragSourcePath] = useState<string | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);

  // Reset default expanded folders when switching workspaces.
  const prevWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (workspacePath !== prevWorkspaceRef.current) {
      prevWorkspaceRef.current = workspacePath;
      setExpandedDirs(collectDefaultExpanded(tree));
      setSelectedDir(workspacePath);
      setCreating(null);
      setRenamingPath(null);
      setSearchQuery("");
    }
  }, [workspacePath, tree]);

  // Respond to Cmd+N shortcut from App.
  const prevTriggerRef = useRef(externalCreateTrigger);
  useEffect(() => {
    if (externalCreateTrigger !== prevTriggerRef.current) {
      prevTriggerRef.current = externalCreateTrigger;
      if (workspacePath) {
        const target = selectedDir ?? workspacePath;
        setExpandedDirs((prev) => new Set(prev).add(target));
        setCreating({ kind: "file", parentDir: target });
      }
    }
  }, [externalCreateTrigger, selectedDir, workspacePath]);

  // Dismiss context menu on click-away or Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const visibleTree = useMemo(
    () => filterTree(tree, searchQuery),
    [tree, searchQuery],
  );
  const isFiltering = searchQuery.trim().length > 0;

  const targetCreateDir = selectedDir ?? workspacePath;

  const startCreate = (kind: "file" | "folder", dir?: string) => {
    const parentDir = dir ?? targetCreateDir;
    if (!parentDir) return;
    setRenamingPath(null);
    setExpandedDirs((prev) => new Set(prev).add(parentDir));
    setCreating({ kind, parentDir });
  };

  const toggleDir = (dirPath: string) => {
    setSelectedDir(dirPath);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const openContextMenu = (e: React.MouseEvent, node: FileNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 212;
    const menuHeight = 330;
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - menuHeight - 8));
    setContextMenu({ x, y, node });
  };

  const handlePasteInto = async (targetDir: string) => {
    if (!clipboard) return;
    const item = clipboard;
    if (item.mode === "cut") {
      setClipboard(null);
      await onMoveEntry(item.path, targetDir);
    } else {
      await onCopyEntry(item.path, targetDir);
    }
  };

  const handleDropOnDir = async (e: React.DragEvent, targetDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    const src = dragSourcePath ?? e.dataTransfer.getData("text/plain");
    setDragSourcePath(null);
    setDropTargetDir(null);
    if (!src || src === targetDir || parentDirectoryOf(src) === targetDir) {
      return;
    }
    await onMoveEntry(src, targetDir);
  };

  const renderNodes = (nodes: FileNode[], depth: number) =>
    nodes.map((node) => {
      if (renamingPath === node.path) {
        return (
          <InlineNameInput
            key={`rename-${node.path}`}
            initialValue={node.name}
            placeholder="New name"
            isFile={!node.is_dir}
            depth={depth}
            onCommit={async (newName) => {
              setRenamingPath(null);
              await onRenameEntry(node.path, newName);
            }}
            onCancel={() => setRenamingPath(null)}
          />
        );
      }

      if (node.is_dir) {
        const isExpanded = isFiltering || expandedDirs.has(node.path);
        const isSelected = selectedDir === node.path;
        const isDropTarget = dropTargetDir === node.path;
        const isCut =
          clipboard?.mode === "cut" && clipboard.path === node.path;

        return (
          <div key={node.path}>
            <div
              className={`tree-row tree-dir ${isSelected ? "is-selected-dir" : ""} ${isDropTarget ? "is-drop-target" : ""} ${isCut ? "is-cut" : ""}`}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              draggable
              onDragStart={(e) => {
                setDragSourcePath(node.path);
                e.dataTransfer.setData("text/plain", node.path);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragSourcePath(null);
                setDropTargetDir(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragSourcePath !== node.path) {
                  setDropTargetDir(node.path);
                }
              }}
              onDragLeave={() => {
                if (dropTargetDir === node.path) setDropTargetDir(null);
              }}
              onDrop={(e) => void handleDropOnDir(e, node.path)}
              onClick={() => toggleDir(node.path)}
              onContextMenu={(e) => openContextMenu(e, node)}
              title={node.path}
            >
              {isExpanded ? (
                <ChevronDown size={13} className="tree-chevron" />
              ) : (
                <ChevronRight size={13} className="tree-chevron" />
              )}
              <span className="tree-label">{node.name}</span>
              <div
                className="tree-row-actions"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="row-action-btn"
                  title="New File in folder"
                  onClick={() => startCreate("file", node.path)}
                >
                  <FilePlus size={12} />
                </button>
                <button
                  type="button"
                  className="row-action-btn"
                  title="New Folder"
                  onClick={() => startCreate("folder", node.path)}
                >
                  <FolderPlus size={12} />
                </button>
                <button
                  type="button"
                  className="row-action-btn"
                  title="Rename"
                  onClick={() => setRenamingPath(node.path)}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="row-action-btn row-action-danger"
                  title="Move to Trash"
                  onClick={() => void onTrashEntry(node)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            {isExpanded && (
              <div>
                {creating && creating.parentDir === node.path && (
                  <InlineNameInput
                    initialValue=""
                    placeholder={
                      creating.kind === "file" ? "note.md" : "folder-name"
                    }
                    isFile={creating.kind === "file"}
                    depth={depth + 1}
                    onCommit={async (name) => {
                      const req = creating;
                      setCreating(null);
                      if (req.kind === "file") {
                        await onCreateFile(req.parentDir, name);
                      } else {
                        await onCreateFolder(req.parentDir, name);
                      }
                    }}
                    onCancel={() => setCreating(null)}
                  />
                )}
                {renderNodes(node.children, depth + 1)}
              </div>
            )}
          </div>
        );
      }

      const isActive = node.path === activeFilePath;
      const isCut = clipboard?.mode === "cut" && clipboard.path === node.path;
      return (
        <div
          key={node.path}
          className={`tree-row tree-file ${isActive ? "is-active" : ""} ${isCut ? "is-cut" : ""}`}
          style={{ paddingLeft: `${20 + depth * 12}px` }}
          draggable
          onDragStart={(e) => {
            setDragSourcePath(node.path);
            e.dataTransfer.setData("text/plain", node.path);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            setDragSourcePath(null);
            setDropTargetDir(null);
          }}
          onClick={() => {
            setSelectedDir(parentDirectoryOf(node.path));
            onSelectFile(node.path);
          }}
          onContextMenu={(e) => openContextMenu(e, node)}
          title={node.path}
        >
          <FileText size={13} className="tree-icon" />
          <span className="tree-label">{node.name}</span>
          <div
            className="tree-row-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="row-action-btn"
              title="Rename"
              onClick={() => setRenamingPath(node.path)}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className="row-action-btn row-action-danger"
              title="Move to Trash"
              onClick={() => void onTrashEntry(node)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      );
    });

  const folderName = workspacePath
    ? workspacePath.split("/").filter(Boolean).pop() ?? workspacePath
    : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title" title={workspacePath ?? undefined}>
          {folderName ?? "Workspace"}
        </span>
        <div className="sidebar-toolbar">
          {workspacePath && (
            <>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                onClick={() => startCreate("file")}
                title="New File (⌘N)"
              >
                <FilePlus size={14} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                onClick={() => startCreate("folder")}
                title="New Folder"
              >
                <FolderPlus size={14} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                onClick={() => setExpandedDirs(new Set())}
                title="Collapse All Folders"
              >
                <ChevronsDownUp size={14} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                onClick={onOpenParentFolder}
                title="Open Parent Folder"
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className={`icon-btn icon-btn-sm ${!showAllFiles ? "is-on" : ""}`}
                onClick={onToggleShowAllFiles}
                title={
                  !showAllFiles
                    ? "Markdown/MDX filter ON (click to show all files)"
                    : "Showing all files (click to filter to Markdown/MDX only)"
                }
              >
                <Filter size={13} />
              </button>
            </>
          )}
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={onOpenFolder}
            title="Open Folder… (⌘O)"
          >
            <FolderOpen size={14} />
          </button>
        </div>
      </div>

      {workspacePath && (
        <div className="sidebar-search">
          <Search size={12} className="sidebar-search-icon" />
          <input
            type="text"
            className="sidebar-search-input"
            placeholder="Filter files…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="sidebar-search-clear"
              onClick={() => setSearchQuery("")}
              title="Clear filter"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}

      <div
        className={`sidebar-section sidebar-tree ${workspacePath && dropTargetDir === workspacePath ? "is-drop-target" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget && workspacePath) {
            setSelectedDir(workspacePath);
          }
        }}
        onContextMenu={(e) => {
          if (workspacePath) openContextMenu(e, null);
        }}
        onDragOver={(e) => {
          if (!workspacePath) return;
          e.preventDefault();
          setDropTargetDir(workspacePath);
        }}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget && dropTargetDir === workspacePath) {
            setDropTargetDir(null);
          }
        }}
        onDrop={(e) => {
          if (workspacePath) void handleDropOnDir(e, workspacePath);
        }}
      >
        {!workspacePath ? (
          <div className="sidebar-empty">
            <p>No folder opened yet.</p>
            <button
              type="button"
              className="secondary-btn"
              onClick={onOpenFolder}
            >
              <FolderOpen size={14} /> Open Folder…
            </button>
            {recentWorkspaces.length > 0 && (
              <div className="recent-folders">
                <div className="section-heading">Recent</div>
                {recentWorkspaces.map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    className="recent-folder-item"
                    onClick={() => onOpenRecentFolder(dir)}
                    title={dir}
                  >
                    <Folder size={12} className="tree-icon" />
                    <span className="tree-label">
                      {dir.split("/").filter(Boolean).pop() ?? dir}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {creating && creating.parentDir === workspacePath && (
              <InlineNameInput
                initialValue=""
                placeholder={
                  creating.kind === "file" ? "note.md" : "folder-name"
                }
                isFile={creating.kind === "file"}
                depth={0}
                onCommit={async (name) => {
                  const req = creating;
                  setCreating(null);
                  if (req.kind === "file") {
                    await onCreateFile(req.parentDir, name);
                  } else {
                    await onCreateFolder(req.parentDir, name);
                  }
                }}
                onCancel={() => setCreating(null)}
              />
            )}

            {visibleTree.length === 0 && !creating ? (
              <div className="sidebar-empty">
                <p>
                  {isFiltering
                    ? "No matching files."
                    : !showAllFiles
                      ? "No Markdown files in this folder."
                      : "This folder is empty."}
                </p>
                {!isFiltering && (
                  <div className="empty-actions">
                    {!showAllFiles && (
                      <button
                        type="button"
                        className="small-btn"
                        onClick={onToggleShowAllFiles}
                      >
                        Show all files
                      </button>
                    )}
                    <button
                      type="button"
                      className="small-btn"
                      onClick={() => startCreate("file", workspacePath)}
                    >
                      <FilePlus size={12} /> New File
                    </button>
                    <button
                      type="button"
                      className="small-btn"
                      onClick={() => startCreate("folder", workspacePath)}
                    >
                      <FolderPlus size={12} /> New Folder
                    </button>
                  </div>
                )}
              </div>
            ) : (
              renderNodes(visibleTree, 0)
            )}
          </>
        )}
      </div>

      {outline.length > 0 && (
        <div className="sidebar-section sidebar-outline">
          <div className="section-heading">Outline</div>
          <div className="outline-list">
            {outline.map((item) => (
              <button
                key={`${item.line}-${item.text}`}
                type="button"
                className="outline-item"
                style={{ paddingLeft: `${8 + (item.level - 1) * 10}px` }}
                onClick={() => onSelectHeading(item.utf16_offset)}
              >
                {item.text}
              </button>
            ))}
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(!contextMenu.node || contextMenu.node.is_dir) && workspacePath && (
            <>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const dir = contextMenu.node?.path ?? workspacePath;
                  setContextMenu(null);
                  startCreate("file", dir);
                }}
              >
                <FilePlus size={13} /> New File…
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const dir = contextMenu.node?.path ?? workspacePath;
                  setContextMenu(null);
                  startCreate("folder", dir);
                }}
              >
                <FolderPlus size={13} /> New Folder…
              </button>
              <div className="context-menu-sep" />
            </>
          )}

          {contextMenu.node && (
            <>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const target = contextMenu.node!;
                  setContextMenu(null);
                  setClipboard({
                    mode: "cut",
                    path: target.path,
                    name: target.name,
                  });
                }}
              >
                <Scissors size={13} /> Cut
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const target = contextMenu.node!;
                  setContextMenu(null);
                  setClipboard({
                    mode: "copy",
                    path: target.path,
                    name: target.name,
                  });
                }}
              >
                <Copy size={13} /> Copy
              </button>
            </>
          )}

          {(!contextMenu.node || contextMenu.node.is_dir) &&
            workspacePath &&
            clipboard && (
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const dir = contextMenu.node?.path ?? workspacePath;
                  setContextMenu(null);
                  void handlePasteInto(dir);
                }}
              >
                <ClipboardPaste size={13} /> Paste “{clipboard.name}”
              </button>
            )}

          {contextMenu.node && (
            <>
              {!contextMenu.node.is_dir && (
                <button
                  type="button"
                  className="context-menu-item"
                  onClick={() => {
                    const target = contextMenu.node!;
                    setContextMenu(null);
                    void onDuplicateFile(target.path);
                  }}
                >
                  <Copy size={13} /> Duplicate
                </button>
              )}
              <div className="context-menu-sep" />
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const target = contextMenu.node!;
                  setContextMenu(null);
                  void onCopyPath(target.path, false);
                }}
              >
                <ClipboardCopy size={13} /> Copy Path
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const target = contextMenu.node!;
                  setContextMenu(null);
                  void onCopyPath(target.path, true);
                }}
              >
                <Link2 size={13} /> Copy Relative Path
              </button>
              <div className="context-menu-sep" />
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const target = contextMenu.node!;
                  setContextMenu(null);
                  void onRevealInFinder(target.path);
                }}
              >
                <ExternalLink size={13} /> Reveal in Finder
              </button>
              {contextMenu.node.is_dir ? (
                <button
                  type="button"
                  className="context-menu-item"
                  onClick={() => {
                    const target = contextMenu.node!;
                    setContextMenu(null);
                    onOpenRecentFolder(target.path);
                  }}
                >
                  <FolderOpen size={13} /> Open as Workspace
                </button>
              ) : (
                <button
                  type="button"
                  className="context-menu-item"
                  onClick={() => {
                    const target = contextMenu.node!;
                    setContextMenu(null);
                    void onOpenWithDefaultApp(target.path);
                  }}
                >
                  <ExternalLink size={13} /> Open in Default App
                </button>
              )}
              <div className="context-menu-sep" />
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const target = contextMenu.node!;
                  setContextMenu(null);
                  setRenamingPath(target.path);
                }}
              >
                <Pencil size={13} /> Rename
              </button>
              <button
                type="button"
                className="context-menu-item is-danger"
                onClick={() => {
                  const target = contextMenu.node!;
                  setContextMenu(null);
                  void onTrashEntry(target);
                }}
              >
                <Trash2 size={13} /> Move to Trash
              </button>
            </>
          )}

          {!contextMenu.node && workspacePath && (
            <>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  void onCopyPath(workspacePath, false);
                }}
              >
                <ClipboardCopy size={13} /> Copy Folder Path
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  void onRevealInFinder(workspacePath);
                }}
              >
                <ExternalLink size={13} /> Reveal in Finder
              </button>
              <div className="context-menu-sep" />
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onRefreshWorkspace();
                }}
              >
                <RefreshCw size={13} /> Refresh
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onOpenFolder();
                }}
              >
                <FolderOpen size={13} /> Open Folder…
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
