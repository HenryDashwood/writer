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
- **MDX renderer**: Local Bun sidecar (`sidecar/mdx-server.ts`). Packaged builds include the runtime and React dependencies for MDX previews without a separate Bun installation.

## Development & Building

Prerequisites: [Bun](https://bun.sh) 1.4.4 or later and Rust (`1.97`, pinned via `rust-toolchain.toml`).

```bash
bun install

# Run in development mode
bun run tauri:dev

# Build frontend and resources, then run Rust unit tests
bun run build:bundle
cargo test --manifest-path src-tauri/Cargo.toml

# Build standalone macOS app and install to /Applications/Writer.app
bun run install:app

# Build a local macOS disk image for testing
bun run tauri:dmg
```

## macOS releases

Writer releases target Apple Silicon. The Apple Developer Account Holder must issue a Developer ID Application certificate. For local signing, install the certificate and its matching private key in your login Keychain. Use Apple's [app-specific password page](https://account.apple.com) and store the notarisation credentials interactively, then build the release image.

```bash
xcrun notarytool store-credentials Writer-notary
bun run release:macos
```

The command prints the path to the signed, notarised and verified DMG under `src-tauri/target/distribution/verified/`. Set `APPLE_SIGNING_IDENTITY` to the full Developer ID Application identity if several are installed.

For GitHub Actions, set these repository secrets in **Settings → Secrets and variables → Actions**.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` export containing the Developer ID Application certificate and private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password on the `.p12` export |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple Account email, app-specific password and the certificate team's ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the updater private key matching the public key in `src-tauri/tauri.conf.json` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password on the updater key, if it has one |

Keep a backup of the updater private key. Installed copies verify updates with the matching public key. For a new version, bump `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and refresh `src-tauri/Cargo.lock`. Push the matching `vX.Y.Z` tag. The workflow verifies the installer and stages it, the signed updater archive and `latest.json` in a GitHub draft release. Publish the draft as the latest release to make the update available in Writer.

Writer checks for updates on launch. Check manually from **Writer → Check for Updates…** or **Settings → Editor & Theme → Software updates**. You choose when to install and restart.

## API Keys & Secrets

- Never commit `.env` (already gitignored). See `.env.example` for optional local variables (`PANGRAM_API_KEY`, `ANTHROPIC_API_KEY`).
- In the app, paste keys under **Settings → Models & Keys (`⌘,`)** — they are stored outside any git repository in `~/Library/Application Support/com.henrydashwood.writer/secrets.json` (`0600` permissions).

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md) — Architecture, edit protocol, Live Preview & MDX design notes.
