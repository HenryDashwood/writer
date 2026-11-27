import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import type { EditKind, ResolvedComment, ResolvedHunk } from "../types";
import { extensionsForFile, getDocumentModeInfo } from "./codeMode";
import {
  type MdxIslandConfig,
  mdxIslandConfigFacet,
} from "./livePreview";
import {
  acceptAllHunks,
  acceptHunk,
  acceptHunksByKind,
  diffOverlayExtension,
  type DiffOverlayState,
  dismissComment,
  focusComment,
  focusHunk,
  rejectAllHunks,
  rejectHunk,
  setCommentsEffect,
  setHunksEffect,
  stepHunk,
} from "./diffExtension";

export interface SelectionSnapshot {
  from: number;
  to: number;
  text: string;
}

export interface EditorCanvasHandle {
  setDocument: (content: string, filePath?: string | null) => void;
  replaceContentSilently: (content: string) => void;
  getContent: () => string;
  getSelection: () => SelectionSnapshot | null;
  setPassResults: (hunks: ResolvedHunk[], comments: ResolvedComment[]) => void;
  focusHunk: (id: string | null) => void;
  focusComment: (id: string | null) => void;
  dismissComment: (id: string) => void;
  stepHunk: (delta: 1 | -1) => void;
  acceptHunk: (id: string) => void;
  rejectHunk: (id: string) => void;
  acceptHunksByKind: (kind: EditKind) => void;
  acceptAllHunks: () => void;
  rejectAllHunks: () => void;
  jumpToOffset: (utf16Offset: number) => void;
}

interface EditorCanvasProps {
  initialContent: string;
  filePath: string | null;
  forceSourceMode: boolean;
  mdxIslandConfig: MdxIslandConfig;
  onChange: (content: string) => void;
  onSelectionChange?: (selection: SelectionSnapshot | null) => void;
  onDiffStateChange: (state: DiffOverlayState) => void;
  onSaveShortcut: () => void;
  onCmdKShortcut: () => void;
}

/**
 * Finds the UTF-16 offset of the first prose line after top-of-file `import`s,
 * `export const metadata = { ... }`, or YAML frontmatter so opening a file in prose
 * mode renders its page header cleanly instead of expanding raw metadata.
 */
function initialProseCursor(content: string): number {
  const lines = content.split("\n");
  let offset = 0;
  let i = 0;

  // Skip YAML frontmatter
  if (lines.length >= 3 && lines[0].trim() === "---") {
    let scan = 1;
    let fmOffset = lines[0].length + 1;
    while (scan < lines.length) {
      const t = lines[scan].trim();
      fmOffset += lines[scan].length + 1;
      scan++;
      if (t === "---" || t === "...") {
        i = scan;
        offset = fmOffset;
        break;
      }
    }
  }

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("import ")) {
      offset += lines[i].length + 1;
      i++;
      continue;
    }
    if (/^export\s+const\s+metadata\s*=\s*\{/.test(trimmed)) {
      let depth = 0;
      while (i < lines.length) {
        for (const ch of lines[i]) {
          if (ch === "{") depth++;
          else if (ch === "}") depth = Math.max(0, depth - 1);
        }
        offset += lines[i].length + 1;
        i++;
        if (depth === 0) break;
      }
      continue;
    }
    return Math.min(offset, content.length);
  }
  return 0;
}

/**
 * Computes the minimal single-range edit between `prev` and `next` by trimming
 * their shared prefix and suffix. Patching only the changed slice lets
 * CodeMirror map cursor/selection cleanly and keep scroll & untouched widgets steady.
 */
function computeMinimalChange(prev: string, next: string) {
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) {
    start++;
  }
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (
    prevEnd > start &&
    nextEnd > start &&
    prev.charCodeAt(prevEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    prevEnd--;
    nextEnd--;
  }
  return { from: start, to: prevEnd, insert: next.slice(start, nextEnd) };
}

