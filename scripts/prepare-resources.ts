import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const RES_DIR = path.join(ROOT, "src-tauri", "resources");
const SIDECAR_OUT_DIR = path.join(RES_DIR, "sidecar");
const KATEX_OUT_DIR = path.join(SIDECAR_OUT_DIR, "katex");
const KATEX_FONTS_OUT_DIR = path.join(KATEX_OUT_DIR, "fonts");
const SKILLS_OUT_DIR = path.join(RES_DIR, "skills");

// Start clean so stale files are never bundled into Writer.app.
fs.rmSync(RES_DIR, { recursive: true, force: true });
fs.mkdirSync(KATEX_FONTS_OUT_DIR, { recursive: true });
fs.mkdirSync(SKILLS_OUT_DIR, { recursive: true });

// Tauri signs this executable as part of the app bundle.
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const sidecar = Bun.spawnSync([
  process.execPath,
  "build",
  "--compile",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--outfile",
  path.join(RES_DIR, `writer-mdx-${arch}-apple-darwin`),
  path.join(ROOT, "sidecar", "mdx-server.ts"),
], { stdout: "inherit", stderr: "inherit" });
if (sidecar.exitCode !== 0) process.exit(1);

// The browser bundler resolves React from the previewed project when available.
// Include a fallback for MDX files outside projects with installed dependencies.
for (const pkg of ["react", "react-dom", "scheduler"]) {
  fs.cpSync(
    path.join(ROOT, "node_modules", pkg),
    path.join(SIDECAR_OUT_DIR, "node_modules", pkg),
    { recursive: true, dereference: true },
  );
}

// 2. Copy KaTeX CSS + woff2 fonts for standalone math rendering in preview/islands.
const katexDist = path.join(ROOT, "node_modules", "katex", "dist");
const katexCss = path.join(katexDist, "katex.min.css");
if (fs.existsSync(katexCss)) {
  fs.copyFileSync(katexCss, path.join(KATEX_OUT_DIR, "katex.min.css"));
}
const katexFonts = path.join(katexDist, "fonts");
if (fs.existsSync(katexFonts)) {
  for (const name of fs.readdirSync(katexFonts)) {
    if (name.endsWith(".woff2")) {
      fs.copyFileSync(
        path.join(katexFonts, name),
        path.join(KATEX_FONTS_OUT_DIR, name),
      );
    }
  }
}

// 3. Copy built-in Markdown skills so packaged builds seed Application Support on first run.
const skillsSrc = path.join(ROOT, "skills");
if (fs.existsSync(skillsSrc)) {
  for (const name of fs.readdirSync(skillsSrc)) {
    if (name.endsWith(".md")) {
      fs.copyFileSync(
        path.join(skillsSrc, name),
        path.join(SKILLS_OUT_DIR, name),
      );
    }
  }
}

console.log("Prepared standalone Tauri resources in src-tauri/resources/");
