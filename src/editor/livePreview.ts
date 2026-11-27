import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  Facet,
  type Range,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import katex from "katex";
import type { PageMetadata } from "../types";
import { diffOverlayField } from "./diffExtension";

export interface MdxIslandConfig {
  baseUrl: string | null;
  filePath: string | null;
  theme: "light" | "dark";
  enabled: boolean;
  revision: number;
  pageMetadata: PageMetadata | null;
}

export const mdxIslandConfigFacet = Facet.define<
  MdxIslandConfig,
  MdxIslandConfig
>({
  combine(values) {
    return (
      values[values.length - 1] ?? {
        baseUrl: null,
        filePath: null,
        theme: "light",
        enabled: false,
        revision: 0,
        pageMetadata: null,
      }
    );
  },
});

// Shared height cache & message listener so inline MDX iframes auto-size smoothly.
const islandHeights = new Map<string, number>();
const islandIframes = new Map<string, HTMLIFrameElement>();
let islandListenerAttached = false;

function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function ensureIslandResizeListener() {
  if (islandListenerAttached || typeof window === "undefined") return;
  islandListenerAttached = true;
  window.addEventListener("message", (event) => {
    const data = event.data as {
      type?: string;
      id?: string;
      height?: number;
    } | null;
    if (
      data?.type === "writer-island-height" &&
      typeof data.id === "string" &&
      typeof data.height === "number" &&
      data.height > 0
    ) {
      const clamped = Math.min(Math.max(Math.ceil(data.height) + 2, 24), 2200);
      islandHeights.set(data.id, clamped);
      const iframe = islandIframes.get(data.id);
      if (iframe) {
        iframe.style.height = `${clamped}px`;
      }
    }
  });
}

function selectionTouches(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) {
      return true;
    }
  }
  return false;
}

function activeOverlayTouches(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  const overlay = state.field(diffOverlayField, false);
  if (!overlay) return false;
  return (
    overlay.hunks.some((h) => h.from < to && h.to > from) ||
    overlay.comments.some((c) => c.from < to && c.to > from)
  );
}

class KatexWidget extends WidgetType {
  constructor(
    private readonly tex: string,
    private readonly displayMode: boolean,
  ) {
    super();
  }

  eq(other: KatexWidget): boolean {
    return this.tex === other.tex && this.displayMode === other.displayMode;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.displayMode ? "cm-math-block" : "cm-math-inline";
    try {
      el.innerHTML = katex.renderToString(this.tex, {
        displayMode: this.displayMode,
        throwOnError: false,
      });
    } catch {
      el.textContent = this.tex;
    }
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class JsxPillWidget extends WidgetType {
  constructor(
    private readonly tagName: string,
    private readonly isClosing: boolean,
  ) {
    super();
  }

  eq(other: JsxPillWidget): boolean {
    return this.tagName === other.tagName && this.isClosing === other.isClosing;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.isClosing
      ? "cm-jsx-pill cm-jsx-closing"
      : "cm-jsx-pill";
    el.textContent = this.isClosing ? `/${this.tagName}` : `⬡ ${this.tagName}`;
    el.title = "Click to edit MDX tag";
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class MdxIslandWidget extends WidgetType {
  private readonly islandId: string;

  constructor(
    private readonly tagName: string,
    private readonly jsx: string,
    private readonly baseUrl: string,
    private readonly filePath: string,
    private readonly theme: "light" | "dark",
    private readonly revision: number,
    private readonly pos: number,
  ) {
    super();
    this.islandId = `${hashString(filePath)}-${hashString(jsx)}`;
  }

  eq(other: MdxIslandWidget): boolean {
    // Intentionally ignore `pos` so typing prose elsewhere never reloads the live component!
    return (
      this.jsx === other.jsx &&
      this.baseUrl === other.baseUrl &&
      this.filePath === other.filePath &&
      this.theme === other.theme &&
      this.revision === other.revision
    );
  }

  toDOM(view: EditorView): HTMLElement {
    ensureIslandResizeListener();

    const wrapper = document.createElement("span");
    wrapper.className =
      this.tagName === "details"
        ? "cm-mdx-island cm-mdx-island-details"
        : "cm-mdx-island cm-mdx-island-figure";

    const controls = document.createElement("span");
    controls.className = "cm-mdx-island-controls";

    const reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.className = "cm-mdx-island-btn";
    reloadBtn.textContent = "↻";
    reloadBtn.title = `Reload ${this.tagName}`;

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "cm-mdx-island-btn";
    editBtn.textContent = "Edit";
    editBtn.title = `Reveal <${this.tagName}> source`;
    editBtn.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetPos = Math.min(this.pos, view.state.doc.length);
      view.dispatch({ selection: { anchor: targetPos } });
      view.focus();
    };

    controls.appendChild(reloadBtn);
    controls.appendChild(editBtn);

    const iframe = document.createElement("iframe");
    iframe.className = "cm-mdx-island-frame";
    iframe.title = this.tagName;
    const defaultHeight = this.tagName === "details" ? 28 : 220;
    const initialHeight = islandHeights.get(this.islandId) ?? defaultHeight;
    iframe.style.height = `${initialHeight}px`;

    const buildSrc = (nonce: number) =>
      `${this.baseUrl}/island?file=${encodeURIComponent(this.filePath)}&jsx=${encodeURIComponent(this.jsx)}&id=${encodeURIComponent(this.islandId)}&theme=${this.theme}&v=${this.revision}-${nonce}`;

    iframe.src = buildSrc(0);
    islandIframes.set(this.islandId, iframe);

    let localReloads = 0;
    reloadBtn.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      localReloads += 1;
      iframe.src = buildSrc(localReloads);
    };

    wrapper.appendChild(controls);
    wrapper.appendChild(iframe);
    return wrapper;
  }

  destroy(): void {
    islandIframes.delete(this.islandId);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class MdxHeaderPillWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  eq(other: MdxHeaderPillWidget): boolean {
    return this.label === other.label;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-mdx-meta-pill";
    el.textContent = this.label;
    el.title = "Click to expand source";
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class FootnoteRefWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly targetOffset: number | null,
    private readonly tooltipText: string | null,
  ) {
    super();
  }

  eq(other: FootnoteRefWidget): boolean {
    return (
      this.label === other.label &&
      this.targetOffset === other.targetOffset &&
      this.tooltipText === other.tooltipText
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const sup = document.createElement("sup");
    sup.className = "cm-fn-ref";
    sup.textContent = `[${this.label}]`;
    sup.title = this.tooltipText
      ? `${this.tooltipText} (click to jump)`
      : `Footnote ${this.label}`;
    if (this.targetOffset !== null) {
      const target = this.targetOffset;
      sup.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = Math.min(target, view.state.doc.length);
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
        view.focus();
      };
    }
    return sup;
  }

  ignoreEvent(): boolean {
    return this.targetOffset !== null;
  }
}

class FootnoteDefLabelWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly backOffset: number | null,
  ) {
    super();
  }

  eq(other: FootnoteDefLabelWidget): boolean {
    return this.label === other.label && this.backOffset === other.backOffset;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-fn-def-label";
    span.textContent = `${this.label}.`;
    span.title = this.backOffset !== null ? "Jump back to reference" : "";
    if (this.backOffset !== null) {
      const target = this.backOffset;
      span.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = Math.min(target, view.state.doc.length);
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
        view.focus();
      };
    }
    return span;
  }