export const EditorCanvas = forwardRef<EditorCanvasHandle, EditorCanvasProps>(
  function EditorCanvas(
    {
      initialContent,
      filePath,
      forceSourceMode,
      mdxIslandConfig,
      onChange,
      onSelectionChange,
      onDiffStateChange,
      onSaveShortcut,
      onCmdKShortcut,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const modeCompartmentRef = useRef(new Compartment());
    const islandCompartmentRef = useRef(new Compartment());
    const onChangeRef = useRef(onChange);
    const onSelectionRef = useRef(onSelectionChange);
    const onDiffRef = useRef(onDiffStateChange);
    const onSaveRef = useRef(onSaveShortcut);
    const onCmdKRef = useRef(onCmdKShortcut);
    const forceSourceRef = useRef(forceSourceMode);
    const suppressChangeRef = useRef(false);

    onChangeRef.current = onChange;
    onSelectionRef.current = onSelectionChange;
    onDiffRef.current = onDiffStateChange;
    onSaveRef.current = onSaveShortcut;
    onCmdKRef.current = onCmdKShortcut;
    forceSourceRef.current = forceSourceMode;

    const isCode = getDocumentModeInfo(filePath).isCode || forceSourceMode;

    useEffect(() => {
      if (!hostRef.current) return;

      const state = EditorState.create({
        doc: initialContent,
        selection: {
          anchor: isCode ? 0 : initialProseCursor(initialContent),
        },
        extensions: [
          history(),
          islandCompartmentRef.current.of(
            mdxIslandConfigFacet.of(mdxIslandConfig),
          ),
          modeCompartmentRef.current.of(
            extensionsForFile(filePath, forceSourceMode),
          ),
          EditorView.lineWrapping,
          diffOverlayExtension((diffState) => onDiffRef.current(diffState)),
          placeholder("Open a folder or start writing…"),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            {
              key: "Mod-k",
              run: () => {
                onCmdKRef.current();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !suppressChangeRef.current) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet && onSelectionRef.current) {
              const main = update.state.selection.main;
              if (main.from !== main.to) {
                const text = update.state.sliceDoc(main.from, main.to);
                onSelectionRef.current(
                  text.trim() ? { from: main.from, to: main.to, text } : null,
                );
              } else {
                onSelectionRef.current(null);
              }
            }
          }),
        ],
      });

      const view = new EditorView({
        state,
        parent: hostRef.current,
      });
      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Initialize EditorView once; mode & document swaps happen via Compartment and setDocument.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Reconfigure language & styling cleanly when switching files or toggling Source mode.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: modeCompartmentRef.current.reconfigure(
          extensionsForFile(filePath, forceSourceMode),
        ),
      });
    }, [filePath, forceSourceMode]);

    // Update live MDX island config (sidecar URL, theme, enable toggle, manual reload).
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: islandCompartmentRef.current.reconfigure(
          mdxIslandConfigFacet.of(mdxIslandConfig),
        ),
      });
    }, [mdxIslandConfig]);

    useImperativeHandle(ref, () => ({
      setDocument(content: string, nextFilePath?: string | null) {
        const view = viewRef.current;
        if (!view) return;
        suppressChangeRef.current = true;
        const effects = [setHunksEffect.of([]), setCommentsEffect.of([])];
        if (nextFilePath !== undefined) {
          effects.push(
            modeCompartmentRef.current.reconfigure(
              extensionsForFile(nextFilePath, forceSourceRef.current),
            ) as never,
          );
        }
        const targetIsCode =
          getDocumentModeInfo(nextFilePath ?? filePath).isCode ||
          forceSourceRef.current;
        const anchor = targetIsCode ? 0 : initialProseCursor(content);
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
          effects,
          selection: { anchor },
        });
        suppressChangeRef.current = false;
      },
      replaceContentSilently(content: string) {
        const view = viewRef.current;
        if (!view) return;
        const prev = view.state.doc.toString();
        if (prev === content) return;
        const prevScrollTop = view.scrollDOM.scrollTop;
        const change = computeMinimalChange(prev, content);
        suppressChangeRef.current = true;
        view.dispatch({ changes: change });
        suppressChangeRef.current = false;
        requestAnimationFrame(() => {
          if (viewRef.current) {
            viewRef.current.scrollDOM.scrollTop = prevScrollTop;
          }
        });
      },
      getContent() {
        return viewRef.current?.state.doc.toString() ?? "";
      },
      getSelection() {
        const view = viewRef.current;
        if (!view) return null;
        const main = view.state.selection.main;
        if (main.from === main.to) {
          const line = view.state.doc.lineAt(main.from);
          if (!line.text.trim()) return null;
          return { from: line.from, to: line.to, text: line.text };
        }
        return {
          from: main.from,
          to: main.to,
          text: view.state.sliceDoc(main.from, main.to),
        };
      },
      setPassResults(hunks: ResolvedHunk[], comments: ResolvedComment[]) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          effects: [setHunksEffect.of(hunks), setCommentsEffect.of(comments)],
        });
        if (hunks.length > 0) {
          focusHunk(view, hunks[0].id);
        } else if (comments.length > 0) {
          focusComment(view, comments[0].id);
        }
      },
      focusHunk(id: string | null) {
        if (viewRef.current) focusHunk(viewRef.current, id);
      },
      focusComment(id: string | null) {
        if (viewRef.current) focusComment(viewRef.current, id);
      },
      dismissComment(id: string) {
        if (viewRef.current) dismissComment(viewRef.current, id);
      },
      stepHunk(delta: 1 | -1) {
        if (viewRef.current) stepHunk(viewRef.current, delta);
      },
      acceptHunk(id: string) {
        if (viewRef.current) acceptHunk(viewRef.current, id);
      },
      rejectHunk(id: string) {
        if (viewRef.current) rejectHunk(viewRef.current, id);
      },
      acceptHunksByKind(kind: EditKind) {
        if (viewRef.current) acceptHunksByKind(viewRef.current, kind);
      },
      acceptAllHunks() {
        if (viewRef.current) acceptAllHunks(viewRef.current);
      },
      rejectAllHunks() {
        if (viewRef.current) rejectAllHunks(viewRef.current);
      },
      jumpToOffset(utf16Offset: number) {
        const view = viewRef.current;
        if (!view) return;
        const pos = Math.min(utf16Offset, view.state.doc.length);
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 48 }),
        });
        view.focus();
      },
    }));

    return (
      <div
        className={`editor-host ${isCode ? "is-code-mode" : "is-prose-mode"}`}
        ref={hostRef}
      />
    );
  },
);
