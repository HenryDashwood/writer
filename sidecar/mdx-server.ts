import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { compile as compileMdx } from "@mdx-js/mdx";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

const WRITER_ROOT = path.resolve(import.meta.dir, "..");
const WRITER_NODE_MODULES = path.join(WRITER_ROOT, "node_modules");

interface ProjectInfo {
  root: string | null;
  publicDir: string | null;
  globalsCssPath: string | null;
  mdxComponentsPath: string | null;
  tsconfigPaths: Record<string, string[]>;
  nodeModulesDirs: string[];
}

// Live unsaved editor buffers keyed by absolute file path.
const liveBuffers = new Map<string, string>();
// Compiled JS bundles served by `/bundle.js?id=...`.
const bundleCache = new Map<string, string>();
// Compiled CSS cache keyed by `<projectRoot>:<mtimeMs>`.
const cssCache = new Map<string, string>();
// Track the most recently active `public/` directory for root-relative `/media/...` fetches.
let activePublicDir: string | null = null;
let bundleSeq = 0;

function parseArgs(): { port: number } {
  let port = 0;
  for (let i = 0; i < Bun.argv.length; i++) {
    if (Bun.argv[i] === "--port" && Bun.argv[i + 1]) {
      const parsed = Number.parseInt(Bun.argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed >= 0) port = parsed;
    }
  }
  return { port };
}