  ignoreEvent(): boolean {
    return this.backOffset !== null;
  }
}

class MarkdownImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly pos: number,
  ) {
    super();
  }

  eq(other: MarkdownImageWidget): boolean {
    return this.src === other.src && this.alt === other.alt;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-image-wrap";

    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    img.title = this.alt || "Click to edit image Markdown";
    img.onmousedown = (e) => {
      e.preventDefault();
      const targetPos = Math.min(this.pos, view.state.doc.length);
      view.dispatch({ selection: { anchor: targetPos } });
      view.focus();
    };
    wrap.appendChild(img);

    if (this.alt) {
      const cap = document.createElement("span");
      cap.className = "cm-md-image-caption";
      cap.textContent = this.alt;
      wrap.appendChild(cap);
    }

    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class PageHeaderWidget extends WidgetType {
  constructor(
    private readonly title: string | null,
    private readonly description: string | null,
    private readonly date: string | null,
    private readonly tags: string[],
    private readonly editPos: number | null,
    private readonly sourceLabel: string | null,
  ) {
    super();
  }

  eq(other: PageHeaderWidget): boolean {
    return (
      this.title === other.title &&
      this.description === other.description &&
      this.date === other.date &&
      this.tags.join(",") === other.tags.join(",") &&
      this.editPos === other.editPos &&
      this.sourceLabel === other.sourceLabel
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const header = document.createElement("div");
    header.className = "cm-page-header";

    if (this.editPos !== null) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "cm-page-header-edit";
      editBtn.textContent = "Edit metadata";
      editBtn.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = Math.min(this.editPos!, view.state.doc.length);
        view.dispatch({ selection: { anchor: pos } });
        view.focus();
      };
      header.appendChild(editBtn);
    }

    if (this.title) {
      const h1 = document.createElement("div");
      h1.className = "cm-page-title";
      h1.textContent = this.title;
      header.appendChild(h1);
    }

    if (this.description) {
      const desc = document.createElement("div");
      desc.className = "cm-page-desc";
      desc.textContent = this.description;
      header.appendChild(desc);
    }

    if (this.date || this.tags.length > 0 || this.sourceLabel) {
      const metaRow = document.createElement("div");
      metaRow.className = "cm-page-meta";

      if (this.date) {
        const dateEl = document.createElement("span");
        dateEl.className = "cm-page-date";
        dateEl.textContent = formatDisplayDate(this.date);
        metaRow.appendChild(dateEl);
      }

      for (const tag of this.tags) {
        const chip = document.createElement("span");
        chip.className = "cm-page-tag";
        chip.textContent = tag;
        metaRow.appendChild(chip);
      }

      if (this.sourceLabel) {
        const src = document.createElement("span");
        src.className = "cm-page-source";
        src.textContent = this.sourceLabel;
        metaRow.appendChild(src);
      }

      header.appendChild(metaRow);
    }

    return header;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function formatDisplayDate(raw: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!iso) return raw;
  const d = new Date(
    Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
  );
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function parseInlineJsMeta(block: string): {
  title: string | null;
  description: string | null;
  date: string | null;
  tags: string[];
} {
  const title = /title\s*:\s*["']([^"']+)["']/.exec(block)?.[1] ?? null;
  const description =
    /description\s*:\s*["']([^"']+)["']/.exec(block)?.[1] ?? null;
  const date =
    /(?:published|created|date)\s*:\s*["']([^"']+)["']/.exec(block)?.[1] ??
    null;
  const tagsBlock = /tags\s*:\s*\[([^\]]*)\]/.exec(block)?.[1] ?? "";
  const tags = Array.from(tagsBlock.matchAll(/["']([^"']+)["']/g)).map(
    (m) => m[1],
  );
  return { title, description, date, tags };
}

function parseInlineYamlMeta(block: string): {
  title: string | null;
  description: string | null;
  date: string | null;
  tags: string[];
} {
  let title: string | null = null;
  let description: string | null = null;
  let date: string | null = null;
  const tags: string[] = [];
  let inTagsList = false;

  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

  for (const line of block.split("\n")) {
    const t = line.trim();
    if (!t || t === "---" || t === "..." || t.startsWith("#")) continue;
    if (inTagsList) {
      if (t.startsWith("- ")) {
        const val = unquote(t.slice(2));
        if (val) tags.push(val);
        continue;
      }
      inTagsList = false;
    }
    const colon = t.indexOf(":");
    if (colon < 0) continue;
    const key = t.slice(0, colon).trim().toLowerCase();
    const val = t.slice(colon + 1).trim();
    if (key === "title") title = unquote(val);
    else if (key === "description" || key === "subtitle" || key === "summary") {
      description = unquote(val);
    } else if (key === "date" || key === "published" || key === "created") {
      date = unquote(val);
    } else if (key === "tags") {
      if (!val) {
        inTagsList = true;
      } else {
        const inner = val.startsWith("[") && val.endsWith("]")
          ? val.slice(1, -1)
          : val;
        for (const p of inner.split(",")) {
          const v = unquote(p);
          if (v) tags.push(v);
        }
      }
    }
  }
  return { title, description, date, tags };
}

type TableAlign = "left" | "center" | "right";

interface ParsedTable {
  headers: string[];
  alignments: TableAlign[];
  rows: string[][];
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseTableDelimiter(line: string): TableAlign[] | null {
  if (!line.includes("|")) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(":") && cell.endsWith(":")) aligns.push("center");
    else if (cell.endsWith(":")) aligns.push("right");
    else aligns.push("left");
  }
  return aligns;
}

