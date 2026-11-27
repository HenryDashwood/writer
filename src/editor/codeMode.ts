import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  HighlightStyle,
  indentUnit,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { highlightActiveLine, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { livePreviewPlugin } from "./livePreview";

/**
 * Editorial syntax palette driven by CSS variables in `styles.css` so it adapts
 * cleanly to both warm-paper light mode and dark mode (and styles fenced code
 * blocks inside `.md`/`.mdx` files as well as standalone code files).
 */
export const writerHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-keyword)", fontWeight: "500" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.variableName, t.self], color: "var(--ink)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--syn-punct)" },
]);

/**
 * Language descriptors passed to `@codemirror/lang-markdown` so fenced code blocks
 * (```ts, ```python, ```rust, etc.) inside `.md`/`.mdx` files are highlighted too.
 */
const fencedCodeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "mjs", "cjs"],
    support: javascript(),
  }),
  LanguageDescription.of({
    name: "JSX",
    alias: ["jsx"],
    support: javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "mts"],
    support: javascript({ typescript: true }),
  }),
  LanguageDescription.of({
    name: "TSX",
    alias: ["tsx"],
    support: javascript({ typescript: true, jsx: true }),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py", "python"],
    support: python(),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs", "rust"],
    support: rust(),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css"],
    support: css(),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json", "jsonc"],
    support: json(),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["html", "xml", "svg"],
    support: html(),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yaml", "yml"],
    support: yaml(),
  }),
];

export interface DocumentModeInfo {
  isCode: boolean;
  label: string;
}

function extensionOf(filePath: string | null): string {
  if (!filePath) return "mdx";
  const base = filePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function getDocumentModeInfo(filePath: string | null): DocumentModeInfo {
  const ext = extensionOf(filePath);
  switch (ext) {
    case "":
    case "md":
    case "markdown":
      return { isCode: false, label: "Markdown" };
    case "mdx":
      return { isCode: false, label: "MDX" };
    case "ts":
    case "mts":
    case "cts":
      return { isCode: true, label: "TypeScript" };
    case "tsx":
      return { isCode: true, label: "TSX" };
    case "js":
    case "mjs":
    case "cjs":
      return { isCode: true, label: "JavaScript" };
    case "jsx":
      return { isCode: true, label: "JSX" };
    case "rs":
      return { isCode: true, label: "Rust" };
    case "py":
      return { isCode: true, label: "Python" };
    case "css":
    case "scss":
      return { isCode: true, label: "CSS" };
    case "json":
    case "jsonc":
      return { isCode: true, label: "JSON" };
    case "html":
    case "svg":
      return { isCode: true, label: "HTML" };
    case "yml":
    case "yaml":
      return { isCode: true, label: "YAML" };
    case "toml":
      return { isCode: true, label: "TOML" };
    default:
      return { isCode: true, label: ext.toUpperCase() || "Plain Text" };
  }
}

function languageExtensionFor(ext: string): Extension {
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "rs":
      return rust();
    case "py":
      return python();
    case "css":
    case "scss":
      return css();
    case "json":
    case "jsonc":
      return json();
    case "html":
    case "svg":
      return html();
    case "yml":
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

/**
 * Returns the complete CodeMirror language + visual mode extension bundle for
 * either a prose Markdown/MDX document or a source-code file.
 */
export function extensionsForFile(
  filePath: string | null,
  forceSourceMode = false,
): Extension {
  const ext = extensionOf(filePath);
  const { isCode } = getDocumentModeInfo(filePath);

  if (!isCode && !forceSourceMode) {
    return [
      markdown({
        base: markdownLanguage,
        codeLanguages: fencedCodeLanguages,
      }),
      syntaxHighlighting(writerHighlightStyle),
      livePreviewPlugin,
    ];
  }

  const langExt = !isCode
    ? markdown({
        base: markdownLanguage,
        codeLanguages: fencedCodeLanguages,
      })
    : languageExtensionFor(ext);

  return [
    langExt,
    syntaxHighlighting(writerHighlightStyle),
    lineNumbers(),
    highlightActiveLine(),
    bracketMatching(),
    indentUnit.of("  "),
  ];
}