function readJsonLoose(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    // Strip simple `//` comments and trailing commas commonly found in tsconfig.json.
    const cleaned = raw
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectProject(filePath: string): ProjectInfo {
  let dir = path.dirname(path.resolve(filePath));
  let root: string | null = null;

  for (let depth = 0; depth < 20; depth++) {
    if (
      fs.existsSync(path.join(dir, "package.json")) ||
      fs.existsSync(path.join(dir, "tsconfig.json"))
    ) {
      root = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const nodeModulesDirs: string[] = [];
  let publicDir: string | null = null;
  let globalsCssPath: string | null = null;
  let mdxComponentsPath: string | null = null;
  let tsconfigPaths: Record<string, string[]> = {};

  if (root) {
    const projectNm = path.join(root, "node_modules");
    if (fs.existsSync(projectNm)) nodeModulesDirs.push(projectNm);

    const pub = path.join(root, "public");
    if (fs.existsSync(pub)) publicDir = pub;

    for (const cssCandidate of [
      "src/app/globals.css",
      "app/globals.css",
      "src/styles/globals.css",
    ]) {
      const p = path.join(root, cssCandidate);
      if (fs.existsSync(p)) {
        globalsCssPath = p;
        break;
      }
    }

    for (const mdxCandidate of [
      "src/mdx-components.tsx",
      "src/mdx-components.ts",
      "mdx-components.tsx",
      "mdx-components.ts",
    ]) {
      const p = path.join(root, mdxCandidate);
      if (fs.existsSync(p)) {
        mdxComponentsPath = p;
        break;
      }
    }

    const tsconfig = readJsonLoose(path.join(root, "tsconfig.json"));
    const compilerOptions = tsconfig?.compilerOptions as
      | { paths?: Record<string, string[]> }
      | undefined;
    if (compilerOptions?.paths) {
      tsconfigPaths = compilerOptions.paths;
    }
  }

  nodeModulesDirs.push(WRITER_NODE_MODULES);

  if (publicDir) {
    activePublicDir = publicDir;
  }

  return {
    root,
    publicDir,
    globalsCssPath,
    mdxComponentsPath,
    tsconfigPaths,
    nodeModulesDirs,
  };
}

function resolveWithExtensions(basePath: string): string | null {
  const candidates = [
    basePath,
    `${basePath}.tsx`,
    `${basePath}.ts`,
    `${basePath}.jsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.jsx"),
    path.join(basePath, "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const NEXT_IMAGE_SHIM = `
import React from "react";
export default function Image({ src, alt = "", width, height, fill, priority, unoptimized, quality, placeholder, blurDataURL, loader, sizes, style, className, ...rest }) {
  const resolvedSrc = typeof src === "string" ? src : (src && typeof src === "object" && "src" in src ? src.src : "");
  const mergedStyle = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...style }
    : { maxWidth: "100%", height: "auto", ...style };
  return React.createElement("img", { src: resolvedSrc, alt, width: fill ? undefined : width, height: fill ? undefined : height, className, style: mergedStyle, loading: priority ? "eager" : "lazy", ...rest });
}
`;

const NEXT_LINK_SHIM = `
import React from "react";
export default function Link({ href, children, prefetch, replace, scroll, shallow, passHref, legacyBehavior, locale, ...rest }) {
  const url = typeof href === "string" ? href : (href?.pathname || "#");
  return React.createElement("a", { href: url, target: url.startsWith("http") ? "_blank" : undefined, rel: url.startsWith("http") ? "noreferrer" : undefined, ...rest }, children);
}
`;

const NEXT_NAVIGATION_SHIM = `
export function usePathname() { return "/"; }
export function useSearchParams() { return new URLSearchParams(); }
export function useParams() { return {}; }
export function useRouter() {
  return { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
}
export function notFound() { return null; }
export function redirect() { return null; }
`;

function createBundlerPlugin(
  project: ProjectInfo,
  virtualFiles: Map<string, { contents: string; loader: "tsx" | "jsx" | "ts" | "js" }>,
): Bun.BunPlugin {
  // Always resolve React from a single node_modules root to prevent duplicate-React hook crashes.
  const reactRoot =
    project.nodeModulesDirs.find((nm) =>
      fs.existsSync(path.join(nm, "react/package.json")),
    ) ?? WRITER_NODE_MODULES;
  const reactRequire = createRequire(path.join(reactRoot, "package.json"));

  return {
    name: "writer-mdx-resolver",
    setup(build) {
      // 1. Virtual entrypoints (compiled MDX or single-component island)
      build.onResolve({ filter: /^writer-virtual:/ }, (args) => ({
        path: args.path,
        namespace: "writer-virtual",
      }));
      build.onLoad({ filter: /.*/, namespace: "writer-virtual" }, (args) => {
        const entry = virtualFiles.get(args.path);
        if (!entry) throw new Error(`Missing virtual module: ${args.path}`);
        return { contents: entry.contents, loader: entry.loader };
      });

      // 2. Next.js shims
      build.onResolve({ filter: /^next\/(image|link|navigation)$/ }, (args) => ({
        path: args.path,
        namespace: "writer-next-shim",
      }));
      build.onLoad({ filter: /.*/, namespace: "writer-next-shim" }, (args) => {
        if (args.path === "next/image") {
          return { contents: NEXT_IMAGE_SHIM, loader: "js" };
        }
        if (args.path === "next/link") {
          return { contents: NEXT_LINK_SHIM, loader: "js" };
        }
        return { contents: NEXT_NAVIGATION_SHIM, loader: "js" };
      });

      // 3. Pin React & ReactDOM to a single copy so hooks never mismatch.
      build.onResolve(
        { filter: /^react(-dom)?(\/.*)?$/ },
        (args) => {
          try {
            return { path: reactRequire.resolve(args.path) };
          } catch {
            return undefined;
          }
        },
      );

      // 4. tsconfig.json path aliases (e.g. `@/components/viz` -> `<root>/src/components/viz.tsx`)
      if (project.root && Object.keys(project.tsconfigPaths).length > 0) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          for (const [pattern, targets] of Object.entries(project.tsconfigPaths)) {
            if (pattern.endsWith("/*")) {
              const prefix = pattern.slice(0, -1);
              if (args.path.startsWith(prefix)) {
                const rest = args.path.slice(prefix.length);
                for (const target of targets) {
                  const targetBase = target.endsWith("/*")
                    ? target.slice(0, -1)
                    : target;
                  const candidate = path.resolve(
                    project.root!,
                    targetBase + rest,
                  );
                  const resolved = resolveWithExtensions(candidate);
                  if (resolved) return { path: resolved };
                }
              }
            } else if (args.path === pattern) {
              for (const target of targets) {
                const resolved = resolveWithExtensions(
                  path.resolve(project.root!, target),
                );
                if (resolved) return { path: resolved };
              }
            }
          }
          return undefined;
        });
      }
    },
  };
}

/**
 * Extracts top-level ESM `import ...` statements from an MDX file so an inline
 * component island can render a single `<Component />` tag with all its imports intact.
 */
function extractTopLevelImports(source: string): string {
  const lines = source.split("\n");
  const imports: string[] = [];
  let inFence = false;
  let collecting = false;
  let current = "";
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (!collecting && /^import\s/.test(trimmed)) {
      collecting = true;
      current = line;
      braceDepth =
        (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (braceDepth <= 0 && /from\s+["'][^"']+["']/.test(line)) {
        imports.push(current);
        collecting = false;
        current = "";
      } else if (braceDepth <= 0 && /^import\s+["'][^"']+["']/.test(trimmed)) {
        imports.push(current);
        collecting = false;
        current = "";
      }
      continue;
    }

    if (collecting) {
      current += `\n${line}`;
      braceDepth +=
        (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (braceDepth <= 0 && /from\s+["'][^"']+["']/.test(line)) {
        imports.push(current);
        collecting = false;
        current = "";
      }
    }
  }

  return imports.join("\n");
}

function getDocumentSource(filePath: string): string {
  const normalized = path.resolve(filePath);
  const buffered = liveBuffers.get(normalized);
  if (buffered !== undefined) return buffered;
  return fs.readFileSync(normalized, "utf8");
}

function rewriteRelativeImportsToAbsolute(
  code: string,
  sourceDir: string,
): string {
  // Rewrite `from "./..."` / `from "../..."` in virtual compiled MDX modules
  // so Bun.build resolves them relative to the original `.mdx` directory.
  return code.replace(
    /(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (_match, prefix: string, rel: string, suffix: string) => {
      const abs = path.resolve(sourceDir, rel);
      const resolved = resolveWithExtensions(abs) ?? abs;
      return `${prefix}${resolved}${suffix}`;
    },
  );
}

function extractFullPreviewHeader(
  filePath: string,
  rawMdx: string,
): { title?: string; description?: string; date?: string; tags?: string[] } | null {
  const parseJsMeta = (src: string) => {
    const idx = src.indexOf("export const metadata");
    if (idx < 0) return null;
    const slice = src.slice(idx, idx + 2000);
    const title = /title\s*:\s*["']([^"']+)["']/.exec(slice)?.[1];
    const description = /description\s*:\s*["']([^"']+)["']/.exec(slice)?.[1];
    const date = /(?:published|created|date)\s*:\s*["']([^"']+)["']/.exec(slice)?.[1];
    const tagsBlock = /tags\s*:\s*\[([^\]]*)\]/.exec(slice)?.[1] ?? "";
    const tags = Array.from(tagsBlock.matchAll(/["']([^"']+)["']/g)).map((m) => m[1]);
    if (!title && !description && !date && tags.length === 0) return null;
    return { title, description, date, tags };
  };

  const inline = parseJsMeta(rawMdx);
  if (inline) return inline;

  // YAML frontmatter
  if (rawMdx.startsWith("---\n")) {
    const end = rawMdx.indexOf("\n---", 4);
    if (end > 0) {
      const fm = rawMdx.slice(4, end);
      const title = /^title\s*:\s*["']?([^"'\n]+)["']?/m.exec(fm)?.[1]?.trim();
      const description = /^(?:description|subtitle)\s*:\s*["']?([^"'\n]+)["']?/m.exec(fm)?.[1]?.trim();
      const date = /^(?:date|published|created)\s*:\s*["']?([^"'\n]+)["']?/m.exec(fm)?.[1]?.trim();
      if (title || description || date) return { title, description, date, tags: [] };
    }
  }

  // Sibling Next.js `page.tsx`
  const siblingPage = path.join(path.dirname(filePath), "page.tsx");
  if (fs.existsSync(siblingPage)) {
    try {
      return parseJsMeta(fs.readFileSync(siblingPage, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

async function bundleMdxDocument(
  filePath: string,
  mode: "full" | "island",
  islandJsx?: string,
  islandId?: string,
): Promise<{ js: string; project: ProjectInfo }> {
  const absFile = path.resolve(filePath);
  const sourceDir = path.dirname(absFile);
  const project = detectProject(absFile);
  const rawMdx = getDocumentSource(absFile);

  let mdxSource = rawMdx;
  if (mode === "island") {
    const imports = extractTopLevelImports(rawMdx);
    mdxSource = `${imports}\n\n${islandJsx ?? ""}\n`;
  } else if (mdxSource.startsWith("---\n")) {
    // Strip YAML frontmatter in full MDX preview so it doesn't render as plain text.
    const fmEnd = mdxSource.indexOf("\n---", 4);
    if (fmEnd > 0) {
      const after = mdxSource.indexOf("\n", fmEnd + 4);
      mdxSource = after > 0 ? mdxSource.slice(after + 1) : "";
    }
  }

  const pageHeader =
    mode === "full" ? extractFullPreviewHeader(absFile, rawMdx) : null;

  const compiled = await compileMdx(mdxSource, {
    jsx: false,
    development: false,
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [rehypeSlug, rehypeKatex],
  });

  const compiledJs = rewriteRelativeImportsToAbsolute(
    String(compiled),
    sourceDir,
  );

  const mdxComponentsImport = project.mdxComponentsPath
    ? `import { useMDXComponents } from ${JSON.stringify(project.mdxComponentsPath)};`
    : `const useMDXComponents = (c) => c;`;

  const entryCode = `
import React from "react";
import { createRoot } from "react-dom/client";
import MDXContent from "writer-virtual:mdx";
${mdxComponentsImport}

class PreviewErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return React.createElement(
        "div",
        { className: "writer-preview-error" },
        React.createElement("strong", null, "Component render error: "),
        String(this.state.error?.message || this.state.error)
      );
    }
    return this.props.children;
  }
}

const PAGE_HEADER = ${JSON.stringify(pageHeader)};

function App() {
  const components = useMDXComponents({});
  const headerEl = PAGE_HEADER
    ? React.createElement(
        "header",
        { className: "writer-full-header" },
        PAGE_HEADER.title ? React.createElement("h1", null, PAGE_HEADER.title) : null,
        PAGE_HEADER.description ? React.createElement("p", { className: "writer-full-desc" }, PAGE_HEADER.description) : null,
        (PAGE_HEADER.date || (PAGE_HEADER.tags && PAGE_HEADER.tags.length > 0))
          ? React.createElement(
              "div",
              { className: "writer-full-meta" },
              PAGE_HEADER.date ? React.createElement("span", null, PAGE_HEADER.date) : null,
              ...(PAGE_HEADER.tags || []).map((tag) =>
                React.createElement("span", { key: tag, className: "writer-full-tag" }, tag)
              )
            )
          : null
      )
    : null;
  return React.createElement(
    PreviewErrorBoundary,
    null,
    React.createElement(
      "div",
      { className: ${JSON.stringify(mode === "island" ? "writer-island-root" : "prose-content writer-full-root")} },
      headerEl,
      React.createElement(MDXContent, { components })
    )
  );
}

const mountEl = document.getElementById("root");
if (mountEl) {
  createRoot(mountEl).render(React.createElement(App));
}

${
  mode === "island"
    ? `
// Post live height updates to Writer's CodeMirror inline widget whenever content resizes,
// images finish loading, or <details> disclosures open/close.
const islandId = ${JSON.stringify(islandId ?? "")};
function reportHeight() {
  const el = document.getElementById("root");
  if (!el) return;
  const h = Math.ceil(el.getBoundingClientRect().height);
  if (h > 0) {
    window.parent.postMessage({ type: "writer-island-height", id: islandId, height: h }, "*");
  }
}
const ro = new ResizeObserver(reportHeight);
if (mountEl) ro.observe(mountEl);
document.addEventListener("toggle", () => requestAnimationFrame(reportHeight), true);
document.addEventListener("load", (e) => {
  if (e.target && e.target.tagName === "IMG") reportHeight();
}, true);
window.addEventListener("load", reportHeight);
setTimeout(reportHeight, 60);
setTimeout(reportHeight, 250);
setTimeout(reportHeight, 600);
`
    : ""
}
`;

  const virtualFiles = new Map<
    string,
    { contents: string; loader: "tsx" | "jsx" | "ts" | "js" }
  >([
    ["writer-virtual:entry", { contents: entryCode, loader: "js" }],
    ["writer-virtual:mdx", { contents: compiledJs, loader: "js" }],
  ]);

  const result = await Bun.build({
    entrypoints: ["writer-virtual:entry"],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
    plugins: [createBundlerPlugin(project, virtualFiles)],
  });

  if (!result.success) {
    const details = result.logs.map((l) => l.message).join("\n");
    throw new Error(`MDX bundle failed:\n${details}`);
  }

  const js = await result.outputs[0].text();
  return { js, project };
}

/**
 * Compiles the project's `globals.css` via its installed `@tailwindcss/postcss` + `postcss`
 * when available, falling back to KaTeX CSS + clean built-in editorial styling.
 */
async function getStylesheet(project: ProjectInfo): Promise<string> {
  const katexCssCandidates = [
    path.join(import.meta.dir, "katex/katex.min.css"),
    ...project.nodeModulesDirs.map((nm) =>
      path.join(nm, "katex/dist/katex.min.css"),
    ),
    path.join(WRITER_NODE_MODULES, "katex/dist/katex.min.css"),
  ];
  const katexCssPath = katexCssCandidates.find((p) => fs.existsSync(p));
  const katexCss = katexCssPath ? fs.readFileSync(katexCssPath, "utf8") : "";

  const fallbackCss = `
${katexCss}
:root {
  --background: #faf8f4;
  --foreground: #1f1e1b;
  --color-background: #faf8f4;
  --color-foreground: #1f1e1b;
  --color-nav-background: #faad19;
  --color-chart-ink: #2d2a24;
  --color-chart-muted: #6b6458;
  --color-chart-hairline: #bdb09a;
  --color-chart-series-1: #2c5d8a;
  --color-chart-series-2: #a5481a;
  --font-source-serif: "Source Serif 4", "Iowan Old Style", Georgia, serif;
  --font-arizona-flare: "Source Serif 4", Georgia, serif;
  --font-mallory-book: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  --font-code: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-source-serif);
  -webkit-font-smoothing: antialiased;
}
.writer-full-root { max-width: 68ch; margin: 0 auto; padding: 28px 24px 80px; line-height: 1.7; font-size: 17.5px; }
.writer-island-root { padding: 4px 2px; }
.writer-island-root figure { margin-top: 8px !important; margin-bottom: 8px !important; }
.writer-preview-error { padding: 12px 14px; border-radius: 8px; background: #fdf0ee; border: 1px solid #f0c7c2; color: #963226; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; white-space: pre-wrap; }
`;

  if (!project.root || !project.globalsCssPath) {
    return fallbackCss;
  }

  const stat = fs.statSync(project.globalsCssPath);
  const cacheKey = `${project.root}:${stat.mtimeMs}`;
  const cached = cssCache.get(cacheKey);
  if (cached) return cached;

  try {
    const projectRequire = createRequire(path.join(project.root, "package.json"));
    const postcss = projectRequire("postcss") as (
      plugins: unknown[],
    ) => {
      process: (
        css: string,
        opts: { from: string },
      ) => Promise<{ css: string }>;
    };
    const tailwindPostcss = projectRequire("@tailwindcss/postcss") as (opts: {
      base: string;
    }) => unknown;

    const rawCss = fs.readFileSync(project.globalsCssPath, "utf8");
    const processed = await postcss([
      tailwindPostcss({ base: project.root }),
    ]).process(rawCss, { from: project.globalsCssPath });

    // Layer font variable defaults & clean iframe host overrides on top of the project's CSS.
    const combined = `
${katexCss}
${processed.css}
:root {
  --font-source-serif: "Source Serif 4", "Iowan Old Style", Georgia, serif;
  --font-arizona-flare: "Source Serif 4", Georgia, serif;
  --font-mallory-book: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  --font-code: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
}
body[data-mode="full"] {
  background: var(--writer-bg, var(--background, #faf8f4));
  color: var(--writer-fg, var(--foreground, #1f1e1b));
}
body[data-mode="island"] {
  background: transparent;
  overflow: hidden;
}
.writer-full-root {
  max-width: 68ch;
  margin: 0 auto;
  padding: 32px 24px 96px;
}
.writer-full-header {
  margin-bottom: 1.75rem;
}
.writer-full-header h1 {
  margin-top: 0 !important;
  margin-bottom: 0.5rem !important;
}
.writer-full-desc {
  margin: 0.25rem 0 0.75rem !important;
  color: var(--color-chart-muted, #6b6458);
  font-size: 1.05rem;
  line-height: 1.5;
}
.writer-full-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mallory-book);
  font-size: 0.82rem;
  color: var(--color-chart-muted, #6b6458);
}
.writer-full-tag {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--color-chart-hairline, #bdb09a);
  font-size: 0.75rem;
}
.writer-island-root {
  padding: 0;
}
.writer-island-root figure {
  margin-top: 0 !important;
  margin-bottom: 0 !important;
}
.writer-island-root details {
  margin-top: 0 !important;
  margin-bottom: 0 !important;
}
.writer-island-root > div.m-4 {
  margin: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}
body[data-theme="dark"] .text-gray-600 {
  color: #a9a296 !important;
}
.writer-preview-error {
  padding: 12px 14px;
  border-radius: 8px;
  background: #fdf0ee;
  border: 1px solid #f0c7c2;
  color: #963226;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12.5px;
  white-space: pre-wrap;
}
`;
    cssCache.clear();
    cssCache.set(cacheKey, combined);
    return combined;
  } catch (err) {
    console.error("Tailwind CSS compilation fallback:", err);
    return fallbackCss;
  }
}

function storeBundle(js: string): string {
  const id = `b_${++bundleSeq}`;
  bundleCache.set(id, js);
  // Keep memory bounded.
  if (bundleCache.size > 60) {
    const oldest = bundleCache.keys().next().value;
    if (oldest) bundleCache.delete(oldest);
  }
  return id;
}

function renderHtmlPage(opts: {
  mode: "full" | "island";
  bundleId: string;
  filePath: string;
  theme: string;
}): string {
  const styleUrl = `/styles.css?file=${encodeURIComponent(opts.filePath)}`;
  const scriptUrl = `/bundle.js?id=${encodeURIComponent(opts.bundleId)}`;
  const themeStyle =
    opts.theme === "dark"
      ? `--writer-bg: #191816; --writer-fg: #eae5dc; --color-background: #191816; --background: #191816; --color-foreground: #eae5dc; --foreground: #eae5dc; --color-link: #7ab3ff; --color-chart-ink: #eae5dc; --color-chart-muted: #9b9488; --color-chart-hairline: #49433a;`
      : `--writer-bg: #faf8f4; --writer-fg: #1f1e1b; --color-background: #faf8f4; --background: #faf8f4;`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUrl}" />
    <style>:root { ${themeStyle} }</style>
  </head>
  <body data-mode="${opts.mode}" data-theme="${opts.theme}">
    <div id="root"></div>
    <script type="module" src="${scriptUrl}"></script>
  </body>
</html>`;
}

function renderErrorHtml(message: string, mode: "full" | "island", islandId?: string): string {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      body { margin: 0; padding: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: transparent; }
      .err { padding: 10px 12px; border-radius: 8px; background: #fdf0ee; border: 1px solid #f0c7c2; color: #963226; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="root" class="err">${escaped}</div>
    ${
      mode === "island"
        ? `<script>
            const h = Math.ceil(document.getElementById("root").getBoundingClientRect().height) + 16;
            window.parent.postMessage({ type: "writer-island-height", id: ${JSON.stringify(islandId ?? "")}, height: h }, "*");
           </script>`
        : ""
    }
  </body>
</html>`;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const { port: requestedPort } = parseArgs();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: requestedPort,
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json(
        { ok: true, port: server.port },
        { headers: CORS_HEADERS },
      );
    }

    if (url.pathname === "/buffer" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          filePath?: string;
          content?: string;
        };
        if (!body.filePath || typeof body.content !== "string") {
          return Response.json(
            { error: "filePath and content required" },
            { status: 400, headers: CORS_HEADERS },
          );
        }
        const abs = path.resolve(body.filePath);
        liveBuffers.set(abs, body.content);
        detectProject(abs);
        return Response.json({ ok: true }, { headers: CORS_HEADERS });
      } catch (err) {
        return Response.json(
          { error: String(err) },
          { status: 400, headers: CORS_HEADERS },
        );
      }
    }

    if (url.pathname === "/styles.css") {
      const file = url.searchParams.get("file");
      const project = file
        ? detectProject(file)
        : {
            root: null,
            publicDir: activePublicDir,
            globalsCssPath: null,
            mdxComponentsPath: null,
            tsconfigPaths: {},
            nodeModulesDirs: [WRITER_NODE_MODULES],
          };
      const css = await getStylesheet(project);
      return new Response(css, {
        headers: {
          "Content-Type": "text/css; charset=utf-8",
          ...CORS_HEADERS,
        },
      });
    }

    if (url.pathname === "/bundle.js") {
      const id = url.searchParams.get("id") ?? "";
      const js = bundleCache.get(id);
      if (!js) {
        return new Response("Bundle expired", { status: 404 });
      }
      return new Response(js, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          ...CORS_HEADERS,
        },
      });
    }

    if (url.pathname === "/preview") {
      const file = url.searchParams.get("file");
      const theme = url.searchParams.get("theme") ?? "light";
      if (!file) {
        return new Response(renderErrorHtml("Missing `file` query parameter", "full"), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      try {
        const { js } = await bundleMdxDocument(file, "full");
        const bundleId = storeBundle(js);
        return new Response(
          renderHtmlPage({ mode: "full", bundleId, filePath: file, theme }),
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          },
        );
      } catch (err) {
        return new Response(renderErrorHtml(String(err), "full"), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/island") {
      const file = url.searchParams.get("file");
      const jsx = url.searchParams.get("jsx");
      const id = url.searchParams.get("id") ?? "";
      const theme = url.searchParams.get("theme") ?? "light";
      if (!file || !jsx) {
        return new Response(
          renderErrorHtml("Missing `file` or `jsx` query parameter", "island", id),
          {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
      try {
        const { js } = await bundleMdxDocument(file, "island", jsx, id);
        const bundleId = storeBundle(js);
        return new Response(
          renderHtmlPage({ mode: "island", bundleId, filePath: file, theme }),
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          },
        );
      } catch (err) {
        return new Response(renderErrorHtml(String(err), "island", id), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // Serve KaTeX font files referenced by katex.min.css (`fonts/KaTeX_*.woff2`).
    if (url.pathname.startsWith("/fonts/")) {
      const fontName = path.basename(url.pathname);
      const fontCandidates = [
        path.join(import.meta.dir, "katex/fonts", fontName),
        path.join(WRITER_NODE_MODULES, "katex/dist/fonts", fontName),
      ];
      const fontPath = fontCandidates.find((p) => fs.existsSync(p));
      if (fontPath) {
        return new Response(Bun.file(fontPath), { headers: CORS_HEADERS });
      }
    }

    // Serve static assets (e.g. `/media/...`, `/images/...`) from the active project's `public/`.
    if (activePublicDir) {
      const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const candidate = path.resolve(activePublicDir, relPath);
      if (
        candidate.startsWith(activePublicDir) &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile()
      ) {
        return new Response(Bun.file(candidate), {
          headers: {
            "Accept-Ranges": "bytes",
            ...CORS_HEADERS,
          },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

// Signal Rust supervisor that the sidecar is listening and ready.
console.log(`READY ${server.port}`);
