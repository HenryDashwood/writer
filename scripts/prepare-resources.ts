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

// 1. Bundle the MDX sidecar into a single standalone JS file for Bun.
const buildRes = await Bun.build({
  entrypoints: [path.join(ROOT, "sidecar", "mdx-server.ts")],
  outdir: SIDECAR_OUT_DIR,
  naming: "mdx-server.mjs",
  target: "bun",
  minify: false,
});

if (!buildRes.success) {
  for (const log of buildRes.logs) {
    console.error(log);
  }
  process.exit(1);
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
