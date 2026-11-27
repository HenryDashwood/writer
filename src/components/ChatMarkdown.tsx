import type { ReactNode } from "react";
import katex from "katex";

function renderKatexHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
    });
  } catch {
    return tex;
  }
}

/**
 * Renders inline Markdown + KaTeX math (`$...$` and `\(...\)`) safely without
 * letting `_..._` italic rules mangle LaTeX subscripts like `X_{n+1}` or `X_n`.
 */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: inline code & math come BEFORE emphasis/links so underscores inside math stay untouched.
  const tokenRe =
    /(`[^`]+`|\$\$([\s\S]+?)\$\$|\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$|\\\((.+?)\\\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|~~([^~]+)~~|\*([^*]+)\*|\b_([^_\n]+)_\b)/g;

  let last = 0;
  let key = 0;

  for (const m of text.matchAll(tokenRe)) {
    if (m.index === undefined) continue;
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }

    const full = m[0];
    if (full.startsWith("`")) {
      nodes.push(
        <code key={key++} className="chat-inline-code">
          {full.slice(1, -1)}
        </code>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(
        <span
          key={key++}
          className="chat-math-block"
          dangerouslySetInnerHTML={{ __html: renderKatexHtml(m[2], true) }}
        />,
      );
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const tex = m[3] ?? m[4];
      nodes.push(
        <span
          key={key++}
          className="chat-math-inline"
          dangerouslySetInnerHTML={{ __html: renderKatexHtml(tex, false) }}
        />,
      );
    } else if (m[5] !== undefined && m[6] !== undefined) {
      nodes.push(
        <a
          key={key++}
          href={m[6]}
          target="_blank"
          rel="noreferrer"
          className="chat-link"
        >
          {m[5]}
        </a>,
      );
    } else if (m[7] !== undefined) {
      nodes.push(<strong key={key++}>{renderInline(m[7])}</strong>);
    } else if (m[8] !== undefined) {
      nodes.push(<del key={key++}>{renderInline(m[8])}</del>);
    } else if (m[9] !== undefined || m[10] !== undefined) {
      nodes.push(<em key={key++}>{m[9] ?? m[10]}</em>);
    }

    last = m.index + full.length;
  }

  if (last < text.length) {
    nodes.push(text.slice(last));
  }

  return nodes;
}

function splitTableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableDelimiter(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const elements: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. Fenced code block: ```lang ... ```
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      elements.push(
        <div key={key++} className="chat-code-block">
          {lang && <div className="chat-code-lang">{lang}</div>}
          <pre>
            <code>{codeLines.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }

    // 2. Display math block: $$...$$ (single-line or multi-line) or \[...\]
    if (trimmed.startsWith("$$")) {
      if (trimmed.length > 4 && trimmed.endsWith("$$")) {
        const tex = trimmed.slice(2, -2);
        elements.push(
          <div
            key={key++}
            className="chat-math-block"
            dangerouslySetInnerHTML={{ __html: renderKatexHtml(tex, true) }}
          />,
        );
        i++;
        continue;
      }
      const mathLines: string[] = [trimmed.slice(2)];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        const closeIdx = cur.indexOf("$$");
        if (closeIdx >= 0) {
          mathLines.push(cur.slice(0, closeIdx));
          i++;
          break;
        }
        mathLines.push(cur);
        i++;
      }
      elements.push(
        <div
          key={key++}
          className="chat-math-block"
          dangerouslySetInnerHTML={{
            __html: renderKatexHtml(mathLines.join("\n"), true),
          }}
        />,
      );
      continue;
    }

    if (trimmed.startsWith("\\[")) {
      const mathLines: string[] = [trimmed.slice(2)];
      if (trimmed.endsWith("\\]")) {
        const tex = trimmed.slice(2, -2);
        elements.push(
          <div
            key={key++}
            className="chat-math-block"
            dangerouslySetInnerHTML={{ __html: renderKatexHtml(tex, true) }}
          />,
        );
        i++;
        continue;
      }
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        const closeIdx = cur.indexOf("\\]");
        if (closeIdx >= 0) {
          mathLines.push(cur.slice(0, closeIdx));
          i++;
          break;
        }
        mathLines.push(cur);
        i++;
      }
      elements.push(
        <div
          key={key++}
          className="chat-math-block"
          dangerouslySetInnerHTML={{
            __html: renderKatexHtml(mathLines.join("\n"), true),
          }}
        />,
      );
      continue;
    }

    // 3. Heading: # / ## / ###
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      elements.push(
        <div key={key++} className={`chat-md-h chat-md-h${level}`}>
          {renderInline(heading[2])}
        </div>,
      );
      i++;
      continue;
    }

    // 4. Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      elements.push(<hr key={key++} className="chat-md-hr" />);
      i++;
      continue;
    }

    // 5. Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      elements.push(
        <blockquote key={key++} className="chat-md-quote">
          {renderInline(quoteLines.join(" "))}
        </blockquote>,
      );
      continue;
    }

    // 6. GFM Pipe Table
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableDelimiter(lines[i + 1])
    ) {
      const headers = splitTableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        lines[i].includes("|")
      ) {
        rows.push(splitTableCells(lines[i]));
        i++;
      }
      elements.push(
        <div key={key++} className="chat-table-scroll">
          <table className="chat-table">
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi}>{renderInline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {headers.map((_, ci) => (
                    <td key={ci}>{renderInline(row[ci] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 7. Bullet list
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ""));
        i++;
      }
      elements.push(
        <ul key={key++} className="chat-md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // 8. Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      elements.push(
        <ol key={key++} className="chat-md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // 9. Normal paragraph (stop on blank line or next block construct)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i].trim();
      if (
        !cur ||
        /^(`{3,}|~{3,})/.test(cur) ||
        cur.startsWith("$$") ||
        cur.startsWith("\\[") ||
        /^#{1,4}\s+/.test(cur) ||
        cur.startsWith(">") ||
        /^[-*•]\s+/.test(cur) ||
        /^\d+\.\s+/.test(cur)
      ) {
        break;
      }
      paraLines.push(cur);
      i++;
    }
    elements.push(
      <p key={key++} className="chat-md-p">
        {renderInline(paraLines.join(" "))}
      </p>,
    );
  }

  return <div className="chat-md">{elements}</div>;
}
