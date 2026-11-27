# Writer — Design Document

## 1. Problem & Core Principles

LLMs are useful editors when kept on a short leash and destructive when allowed to rewrite freely. This app aims to bring Cursor’s targeted diff-and-review loop to long-form prose and technical `.mdx` writing.

### Principles
1. **Surgical by construction:** The model never returns a rewritten document. It emits discrete, anchored edit operations with explicit rationales and categories.
2. **Prose-native diffs:** Code diffs operate line-by-line, which breaks down on 80-word paragraphs. Edits are diffed and displayed at word/token granularity directly inside the reading flow.
3. **Plain files on disk:** No proprietary database or vault format. Any folder (including a Next.js site repo) opens directly, and external edits from Obsidian, Typora, Dinkus, or `git` sync live.
4. **Zero serialization damage to `.mdx`:** `import` statements, `export const metadata`, JSX tags, code fences, and KaTeX stay byte-for-byte untouched unless explicitly edited.
5. **Fast, quiet Mac feel:** Native Tauri v2 shell using macOS `WKWebView` (~40–60 MB RAM vs. Electron), calm typography, and minimal chrome.
6. **Core logic in Rust:** Workspace management, file watching, protected-span detection, anchor matching, word-level diffing, and LLM provider orchestration live in Rust so the core is fast, testable, and cleanly decoupled from the UI.