function renderCellInline(cell: string, container: HTMLElement): void {
  // Lightweight inline Markdown + KaTeX + footnote renderer for table cells.
  const tokenRe =
    /(`[^`]+`|\$(?!\$)([^$\n]+?)\$|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)]+)\)|\[\^([^\]]+)\])/g;
  let lastIdx = 0;
  for (const m of cell.matchAll(tokenRe)) {
    if (m.index === undefined) continue;
    if (m.index > lastIdx) {
      container.appendChild(document.createTextNode(cell.slice(lastIdx, m.index)));
    }
    const full = m[0];
    if (full.startsWith("`")) {
      const code = document.createElement("code");
      code.className = "cm-md-code";
      code.textContent = full.slice(1, -1);
      container.appendChild(code);
    } else if (m[2] !== undefined) {
      const span = document.createElement("span");
      try {
        span.innerHTML = katex.renderToString(m[2], {
          displayMode: false,
          throwOnError: false,
        });
      } catch {
        span.textContent = full;
      }
      container.appendChild(span);
    } else if (m[3] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = m[3];
      container.appendChild(strong);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      const em = document.createElement("em");
      em.textContent = m[4] ?? m[5];
      container.appendChild(em);
    } else if (m[6] !== undefined && m[7] !== undefined) {
      const a = document.createElement("span");
      a.className = "cm-md-link";
      a.textContent = m[6];
      a.title = m[7];
      container.appendChild(a);
    } else if (m[8] !== undefined) {
      const sup = document.createElement("sup");
      sup.className = "cm-fn-ref";
      sup.textContent = `[${m[8]}]`;
      container.appendChild(sup);
    }
    lastIdx = m.index + full.length;
  }
  if (lastIdx < cell.length) {
    container.appendChild(document.createTextNode(cell.slice(lastIdx)));
  }
}

class MarkdownTableWidget extends WidgetType {
  constructor(
    private readonly raw: string,
    private readonly parsed: ParsedTable,
    private readonly pos: number,
  ) {
    super();
  }

  eq(other: MarkdownTableWidget): boolean {
    return this.raw === other.raw;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-wrap";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "cm-mdx-island-btn cm-md-table-edit";
    editBtn.textContent = "Edit table";
    editBtn.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetPos = Math.min(this.pos, view.state.doc.length);
      view.dispatch({ selection: { anchor: targetPos } });
      view.focus();
    };
    wrapper.appendChild(editBtn);

    const scroller = document.createElement("div");
    scroller.className = "cm-md-table-scroll";

    const table = document.createElement("table");
    table.className = "cm-md-table";

