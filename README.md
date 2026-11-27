# Writer

A native macOS writing and editing environment for `.md` and `.mdx` files, designed to **preserve your voice and writing craft** alongside AI tools.

## Philosophy & Features

- **Craft-first AI modes (`Craft` · `Standard` · `Concise`)**: Inspired by Answer.AI’s *Solveit*, **`Craft`** mode keeps you as the author — Rust hard-enforces zero automatic prose rewrites, keeping the model to brief Socratic questions and anchored margin notes. Switch to `Standard` or `Concise` anytime when you want direct assistance.
- **Surgical, word-level inline diffs**: When you ask for edits (via `⌘K`, chat, or a `/skill`), changes render inline inside your prose (red strikethrough + green insertion). Rust validates every anchor and blocks uninvited edits to frontmatter, `import`/`export` statements, JSX tags, fenced code, and LaTeX math.
- **Dialogue Engineering & persistent workspace threads**: Conversations are scoped to your workspace (so you can switch files freely while agents explore other files read-only), persisted locally, and support **Pin**, **Hide from AI**, and inline **Edit** on every message.
- **File-based `/skills`**: Drop Markdown files into [`skills/`](skills/) (or `<workspace>/.writer/skills/`) and invoke them with `/` in chat — including `/proofread`, `/tighten`, `/line-edit`, `/critique`, `/socratic`, and `/pangram` (Pangram Labs AI-detection highlighting). Every skill prompt and base system prompt is inspectable and editable in **Settings (`⌘,`)**.
- **Obsidian-style Live Preview + live `.mdx` React components**: Plain `.md`/`.mdx` files on disk are the single source of truth (watched live via macOS FSEvents), with in-place rendering for headings, KaTeX math, GFM tables, clickable footnotes, code blocks, page metadata headers, and interactive colocated React `.mdx` components via a local Bun sidecar.
- **Local CLI backends**: Works out of the box with locally signed-in **Claude CLI (`claude`)**, **Antigravity CLI (`agy`)**, **Codex CLI (`codex`)**, or direct **Anthropic API**.

## Stack

- **Desktop shell & core engine**: Rust + Tauri v2 (`WKWebView`, FSEvents watcher, MDX span guardrails, anchor & word-diff engine, CLI orchestration, Pangram runner, local thread & secret storage)
- **Editor canvas**: TypeScript + React 19 + CodeMirror 6 (Live Preview + code syntax highlighting)
- **MDX renderer**: Local Bun sidecar (`sidecar/mdx-server.ts`, pre-bundled into `Writer.app` for standalone builds)

## Development & Building

Prerequisites: [Bun](https://bun.sh) and Rust (`1.97`, pinned via `rust-toolchain.toml`).

```bash
bun install

# Run in development mode
bun run tauri:dev

# Run frontend typecheck + build and Rust unit tests
bun run build
cargo test --manifest-path src-tauri/Cargo.toml

# Build standalone macOS app and install to /Applications/Writer.app
bun run install:app

# Build distributable macOS .dmg
bun run tauri:dmg
```

## API Keys & Secrets

- Never commit `.env` (already gitignored). See `.env.example` for optional local variables (`PANGRAM_API_KEY`, `ANTHROPIC_API_KEY`).
- In the app, paste keys under **Settings → Models & Keys (`⌘,`)** — they are stored outside any git repository in `~/Library/Application Support/com.henrydashwood.writer/secrets.json` (`0600` permissions).

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md) — Architecture, edit protocol, Live Preview & MDX design notes.
