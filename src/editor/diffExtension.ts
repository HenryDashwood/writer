import {
  type Extension,
  Prec,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType,
} from "@codemirror/view";
import type { EditKind, ResolvedComment, ResolvedHunk } from "../types";

export interface ActiveHunk extends ResolvedHunk {
  /** Live UTF-16 document offsets mapped through edits automatically. */
  from: number;
  to: number;
}

export interface ActiveComment extends ResolvedComment {
  from: number;
  to: number;
}

export interface DiffOverlayState {
  hunks: ActiveHunk[];
  focusedId: string | null;
  comments: ActiveComment[];
  focusedCommentId: string | null;
}

export const setHunksEffect = StateEffect.define<ResolvedHunk[]>();
export const removeHunkEffect = StateEffect.define<string>();
export const removeHunksEffect = StateEffect.define<string[]>();
export const focusHunkEffect = StateEffect.define<string | null>();

export const setCommentsEffect = StateEffect.define<ResolvedComment[]>();
export const removeCommentEffect = StateEffect.define<string>();
export const focusCommentEffect = StateEffect.define<string | null>();

function nextFocusId(
  hunks: ActiveHunk[],
  removedIds: Set<string>,
  previousFocus: string | null,
): string | null {
  const remaining = hunks.filter((h) => !removedIds.has(h.id));
  if (remaining.length === 0) return null;
  if (previousFocus && !removedIds.has(previousFocus)) return previousFocus;

  const oldIdx = hunks.findIndex((h) => h.id === previousFocus);
  if (oldIdx >= 0) {
    for (let i = oldIdx + 1; i < hunks.length; i++) {
      if (!removedIds.has(hunks[i].id)) return hunks[i].id;
    }
  }
  return remaining[0].id;
}

export const diffOverlayField = StateField.define<DiffOverlayState>({
  create() {
    return {
      hunks: [],
      focusedId: null,
      comments: [],
      focusedCommentId: null,
    };
  },
  update(value, tr) {
    let { hunks, focusedId, comments, focusedCommentId } = value;

    // 1. Remap hunks & comments through document edits.
    if (tr.docChanged) {
      if (hunks.length > 0) {
        const remapped: ActiveHunk[] = [];
        for (const hunk of hunks) {
          let touched = false;
          tr.changes.iterChangedRanges((fromA, toA) => {
            if (fromA < hunk.to && toA > hunk.from) {
              touched = true;
            }
          });
          if (touched) continue;

          const newFrom = tr.changes.mapPos(hunk.from, 1);
          const newTo = tr.changes.mapPos(hunk.to, -1);
          if (newFrom <= newTo && newTo <= tr.newDoc.length) {
            remapped.push({ ...hunk, from: newFrom, to: newTo });
          }
        }
        hunks = remapped;
        if (focusedId && !hunks.some((h) => h.id === focusedId)) {
          focusedId = hunks[0]?.id ?? null;
        }
      }

      if (comments.length > 0) {
        const remappedComments: ActiveComment[] = [];
        for (const c of comments) {
          const newFrom = tr.changes.mapPos(c.from, 1);
          const newTo = tr.changes.mapPos(c.to, -1);
          if (newFrom < newTo && newTo <= tr.newDoc.length) {
            remappedComments.push({ ...c, from: newFrom, to: newTo });
          }
        }
        comments = remappedComments;
        if (
          focusedCommentId &&
          !comments.some((c) => c.id === focusedCommentId)
        ) {
          focusedCommentId = null;
        }
      }
    }

    // 2. Apply explicit overlay effects.
    for (const effect of tr.effects) {
      if (effect.is(setHunksEffect)) {
        const docLen = tr.newDoc.length;
        hunks = effect.value
          .filter((h) => h.utf16_start <= h.utf16_end && h.utf16_end <= docLen)
          .map((h) => ({
            ...h,
            from: h.utf16_start,
            to: h.utf16_end,
          }));
        focusedId = hunks[0]?.id ?? null;
      } else if (effect.is(removeHunkEffect)) {
        const removed = new Set([effect.value]);
        focusedId = nextFocusId(hunks, removed, focusedId);
        hunks = hunks.filter((h) => !removed.has(h.id));
      } else if (effect.is(removeHunksEffect)) {
        const removed = new Set(effect.value);
        focusedId = nextFocusId(hunks, removed, focusedId);
        hunks = hunks.filter((h) => !removed.has(h.id));
      } else if (effect.is(focusHunkEffect)) {
        focusedId = effect.value;
      } else if (effect.is(setCommentsEffect)) {
        const docLen = tr.newDoc.length;
        comments = effect.value
          .filter((c) => c.utf16_start < c.utf16_end && c.utf16_end <= docLen)
          .map((c) => ({
            ...c,
            from: c.utf16_start,
            to: c.utf16_end,
          }));
        focusedCommentId = comments[0]?.id ?? null;
      } else if (effect.is(removeCommentEffect)) {
        comments = comments.filter((c) => c.id !== effect.value);
        if (focusedCommentId === effect.value) {
          focusedCommentId = comments[0]?.id ?? null;
        }
      } else if (effect.is(focusCommentEffect)) {
        focusedCommentId = effect.value;
      }
    }

    return { hunks, focusedId, comments, focusedCommentId };
  },
});

class InsertTokenWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly hunkId: string,
    private readonly focused: boolean,
  ) {
    super();
  }

  eq(other: InsertTokenWidget): boolean {
    return (
      this.text === other.text &&
      this.hunkId === other.hunkId &&
      this.focused === other.focused
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.focused
      ? "cm-diff-ins cm-diff-ins-focused"
      : "cm-diff-ins";
    span.dataset.hunkId = this.hunkId;
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const diffDecorations = EditorView.decorations.compute(
  [diffOverlayField],
  (state): DecorationSet => {
    const { hunks, focusedId, comments, focusedCommentId } =
      state.field(diffOverlayField);
    if (hunks.length === 0 && comments.length === 0) return Decoration.none;

    const ranges: Array<Range<Decoration>> = [];
    const markedLines = new Set<number>();

    // Render anchored critique comments and Pangram AI-flagged spans.
    for (const comment of comments) {
      const isFocused = comment.id === focusedCommentId;
      if (comment.to > comment.from) {
        let markClass = isFocused
          ? "cm-comment-mark cm-comment-mark-focused"
          : "cm-comment-mark";
        if (comment.kind === "ai_generated") {
          markClass = isFocused
            ? "cm-pangram-ai cm-pangram-ai-focused"
            : "cm-pangram-ai";
        } else if (comment.kind === "ai_assisted") {
          markClass = isFocused
            ? "cm-pangram-assisted cm-pangram-assisted-focused"
            : "cm-pangram-assisted";
        }
        ranges.push(
          Decoration.mark({
            class: markClass,
            attributes: { "data-comment-id": comment.id },
          }).range(comment.from, comment.to),
        );
      }
    }

    for (const hunk of hunks) {
      const isFocused = hunk.id === focusedId;

      const startLine = state.doc.lineAt(hunk.from).number;
      const endLine = state.doc.lineAt(hunk.to).number;
      for (let ln = startLine; ln <= endLine; ln++) {
        const line = state.doc.line(ln);
        if (!markedLines.has(line.from)) {
          markedLines.add(line.from);
          ranges.push(
            Decoration.line({
              class: isFocused
                ? "cm-diff-line cm-diff-line-focused"
                : `cm-diff-line cm-diff-kind-${hunk.kind}`,
            }).range(line.from),
          );
        }
      }

      let pos = hunk.from;
      for (const token of hunk.tokens) {
        if (token.op === "equal") {
          const end = Math.min(pos + token.text.length, hunk.to);
          if (isFocused && end > pos) {
            ranges.push(
              Decoration.mark({
                class: "cm-diff-context-focused",
                attributes: { "data-hunk-id": hunk.id },
              }).range(pos, end),
            );
          }
          pos = end;
        } else if (token.op === "delete") {
          const end = Math.min(pos + token.text.length, hunk.to);
          if (end > pos) {
            ranges.push(
              Decoration.mark({
                class: isFocused
                  ? "cm-diff-del cm-diff-del-focused"
                  : "cm-diff-del",
                attributes: { "data-hunk-id": hunk.id },
              }).range(pos, end),
            );
          }
          pos = end;
        } else if (token.op === "insert") {
          ranges.push(
            Decoration.widget({
              widget: new InsertTokenWidget(token.text, hunk.id, isFocused),
              side: 1,
            }).range(pos),
          );
        }
      }
    }

    return Decoration.set(ranges, true);
  },
);

export function focusHunk(view: EditorView, hunkId: string | null): void {
  const { hunks } = view.state.field(diffOverlayField);
  const target = hunks.find((h) => h.id === hunkId);
  view.dispatch({
    effects: focusHunkEffect.of(hunkId),
    scrollIntoView: false,
  });
  if (target) {
    view.dispatch({
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
  }
}

export function focusComment(view: EditorView, commentId: string | null): void {
  const { comments } = view.state.field(diffOverlayField);
  const target = comments.find((c) => c.id === commentId);
  view.dispatch({
    effects: focusCommentEffect.of(commentId),
    scrollIntoView: false,
  });
  if (target) {
    view.dispatch({
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
  }
}

export function dismissComment(view: EditorView, commentId: string): void {
  view.dispatch({ effects: removeCommentEffect.of(commentId) });
}

export function stepHunk(view: EditorView, delta: 1 | -1): boolean {
  const { hunks, focusedId } = view.state.field(diffOverlayField);
  if (hunks.length === 0) return false;
  const currentIdx = hunks.findIndex((h) => h.id === focusedId);
  const nextIdx =
    currentIdx < 0 ? 0 : (currentIdx + delta + hunks.length) % hunks.length;
  focusHunk(view, hunks[nextIdx].id);
  return true;
}

export function acceptHunk(view: EditorView, hunkId: string): boolean {
  const { hunks } = view.state.field(diffOverlayField);
  const hunk = hunks.find((h) => h.id === hunkId);
  if (!hunk) return false;

  view.dispatch({
    changes: { from: hunk.from, to: hunk.to, insert: hunk.replacement },
    effects: removeHunkEffect.of(hunk.id),
  });

  const nextId = view.state.field(diffOverlayField).focusedId;
  if (nextId) {
    const next = view.state
      .field(diffOverlayField)
      .hunks.find((h) => h.id === nextId);
    if (next) {
      view.dispatch({
        effects: EditorView.scrollIntoView(next.from, { y: "center" }),
      });
    }
  }
  return true;
}

export function rejectHunk(view: EditorView, hunkId: string): boolean {
  const { hunks } = view.state.field(diffOverlayField);
  if (!hunks.some((h) => h.id === hunkId)) return false;

  view.dispatch({
    effects: removeHunkEffect.of(hunkId),
  });
  return true;
}

export function acceptHunksByKind(view: EditorView, kind: EditKind): boolean {
  const { hunks } = view.state.field(diffOverlayField);
  const matching = hunks.filter((h) => h.kind === kind);
  if (matching.length === 0) return false;

  view.dispatch({
    changes: matching.map((h) => ({
      from: h.from,
      to: h.to,
      insert: h.replacement,
    })),
    effects: removeHunksEffect.of(matching.map((h) => h.id)),
  });
  return true;
}

export function acceptAllHunks(view: EditorView): boolean {
  const { hunks } = view.state.field(diffOverlayField);
  if (hunks.length === 0) return false;

  view.dispatch({
    changes: hunks.map((h) => ({
      from: h.from,
      to: h.to,
      insert: h.replacement,
    })),
    effects: removeHunksEffect.of(hunks.map((h) => h.id)),
  });
  return true;
}

export function rejectAllHunks(view: EditorView): boolean {
  const { hunks } = view.state.field(diffOverlayField);
  if (hunks.length === 0) return false;

  view.dispatch({
    effects: removeHunksEffect.of(hunks.map((h) => h.id)),
  });
  return true;
}

const clickOverlayHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    const hunkEl = target?.closest<HTMLElement>("[data-hunk-id]");
    if (hunkEl?.dataset.hunkId) {
      focusHunk(view, hunkEl.dataset.hunkId);
      return false;
    }
    const commentEl = target?.closest<HTMLElement>("[data-comment-id]");
    if (commentEl?.dataset.commentId) {
      focusComment(view, commentEl.dataset.commentId);
      return false;
    }
    return false;
  },
});

const diffKeymap = Prec.high(
  keymap.of([
    {
      key: "Mod-]",
      run: (view) => stepHunk(view, 1),
    },
    {
      key: "Mod-[",
      run: (view) => stepHunk(view, -1),
    },
    {
      key: "Mod-Enter",
      run: (view) => {
        const { focusedId } = view.state.field(diffOverlayField);
        return focusedId ? acceptHunk(view, focusedId) : false;
      },
    },
    {
      key: "Mod-Backspace",
      run: (view) => {
        const { focusedId } = view.state.field(diffOverlayField);
        return focusedId ? rejectHunk(view, focusedId) : false;
      },
    },
  ]),
);

export function diffOverlayExtension(
  onStateChange: (state: DiffOverlayState) => void,
): Extension {
  return [
    diffOverlayField,
    diffDecorations,
    clickOverlayHandler,
    diffKeymap,
    EditorView.updateListener.of((update) => {
      const prev = update.startState.field(diffOverlayField);
      const next = update.state.field(diffOverlayField);
      if (prev !== next) {
        onStateChange(next);
      }
    }),
  ];
}