    const thead = document.createElement("thead");
    const headTr = document.createElement("tr");
    this.parsed.headers.forEach((cell, idx) => {
      const th = document.createElement("th");
      th.style.textAlign = this.parsed.alignments[idx] ?? "left";
      renderCellInline(cell, th);
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of this.parsed.rows) {
      const tr = document.createElement("tr");
      this.parsed.headers.forEach((_, idx) => {
        const td = document.createElement("td");
        td.style.textAlign = this.parsed.alignments[idx] ?? "left";
        renderCellInline(row[idx] ?? "", td);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroller.appendChild(table);
    wrapper.appendChild(scroller);

    // Clicking the table also opens it for direct Markdown editing.
    table.onmousedown = (e) => {
      e.preventDefault();
      const targetPos = Math.min(this.pos, view.state.doc.length);
      view.dispatch({ selection: { anchor: targetPos } });
      view.focus();
    };

    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class HorizontalRuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const hr = document.createElement("span");
    hr.className = "cm-md-hr";
    return hr;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class CodeFenceHeaderWidget extends WidgetType {
  constructor(private readonly lang: string) {
    super();
  }

  eq(other: CodeFenceHeaderWidget): boolean {
    return this.lang === other.lang;
  }

  toDOM(): HTMLElement {
    const row = document.createElement("span");
    row.className = "cm-md-code-header";
    const badge = document.createElement("span");
    badge.className = "cm-md-code-lang";
    badge.textContent = this.lang;
    row.appendChild(badge);
    return row;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

interface JsxBlockMatch {
  tagName: string;
  from: number;
  to: number;
  endLine: number;
  source: string;
}

/**
 * Scans a standalone JSX or HTML block starting at `startLine` — handling:
 *  - Single-line self-closing tags: `<PhaseVisual />`
 *  - Multi-line self-closing tags with nested `{...}` props: `<LocalImage\n  src="..."\n/>`
 *  - Paired multi-line tags: `<details>...</details>`, `<div ...>...</div>`, `<LocalImage>...</LocalImage>`
 */
function matchStandaloneComponentBlock(
  text: string,
  lineFrom: number,
  lineText: string,
): JsxBlockMatch | null {
  const openMatch = /^\s*<([A-Z][A-Za-z0-9._-]*|details|div)(?=[\s/>]|$)/.exec(
    lineText,
  );
  if (!openMatch) return null;

  const tagName = openMatch[1];
  const tagStart = lineFrom + lineText.indexOf("<");

  // 1. Scan the opening tag (tracking quotes and nested `{...}` JSX expressions) to find `>` or `/>`.
  let pos = tagStart + 1 + tagName.length;
  let braceDepth = 0;
  let inQuote: string | null = null;
  let openTagEnd = -1;
  let selfClosing = false;

  while (pos < text.length) {
    const ch = text[pos];
    if (inQuote) {
      if (ch === "\\" && pos + 1 < text.length) {
        pos += 2;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      pos++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inQuote = ch;
    } else if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (ch === ">" && braceDepth === 0) {
      selfClosing = text[pos - 1] === "/";
      openTagEnd = pos + 1;
      break;
    }
    pos++;
  }

  if (openTagEnd < 0) return null;

  if (selfClosing) {
    // Ensure nothing non-whitespace follows on the closing line (so inline `<Link />` in prose isn't treated as a block).
    const nextNl = text.indexOf("\n", openTagEnd);
    const lineTail = text.slice(openTagEnd, nextNl < 0 ? text.length : nextNl);
    if (lineTail.trim().length > 0) return null;
    const blockEnd = nextNl < 0 ? text.length : nextNl;
    return {
      tagName,
      from: lineFrom,
      to: blockEnd,
      endLine: -1,
      source: text.slice(tagStart, openTagEnd),
    };
  }

  // 2. Paired tag: find the matching closing `</tagName>` (tracking nested `<tagName` of the same name).
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pairRe = new RegExp(
    `<(\\/?)${escapedTag}(?=[\\s/>])([^>]*)>`,
    "g",
  );
  pairRe.lastIndex = openTagEnd;
  let depth = 1;
  let closeEnd = -1;

  for (let m = pairRe.exec(text); m !== null; m = pairRe.exec(text)) {
    const isClose = m[1] === "/";
    const isSelf = m[2].trimEnd().endsWith("/");
    if (isClose) {
      depth--;
      if (depth === 0) {
        closeEnd = m.index + m[0].length;
        break;
      }
    } else if (!isSelf) {
      depth++;
    }
  }

  if (closeEnd < 0) return null;

  const nextNl = text.indexOf("\n", closeEnd);
  const lineTail = text.slice(closeEnd, nextNl < 0 ? text.length : nextNl);
  if (lineTail.trim().length > 0) return null;
  const blockEnd = nextNl < 0 ? text.length : nextNl;

  return {
    tagName,
    from: lineFrom,
    to: blockEnd,
    endLine: -1,
    source: text.slice(tagStart, closeEnd),
  };
}

function findNextHeading1(doc: EditorState["doc"], startLine: number): string | null {
  for (let ln = startLine; ln <= Math.min(doc.lines, startLine + 6); ln++) {
    const t = doc.line(ln).text.trim();
    if (!t || t.startsWith("import ")) continue;
    const m = /^#\s+(.+)$/.exec(t);
    return m ? m[1].trim() : null;
  }
  return null;
}

const hiddenMark = Decoration.replace({});

function buildLivePreviewDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const text = doc.toString();
  const islandCfg = state.facet(mdxIslandConfigFacet);
  const marksAndLines: Array<Range<Decoration>> = [];
  const replacements: Array<{ from: number; to: number; deco: Decoration }> = [];

  const codeRanges: Array<[number, number]> = [];
  const lineDecorated = new Set<number>();

  // 1. Walk the Markdown syntax tree.
  syntaxTree(state).iterate({
    enter(node) {
      const name = node.name;
      const nFrom = node.from;
      const nTo = node.to;

      if (name === "FencedCode") {
        codeRanges.push([nFrom, nTo]);
        const startLine = doc.lineAt(nFrom).number;
        const endLine = doc.lineAt(nTo).number;
        for (let ln = startLine; ln <= endLine; ln++) {
          const line = doc.line(ln);
          const isOpen = ln === startLine;
          const isClose = ln === endLine && endLine > startLine;
          const active = selectionTouches(state, line.from, line.to);

          let lineClass = "cm-md-codeblock";
          if (isOpen) {
            const openMatch = /^\s*(?:`{3,}|~{3,})\s*([^\s`~]*)/.exec(
              line.text,
            );
            const lang = openMatch?.[1]?.trim() ?? "";
            if (!active && openMatch) {
              if (lang) {
                lineClass = "cm-md-codeblock cm-md-codeblock-open";
                replacements.push({
                  from: line.from,
                  to: line.to,
                  deco: Decoration.replace({
                    widget: new CodeFenceHeaderWidget(lang),
                  }),
                });
              } else {
                lineClass = "cm-md-codeblock cm-md-codeblock-open-bare";
                replacements.push({
                  from: line.from,
                  to: line.to,
                  deco: hiddenMark,
                });
              }
            } else {
              lineClass = "cm-md-codeblock cm-md-codeblock-open-raw";
            }
          } else if (isClose) {
            const isClosingFence = /^\s*(?:`{3,}|~{3,})\s*$/.test(line.text);
            if (!active && isClosingFence) {
              lineClass = "cm-md-codeblock cm-md-codeblock-close";
              replacements.push({
                from: line.from,
                to: line.to,
                deco: hiddenMark,
              });
            } else {
              lineClass = "cm-md-codeblock cm-md-codeblock-close-raw";
            }
          }

          if (!lineDecorated.has(line.from)) {
            lineDecorated.add(line.from);
            marksAndLines.push(
              Decoration.line({ class: lineClass }).range(line.from),
            );
          }
        }
        return false;
      }

      if (name.startsWith("ATXHeading")) {
        const level = name.slice("ATXHeading".length);
        const line = doc.lineAt(nFrom);
        if (!lineDecorated.has(line.from)) {
          lineDecorated.add(line.from);
          marksAndLines.push(
            Decoration.line({ class: `cm-md-h cm-md-h${level}` }).range(
              line.from,
            ),
          );
        }

        if (!selectionTouches(state, line.from, line.to)) {
          const match = /^(#{1,6}\s+)/.exec(line.text);
          if (match) {
            replacements.push({
              from: line.from,
              to: line.from + match[1].length,
              deco: hiddenMark,
            });
          }
        }
        return;
      }

      if (name === "Blockquote") {
        const startLine = doc.lineAt(nFrom).number;
        const endLine = doc.lineAt(nTo).number;
        for (let ln = startLine; ln <= endLine; ln++) {
          const line = doc.line(ln);
          if (!lineDecorated.has(line.from)) {
            lineDecorated.add(line.from);
            marksAndLines.push(
              Decoration.line({ class: "cm-md-quote" }).range(line.from),
            );
          }
          if (!selectionTouches(state, line.from, line.to)) {
            const m = /^(\s*>\s?)/.exec(line.text);
            if (m) {
              replacements.push({
                from: line.from,
                to: line.from + m[1].length,
                deco: hiddenMark,
              });
            }
          }
        }
        return;
      }

      if (name === "HorizontalRule") {
        const line = doc.lineAt(nFrom);
        if (!selectionTouches(state, line.from, line.to)) {
          replacements.push({
            from: line.from,
            to: line.to,
            deco: Decoration.replace({ widget: new HorizontalRuleWidget() }),
          });
        }
        return;
      }

      if (name === "StrongEmphasis" && nTo > nFrom) {
        marksAndLines.push(
          Decoration.mark({ class: "cm-md-strong" }).range(nFrom, nTo),
        );
        if (!selectionTouches(state, nFrom, nTo) && nTo - nFrom >= 4) {
          replacements.push({ from: nFrom, to: nFrom + 2, deco: hiddenMark });
          replacements.push({ from: nTo - 2, to: nTo, deco: hiddenMark });
        }
        return;
      }

      if (name === "Emphasis" && nTo > nFrom) {
        marksAndLines.push(
          Decoration.mark({ class: "cm-md-em" }).range(nFrom, nTo),
        );
        if (!selectionTouches(state, nFrom, nTo) && nTo - nFrom >= 2) {
          replacements.push({ from: nFrom, to: nFrom + 1, deco: hiddenMark });
          replacements.push({ from: nTo - 1, to: nTo, deco: hiddenMark });
        }
        return;
      }

      if (name === "Strikethrough" && nTo > nFrom) {
        marksAndLines.push(
          Decoration.mark({ class: "cm-md-strike" }).range(nFrom, nTo),
        );
        if (!selectionTouches(state, nFrom, nTo) && nTo - nFrom >= 4) {
          replacements.push({ from: nFrom, to: nFrom + 2, deco: hiddenMark });
          replacements.push({ from: nTo - 2, to: nTo, deco: hiddenMark });
        }
        return;
      }

      if (name === "InlineCode" && nTo > nFrom) {
        codeRanges.push([nFrom, nTo]);
        marksAndLines.push(
          Decoration.mark({ class: "cm-md-code" }).range(nFrom, nTo),
        );
        if (!selectionTouches(state, nFrom, nTo)) {
          const raw = text.slice(nFrom, nTo);
          const ticks = raw.match(/^`+/)?.[0].length ?? 0;
          if (ticks > 0 && nTo - nFrom > ticks * 2) {
            replacements.push({
              from: nFrom,
              to: nFrom + ticks,
              deco: hiddenMark,
            });
            replacements.push({
              from: nTo - ticks,
              to: nTo,
              deco: hiddenMark,
            });
          }
        }
        return;
      }

      if (name === "Link" && nTo > nFrom) {
        const raw = text.slice(nFrom, nTo);
        const closeBracket = raw.indexOf("](");
        if (closeBracket > 1 && raw.startsWith("[") && raw.endsWith(")")) {
          marksAndLines.push(
            Decoration.mark({ class: "cm-md-link" }).range(
              nFrom + 1,
              nFrom + closeBracket,
            ),
          );
          if (!selectionTouches(state, nFrom, nTo)) {
            replacements.push({ from: nFrom, to: nFrom + 1, deco: hiddenMark });
            replacements.push({
              from: nFrom + closeBracket,
              to: nTo,
              deco: hiddenMark,
            });
          }
        }
      }
    },
  });

  const isInCode = (start: number, end: number) =>
    codeRanges.some(([cFrom, cTo]) => start < cTo && end > cFrom);

  // 2. Scan footnote definitions (`[^1]: ...`) and first references (`[^1]`) up front so
  //    footnote links can jump cleanly in both directions and show tooltips!
  const footnoteDefs = new Map<string, { offset: number; body: string }>();
  const footnoteFirstRef = new Map<string, number>();

  for (let ln = 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    if (isInCode(line.from, line.to)) continue;
    const defMatch = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line.text);
    if (defMatch) {
      footnoteDefs.set(defMatch[1], {
        offset: line.from,
        body: defMatch[2].trim(),
      });
    }
  }

  // 3. Quiet YAML frontmatter, MDX imports, metadata exports (rendered as editorial page header),
  //    GFM tables, standalone Markdown images, and multi-line / paired JSX/HTML component blocks
  const mdxHiddenRanges: Array<[number, number]> = [];
  let renderedInlineHeader = false;
  let ln = 1;

  // Render YAML frontmatter at top of `.md` files as an editorial page header when unfocused.
  if (doc.lines >= 3 && doc.line(1).text.trim() === "---") {
    for (let scan = 2; scan <= Math.min(doc.lines, 40); scan++) {
      const t = doc.line(scan).text.trim();
      if (t === "---" || t === "...") {
        const blockFrom = 0;
        const blockTo = doc.line(scan).to;
        const parsed = parseInlineYamlMeta(text.slice(blockFrom, blockTo));
        if (
          !selectionTouches(state, blockFrom, blockTo) &&
          !activeOverlayTouches(state, blockFrom, blockTo)
        ) {
          const hasMeta =
            parsed.title ||
            parsed.description ||
            parsed.date ||
            parsed.tags.length > 0;
          if (hasMeta) {
            // Avoid duplicating an immediate `# Same Title` heading on the next non-blank line.
            const nextH1 = findNextHeading1(doc, scan + 1);
            const displayTitle =
              parsed.title &&
              nextH1 &&
              nextH1.toLowerCase() === parsed.title.toLowerCase()
                ? null
                : parsed.title;
            replacements.push({
              from: blockFrom,
              to: blockTo,
              deco: Decoration.replace({
                widget: new PageHeaderWidget(
                  displayTitle,
                  parsed.description,
                  parsed.date,
                  parsed.tags,
                  blockFrom,
                  null,
                ),
              }),
            });
            renderedInlineHeader = true;
          } else {
            replacements.push({
              from: blockFrom,
              to: blockTo,
              deco: Decoration.replace({
                widget: new MdxHeaderPillWidget("frontmatter"),
              }),
            });
          }
          mdxHiddenRanges.push([blockFrom, blockTo]);
        }
        ln = scan + 1;
        break;
      }
    }
  }

  while (ln <= doc.lines) {
    const line = doc.line(ln);
    if (isInCode(line.from, line.to)) {
      ln++;
      continue;
    }

    // Footnote definition line: `[^1]: ...`
    const fnDef = /^(\[\^([^\]]+)\]:\s*)/.exec(line.text);
    if (fnDef) {
      if (!lineDecorated.has(line.from)) {
        lineDecorated.add(line.from);
        marksAndLines.push(
          Decoration.line({ class: "cm-fn-def-line" }).range(line.from),
        );
      }
      if (!selectionTouches(state, line.from, line.from + fnDef[1].length)) {
        const label = fnDef[2];
        replacements.push({
          from: line.from,
          to: line.from + fnDef[1].length,
          deco: Decoration.replace({
            widget: new FootnoteDefLabelWidget(
              label,
              footnoteFirstRef.get(label) ?? null,
            ),
          }),
        });
      }
      ln++;
      continue;
    }

    // Blank spacer line in prose: steady 1rem (16px) height whether focused or not,
    // matching website paragraph spacing with zero vertical jump when clicked.
    if (line.text.trim() === "") {
      if (!lineDecorated.has(line.from)) {
        lineDecorated.add(line.from);
        marksAndLines.push(
          Decoration.line({ class: "cm-md-blank-line" }).range(line.from),
        );
      }
      ln++;
      continue;
    }

    // Top-level ESM import block: completely hidden in Live Preview (toggle `</>` Source mode
    // to inspect or edit imports) so clicking near the top never shifts the page down.
    if (/^import\s+/.test(line.text)) {
      let endLn = ln;
      while (endLn < doc.lines) {
        const nextText = doc.line(endLn + 1).text;
        if (/^import\s+/.test(nextText) || nextText.trim() === "") {
          endLn++;
          if (
            nextText.trim() === "" &&
            (endLn >= doc.lines || !/^import\s+/.test(doc.line(endLn + 1).text))
          ) {
            break;
          }
        } else {
          break;
        }
      }
      const blockFrom = line.from;
      const replaceTo =
        endLn < doc.lines ? doc.line(endLn + 1).from : doc.line(endLn).to;
      replacements.push({
        from: blockFrom,
        to: replaceTo,
        deco: hiddenMark,
      });
      mdxHiddenRanges.push([blockFrom, replaceTo]);
      ln = endLn + 1;
      continue;
    }

    // Multi-line `export const metadata = { ... };` -> rendered as editorial page header
    if (/^export\s+const\s+metadata\s*=\s*\{/.test(line.text)) {
      let endLn = ln;
      let depth = 0;
      for (let scan = ln; scan <= Math.min(doc.lines, ln + 40); scan++) {
        const lText = doc.line(scan).text;
        for (const ch of lText) {
          if (ch === "{") depth++;
          else if (ch === "}") depth = Math.max(0, depth - 1);
        }
        endLn = scan;
        if (depth === 0) break;
      }
      const blockFrom = line.from;
      const blockTo = doc.line(endLn).to;
      if (
        !selectionTouches(state, blockFrom, blockTo) &&
        !activeOverlayTouches(state, blockFrom, blockTo)
      ) {
        const parsed = parseInlineJsMeta(text.slice(blockFrom, blockTo));
        const hasMeta =
          parsed.title ||
          parsed.description ||
          parsed.date ||
          parsed.tags.length > 0;
        if (hasMeta) {
          const nextH1 = findNextHeading1(doc, endLn + 1);
          const displayTitle =
            parsed.title &&
            nextH1 &&
            nextH1.toLowerCase() === parsed.title.toLowerCase()
              ? null
              : parsed.title;
          replacements.push({
            from: blockFrom,
            to: blockTo,
            deco: Decoration.replace({
              widget: new PageHeaderWidget(
                displayTitle,
                parsed.description,
                parsed.date,
                parsed.tags,
                blockFrom,
                null,
              ),
            }),
          });
          renderedInlineHeader = true;
        } else {
          replacements.push({
            from: blockFrom,
            to: blockTo,
            deco: Decoration.replace({
              widget: new MdxHeaderPillWidget("export const metadata"),
            }),
          });
        }
        mdxHiddenRanges.push([blockFrom, blockTo]);
      } else {
        for (let scan = ln; scan <= endLn; scan++) {
          const sLine = doc.line(scan);
          if (sLine.to > sLine.from) {
            marksAndLines.push(
              Decoration.mark({ class: "cm-mdx-source" }).range(
                sLine.from,
                sLine.to,
              ),
            );
          }
        }
      }
      ln = endLn + 1;
      continue;
    }

    // GFM Markdown pipe table (`| Header | ... |\n| --- | --- |\n| Cell | ... |`)
    if (line.text.includes("|") && ln + 1 <= doc.lines) {
      const nextLine = doc.line(ln + 1);
      const alignments = parseTableDelimiter(nextLine.text);
      if (alignments) {
        const headers = splitTableRow(line.text);
        if (headers.length === alignments.length) {
          let endLn = ln + 1;
          const rows: string[][] = [];
          while (endLn + 1 <= doc.lines) {
            const candidate = doc.line(endLn + 1);
            if (
              candidate.text.trim() === "" ||
              !candidate.text.includes("|")
            ) {
              break;
            }
            rows.push(splitTableRow(candidate.text));
            endLn++;
          }
          const tableFrom = line.from;
          const tableTo = doc.line(endLn).to;
          if (
            !selectionTouches(state, tableFrom, tableTo) &&
            !activeOverlayTouches(state, tableFrom, tableTo)
          ) {
            replacements.push({
              from: tableFrom,
              to: tableTo,
              deco: Decoration.replace({
                widget: new MarkdownTableWidget(
                  text.slice(tableFrom, tableTo),
                  { headers, alignments, rows },
                  tableFrom,
                ),
              }),
            });
            mdxHiddenRanges.push([tableFrom, tableTo]);
          }
          ln = endLn + 1;
          continue;
        }
      }
    }

    // Standalone Markdown image line: `![alt](url)`
    const mdImg = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(
      line.text,
    );
    if (mdImg && !selectionTouches(state, line.from, line.to)) {
      let src = mdImg[2];
      if (src.startsWith("/") && islandCfg.baseUrl) {
        src = `${islandCfg.baseUrl}${src}`;
      }
      replacements.push({
        from: line.from,
        to: line.to,
        deco: Decoration.replace({
          widget: new MarkdownImageWidget(src, mdImg[1], line.from),
        }),
      });
      mdxHiddenRanges.push([line.from, line.to]);
      ln++;
      continue;
    }

    // Standalone single-line, multi-line, or paired JSX / HTML component blocks:
    // `<PhaseVisual />`, `<LocalImage\n ... />`, `<LocalImageSideBySide ... />`, `<details>...</details>`, `<div>...</div>`
    const block = matchStandaloneComponentBlock(text, line.from, line.text);
    if (block) {
      const endLn = doc.lineAt(block.to).number;
      const canRenderIsland =
        islandCfg.enabled &&
        Boolean(islandCfg.baseUrl) &&
        Boolean(islandCfg.filePath) &&
        !selectionTouches(state, block.from, block.to) &&
        !activeOverlayTouches(state, block.from, block.to);

      if (canRenderIsland) {
        replacements.push({
          from: block.from,
          to: block.to,
          deco: Decoration.replace({
            widget: new MdxIslandWidget(
              block.tagName,
              block.source,
              islandCfg.baseUrl!,
              islandCfg.filePath!,
              islandCfg.theme,
              islandCfg.revision,
              block.from,
            ),
          }),
        });
        mdxHiddenRanges.push([block.from, block.to]);
        ln = endLn + 1;
        continue;
      }
    }

    ln++;
  }

  // If metadata lives in a sibling `page.tsx` (e.g. `posts/<slug>/post.mdx`), render
  // the editorial title & frontmatter cleanly at the top of the document!
  const extMeta = islandCfg.pageMetadata;
  if (
    !renderedInlineHeader &&
    extMeta &&
    extMeta.source === "sibling_page_tsx" &&
    (extMeta.title || extMeta.description || extMeta.date || extMeta.tags.length > 0)
  ) {
    const firstH1 = findNextHeading1(doc, 1);
    const displayTitle =
      extMeta.title &&
      firstH1 &&
      firstH1.toLowerCase() === extMeta.title.toLowerCase()
        ? null
        : extMeta.title;
    marksAndLines.push(
      Decoration.widget({
        widget: new PageHeaderWidget(
          displayTitle,
          extMeta.description,
          extMeta.date,
          extMeta.tags,
          null,
          "page.tsx",
        ),
        side: -1,
        block: true,
      }).range(0),
    );
  }

  const isInHiddenMdx = (start: number, end: number) =>
    mdxHiddenRanges.some(([mFrom, mTo]) => start < mTo && end > mFrom);

  // 4. Display & inline KaTeX math
  const mathRanges: Array<[number, number]> = [];
  const displayMathRe = /\$\$([\s\S]+?)\$\$/g;
  for (const m of text.matchAll(displayMathRe)) {
    if (m.index === undefined) continue;
    const mFrom = m.index;
    const mTo = mFrom + m[0].length;
    if (isInCode(mFrom, mTo) || isInHiddenMdx(mFrom, mTo)) continue;
    mathRanges.push([mFrom, mTo]);
    if (
      !selectionTouches(state, mFrom, mTo) &&
      !activeOverlayTouches(state, mFrom, mTo)
    ) {
      replacements.push({
        from: mFrom,
        to: mTo,
        deco: Decoration.replace({
          widget: new KatexWidget(m[1].trim(), true),
        }),
      });
    }
  }

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$") continue;
    if (i > 0 && text[i - 1] === "\\") continue;
    if (text[i + 1] === "$" || !text[i + 1] || /\s/.test(text[i + 1])) continue;

    let close = -1;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") {
        j++;
        continue;
      }
      if (text[j] === "\n") break;
      if (text[j] === "$") {
        const prevWs = /\s/.test(text[j - 1]);
        const nextDigit = j + 1 < text.length && /\d/.test(text[j + 1]);
        if (!prevWs && !nextDigit) {
          close = j + 1;
        }
        break;
      }
    }

    if (close > i + 2) {
      const mFrom = i;
      const mTo = close;
      if (
        !isInCode(mFrom, mTo) &&
        !isInHiddenMdx(mFrom, mTo) &&
        !mathRanges.some(([dFrom, dTo]) => mFrom < dTo && mTo > dFrom)
      ) {
        mathRanges.push([mFrom, mTo]);
        if (
          !selectionTouches(state, mFrom, mTo) &&
          !activeOverlayTouches(state, mFrom, mTo)
        ) {
          replacements.push({
            from: mFrom,
            to: mTo,
            deco: Decoration.replace({
              widget: new KatexWidget(text.slice(mFrom + 1, mTo - 1), false),
            }),
          });
        }
      }
      i = close - 1;
    }
  }

  // 5. Inline footnote references (`[^1]`, not followed by `:`)
  const fnRefRe = /\[\^([^\]]+)\](?!:)/g;
  for (const m of text.matchAll(fnRefRe)) {
    if (m.index === undefined) continue;
    const fFrom = m.index;
    const fTo = fFrom + m[0].length;
    if (
      isInCode(fFrom, fTo) ||
      isInHiddenMdx(fFrom, fTo) ||
      mathRanges.some(([mFrom, mTo]) => fFrom < mTo && fTo > mFrom)
    ) {
      continue;
    }
    const label = m[1];
    if (!footnoteFirstRef.has(label)) {
      footnoteFirstRef.set(label, fFrom);
    }
    if (!selectionTouches(state, fFrom, fTo)) {
      const def = footnoteDefs.get(label);
      replacements.push({
        from: fFrom,
        to: fTo,
        deco: Decoration.replace({
          widget: new FootnoteRefWidget(
            label,
            def?.offset ?? null,
            def?.body ?? null,
          ),
        }),
      });
    }
  }

  // Patch footnote definition back-links now that `footnoteFirstRef` is populated.
  for (let i = 0; i < replacements.length; i++) {
    const r = replacements[i];
    const w = r.deco.spec.widget;
    if (w instanceof FootnoteDefLabelWidget) {
      const lineText = text.slice(r.from, r.to);
      const m = /^\[\^([^\]]+)\]:/.exec(lineText);
      if (m) {
        const backOffset = footnoteFirstRef.get(m[1]) ?? null;
        if (backOffset !== null) {
          replacements[i] = {
            ...r,
            deco: Decoration.replace({
              widget: new FootnoteDefLabelWidget(m[1], backOffset),
            }),
          };
        }
      }
    }
  }

  // 6. Fallback compact pills for any remaining uppercase JSX tags (e.g. when islands are toggled off)
  const jsxRe = /<(\/?)([A-Z][A-Za-z0-9._-]*)(\s[^>]*?)?\/?>/g;
  for (const m of text.matchAll(jsxRe)) {
    if (m.index === undefined) continue;
    const jFrom = m.index;
    const jTo = jFrom + m[0].length;
    if (
      isInCode(jFrom, jTo) ||
      isInHiddenMdx(jFrom, jTo) ||
      mathRanges.some(([mFrom, mTo]) => jFrom < mTo && jTo > mFrom)
    ) {
      continue;
    }
    if (!selectionTouches(state, jFrom, jTo)) {
      replacements.push({
        from: jFrom,
        to: jTo,
        deco: Decoration.replace({
          widget: new JsxPillWidget(m[2], m[1] === "/"),
        }),
      });
    }
  }

  replacements.sort((a, b) => a.from - b.from || b.to - a.to);
  const finalRanges: Array<Range<Decoration>> = [...marksAndLines];
  let lastReplaceEnd = -1;
  for (const r of replacements) {
    if (r.from < lastReplaceEnd || r.to <= r.from) continue;
    lastReplaceEnd = r.to;
    finalRanges.push(r.deco.range(r.from, r.to));
  }

  return Decoration.set(finalRanges, true);
}

export const livePreviewPlugin = StateField.define<DecorationSet>({
  create(state) {
    return buildLivePreviewDecorations(state);
  },
  update(value, tr) {
    const prevCfg = tr.startState.facet(mdxIslandConfigFacet);
    const nextCfg = tr.state.facet(mdxIslandConfigFacet);
    const prevDiff = tr.startState.field(diffOverlayField, false);
    const nextDiff = tr.state.field(diffOverlayField, false);
    if (
      tr.docChanged ||
      tr.selection ||
      prevCfg !== nextCfg ||
      prevDiff !== nextDiff
    ) {
      return buildLivePreviewDecorations(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