### Non-Goals (for now)
- Multi-user collaboration or cloud sync (git/iCloud/local folders cover this).
- Replacing a full IDE for editing complex React components (Writer edits prose and renders `.mdx` components; heavy TSX coding stays in your code editor).
- Autonomous multi-file "agent" rewrites of whole posts without review.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Tauri v2 macOS App                           │
│                                                                     │
│  ┌───────────────────────────────┐  ┌────────────────────────────┐  │
│  │  WKWebView Frontend (TS/React)│  │    Rust Core (src-tauri)   │  │
│  │                               │  │                            │  │
│  │  • CodeMirror 6 Live Preview  │◀─┼─▶ workspace.rs (fs/tree)   │  │
│  │  • Inline Diff Decorations    │  │ • watcher.rs   (FSEvents)  │  │
│  │  • Floating Hunk Bar & Cmd+K  │  │ • mdx_spans.rs (locks)     │  │
│  │  • Minimal 3-Pane Chrome      │  │ • diff.rs      (anchors +  │  │
│  │  • MDX Preview / Islands (M2) │  │                 word diff) │  │
│  └──────────────┬────────────────┘  │ • llm.rs       (providers) │  │
│                 │                   │ • settings.rs  (config)    │  │
│                 │ (M2)              └──────────────┬─────────────┘  │
│                 ▼                                  │                │
│  ┌───────────────────────────────┐                 ▼                │
│  │  Bun MDX Sidecar (M2)         │  ┌────────────────────────────┐  │
│  │  • @mdx-js/mdx + remark/rehype│  │ LLM Backends               │  │
│  │  • Bundles ./_components/*.tsx│  │ • Claude CLI / Codex CLI   │  │
│  │  • Resolves @/ & Tailwind CSS │  │ • Anthropic / OpenAI API   │  │
│  └───────────────────────────────┘  └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Rust Core (`src-tauri/src/`)
Putting the domain engine in Rust gives strong types, easy unit testing on real `.mdx` files, and native OS integration:

- **`workspace.rs`**: Opens a folder, builds a filtered `.md`/`.mdx` tree (ignoring `node_modules`, `.next`, `.git`, `target`), reads/writes files atomically, extracts heading outlines, and discovers nearest `WRITER.md` style guides.
- **`watcher.rs`**: Uses `notify` (FSEvents on macOS) to watch the active workspace and emit events on external file modifications, suppressing echoes from our own saves.
- **`mdx_spans.rs`**: Lightweight scanner over `.md`/`.mdx` source that identifies **protected non-prose spans**:
  - Top-level ESM `import ...` and `export const metadata = ...` blocks
  - Fenced code blocks (` ``` ` / `~~~`)
  - Inline/block KaTeX math (`$...$` / `$$...$$`)
  - JSX component tags (`<PhaseVisual />`, `<LocalImage ... />`, etc.)
  
  Used both to inform the LLM what not to modify and as a hard guardrail when validating proposed edits.
- **`diff.rs`**:
  - Resolves each LLM `ProposedEdit` anchor against the current document into exact UTF-8 byte and UTF-16 code-unit offsets (matching CodeMirror 6’s indexing cleanly across Unicode, curly quotes, and em-dashes).
  - Disambiguates duplicate anchors using optional surrounding context (`context_before` / `context_after`); drops overlapping, stale, or protected-span-violating edits cleanly rather than corrupting text.
  - Computes **word/token-level inline diffs** (`Equal`, `Delete`, `Insert`) inside each hunk using a prose tokenizer (splitting words, whitespace, and punctuation cleanly so a single spelling or phrasing fix never highlights a whole sentence).
- **`llm.rs`**:
  - Defines an `EditProvider` trait so multiple backends share the exact same prompt, schema, and validation pipeline.
  - **Initial backend:** Start with the simplest reliable option first—either direct **Anthropic Messages API** via `reqwest` (fast, structured output, zero CLI overhead) or **`claude -p` CLI** (zero API key setup if already logged in)—and add the other (plus OpenAI / Codex CLI) behind the same trait.
- **`settings.rs`**: Stores recent workspaces, provider/model selection, typography preferences, and API keys (via macOS Keychain or local app config).

### Frontend (`src/`)
- **CodeMirror 6** as the single editing engine (no ProseMirror/TipTap AST round-trip).
- **Thin React shell** for the collapsible sidebar (file tree + outline), top status bar, right-hand review drawer, `Cmd+K` popover, and settings modal.

---

## 3. The Anti-Slop Editing Protocol

### Structured Output Schema
Every editing pass returns strict JSON—never free-form rewritten prose:

```json
{
  "edits": [
    {
      "id": "e1",
      "kind": "typo | grammar | conciseness | clarity | flow",
      "find": "exact substring from the document",
      "replace": "proposed replacement substring",
      "context_before": "optional 3-6 words immediately preceding `find`",
      "context_after": "optional 3-6 words immediately following `find`",
      "rationale": "One short sentence explaining why (<= 15 words)."
    }
  ],
  "comments": [
    {
      "id": "c1",
      "anchor": "exact substring being commented on",
      "body": "Editorial note or question for the author."
    }
  ]
}
```

### Touch-Level Modes
Each mode adjusts the system prompt’s restraint rules explicitly:

| Mode | Allowed changes | Strictly forbidden |
| --- | --- | --- |
| **Proofread** | Spelling, duplicated words, broken punctuation, objective grammar | Any rephrasing, tone shifts, word substitutions for style |
| **Tighten** | Remove filler, untangle awkward syntax, tighten wordy clauses | Changing voice, flattening rhetorical fragments, altering dialect (e.g. UK spelling) |
| **Line Edit** | Clarity, sentence rhythm, paragraph transitions, precision | Rewriting intact paragraphs from scratch, inserting generic AI phrasing |
| **Critique** | Anchored margin comments and structural questions only | Any entries in `edits[]` |
| **Custom (`Cmd+K`)** | Scoped to current selection (or cursor paragraph) following user prompt | Touching text outside the selected region |

### Voice Guide (`WRITER.md`)
If a workspace contains a `WRITER.md` file (at the root or any parent folder of the open file), its rules are injected into every pass—e.g. British spelling, preserving conversational fragments, domain terminology, and explicit banned clichés.

### Guardrails in Rust (Post-Model Validation)
Before any edit reaches the UI, `diff.rs` verifies:
1. `find != replace` (drop no-op edits).
2. `find` resolves unambiguously to an exact span in the current buffer.
3. No two accepted hunks overlap.
4. No edit mutates a protected span (imports, metadata export, JSX component tags, code fences, math) unless the user explicitly selected inside that span via `Cmd+K`.
5. Oversized-rewrite guard: optionally flag or warn if a single edit replaces an entire large paragraph in `Proofread` or `Tighten` mode.

---

## 4. Editor & Inline Diff UX

### Obsidian-Style Live Preview (CodeMirror 6)
The underlying buffer is always the exact `.md`/`.mdx` file. A CodeMirror 6 ViewPlugin hides Markdown syntax when the cursor/selection is outside an element and reveals raw syntax the moment the cursor enters it:

- **Prose formatting:** Headings (`#`–`####` scaled in serif/display typography), bold, italic, strikethrough, inline code, links, blockquotes, lists, horizontal rules.
- **Math:** Inline `$...$` and display `$$...$$` rendered with KaTeX when unfocused; raw LaTeX revealed on click/cursor entry.
- **Code blocks:** Styled monospace blocks with language label and syntax highlighting.
- **MDX elements (Milestone 1):**
  - Top-of-file `import` statements and `export const metadata = { ... }` fold into a quiet, expandable header strip so they don’t dominate the top of the page.
  - Self-closing / block JSX tags like `<PhaseVisual />` render as compact, unobtrusive component pills (`⬡ PhaseVisual`) when unfocused, revealing raw JSX on click. *(In Milestone 2, these upgrade to optional live rendered React component previews.)*

### Inline Word-Level Diff Overlay
Pending suggestions live in a dedicated CodeMirror `StateField` **overlay**—they never mutate the underlying document or dirty the file on disk until accepted. Because the overlay maps ranges through `tr.changes`, you can even keep typing elsewhere in the document while suggestions remain anchored accurately in place.

Visual & interaction model:
- **Inline tokens:** Inside each hunk’s range, unchanged words stay normal, removed words get a soft red tint + strikethrough, and inserted words appear inline as a soft green widget span right beside them.
- **Gutter markers:** A subtle colored bar in the left margin marks paragraphs with pending hunks (different subtle tint for `typo` vs. `clarity`/`flow`).
- **Focused hunk bar:** Clicking a hunk or stepping onto it opens a compact floating action pill showing the category tag, the 1-line rationale, and actions:
  - `Cmd+]` / `Cmd+[` (or `J` / `K` when in review mode) — next / previous hunk
  - `Cmd+Enter` / `Y` — **Accept** hunk (applies the exact replacement as a normal undoable editor transaction, then jumps to next hunk)
  - `Cmd+Backspace` / `N` — **Reject** hunk (dismisses overlay and jumps to next hunk)
  - `E` — **Accept & edit** (applies hunk and places cursor at the end to tweak manually)
- **Batch actions (right drawer):**
  - Pending edits grouped by category (`Typo (3)`, `Clarity (2)`, `Conciseness (1)`).
  - One-click **Accept all typos**, **Accept all**, or **Reject all**.
- **Undo safety:** Every accepted hunk is a standard CodeMirror undo step, and running a pass records a restore point so you can revert a whole review session cleanly.

### Layout (Minimal 3-Pane Chrome)
- **Left sidebar (collapsible, `Cmd+\`):** Folder switcher, `.md`/`.mdx` file tree, and clickable heading outline.
- **Center canvas:** 68ch reading column, generous whitespace, serif body typography (matching your writing style), subtle top bar with filename, unsaved dot, word count, and quick-pass button.
- **Right drawer (collapsible, `Cmd+Shift+L`):** Edit mode picker, Run Pass button, grouped hunk list / critique comments, and (in M2) a toggle to switch to **Live MDX Preview**.

---

## 5. MDX Rendering Strategy (Milestone 2)

A typical Next.js 16 + Bun + React 19 + Tailwind v4 website project has `.mdx` files that import colocated React components (`./_components/PhaseVisual`, etc.) depending on shared helpers (`@/components/viz`), global MDX mappings (`src/mdx-components.tsx`), Tailwind CSS tokens (`globals.css`), `remark-gfm`, `remark-math`, `rehype-katex`, and `rehype-pretty-code`.

Rendering these faithfully without turning Writer into a giant Next.js clone calls for a two-tier design:

1. **Local Bun MDX Compiler Sidecar (default, works offline without `next dev`):**
   - Watches the open `.mdx` file and its sibling `_components/` folder.
   - Compiles MDX via `@mdx-js/mdx` with `remark-gfm`, `remark-math`, `rehype-katex`, and Shiki.
   - Uses Bun’s native bundler (`Bun.build`) to bundle the compiled MDX + local `./_components/*.tsx` imports in ~10–30 ms, reading `tsconfig.json` path aliases (`@/*`) from the workspace root and shimming Next.js primitives (`next/image`, `next/link`) cleanly to local `public/` paths.
   - Compiles the workspace’s Tailwind CSS (or falls back to Writer’s clean built-in prose stylesheet for standalone Markdown folders outside a website repo).
   - Serves the compiled bundle to either a **synced split preview pane** or **inline component islands** embedded inside CodeMirror 6.
2. **Optional Live Dev-Server Preview:**
   - For repos with a running `next dev`, allow pointing the preview pane at the corresponding `localhost:3000/...` route for 100% production parity.

---

## 6. Incremental Milestones

### Milestone 1 — Core Native Editor + Surgical Diff Loop
**Goal:** Open `~/website` (or any Markdown folder), write comfortably in Obsidian-style Live Preview, run targeted AI passes, and accept/reject word-level inline diffs.
- [ ] Tauri v2 + Rust workspace scaffold (`rust-toolchain.toml` pinned to `1.97` so Cargo works cleanly alongside older default toolchains).
- [ ] Rust `workspace.rs` + `watcher.rs`: folder open, `.md`/`.mdx` tree, outline extraction, atomic save, FSEvents reload.
- [ ] Rust `mdx_spans.rs` + `diff.rs` with thorough unit tests on real `.mdx` prose, Unicode, protected spans, and word-level diffs.
- [ ] Rust `llm.rs`: `EditProvider` trait + first working provider (`claude` CLI or Anthropic API) + all 5 modes (`Proofread`, `Tighten`, `Line Edit`, `Critique`, `Cmd+K`) + `WRITER.md` support.
- [ ] CodeMirror 6 Live Preview (headings, inline formatting, lists, blockquotes, code blocks, KaTeX math, quiet collapsed MDX imports/metadata, JSX component pills).
- [ ] Inline word-level diff overlay, floating hunk bar, keyboard navigation (`Cmd+]`/`Cmd+[`, `Y`/`N`), category batch-accept, and `Cmd+K` selection bar.

### Milestone 2 — Live `.mdx` Component Rendering
**Goal:** See interactive React components (like `<PhaseVisual />` and `<GriffinLimDemo />`) live while editing `.mdx` files.
- [ ] Local Bun MDX/TSX bundler sidecar managed by Rust.
- [ ] Workspace detection for Next.js / Tailwind (`tsconfig.json` paths, `mdx-components.tsx`, `public/` media paths, `next/image` & `next/link` shims).
- [ ] Synchronized split MDX preview pane (scroll-synced with the editor) + optional inline component islands inside Live Preview.

### Milestone 3 — Writing Craft & Multi-Provider Polish
**Goal:** Make it a daily-driver writing environment.
- [ ] Additional LLM providers (Anthropic API, OpenAI API, Claude CLI, Codex CLI) + per-mode model selection (e.g. fast model for Proofread, frontier model for Line Edit/Critique).
- [ ] Critique-only margin annotations with "Turn comment into edit" action.
- [ ] Pass history / local snapshots + light/dark paper themes + distraction-free focus mode + custom font pairing.

---

## 7. Decisions to Confirm Before Milestone 1

1. **First LLM backend:** Start with **Claude CLI (`claude -p`)** (works immediately with your existing login, no API key needed, slightly slower cold start ~3–5s) or **direct Anthropic API** (faster streaming/latency, requires `ANTHROPIC_API_KEY`)? *(We’ll structure `llm.rs` around a trait so adding the second takes ~50 lines.)*
2. **App name / working title:** Stick with `writer` for now, or do you have a name in mind?
3. **Typography & theme default:** Light warm-paper default (like your website / iA Writer) with dark mode toggle, or dark-first?
