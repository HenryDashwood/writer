use serde::{Deserialize, Serialize};

/// Category of non-prose region in a `.md` or `.mdx` file that AI prose passes
/// must not modify unless the user explicitly targets it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpanKind {
    Frontmatter,
    Import,
    Export,
    CodeFence,
    InlineCode,
    DisplayMath,
    InlineMath,
    JsxTag,
}

/// A protected byte + UTF-16 range inside a document.
///
/// Rust indexes strings by UTF-8 bytes, while JavaScript and CodeMirror 6 index
/// strings by UTF-16 code units. Storing both prevents off-by-one highlights on
/// Unicode characters like em-dashes (`—`) and curly quotes (`’`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtectedSpan {
    pub kind: SpanKind,
    pub byte_start: usize,
    pub byte_end: usize,
    pub utf16_start: usize,
    pub utf16_end: usize,
}

/// Converts a UTF-8 byte offset (which must lie on a char boundary) into a
/// UTF-16 code-unit offset for JavaScript / CodeMirror 6.
pub fn byte_to_utf16(doc: &str, byte_offset: usize) -> usize {
    doc[..byte_offset].encode_utf16().count()
}

/// Converts a UTF-16 code-unit offset (from JavaScript / CodeMirror 6) back into
/// a valid UTF-8 byte offset inside `doc`.
pub fn utf16_to_byte(doc: &str, utf16_offset: usize) -> usize {
    let mut seen_utf16 = 0usize;
    for (byte_idx, ch) in doc.char_indices() {
        if seen_utf16 >= utf16_offset {
            return byte_idx;
        }
        seen_utf16 += ch.len_utf16();
    }
    doc.len()
}

/// Scans a Markdown/MDX document and returns all non-prose protected spans,
/// sorted by `byte_start`.
pub fn scan_protected_spans(doc: &str) -> Vec<ProtectedSpan> {
    let mut raw_spans: Vec<(SpanKind, usize, usize)> = Vec::new();
    let bytes = doc.as_bytes();
    let len = bytes.len();
    let mut pos = 0;

    // 1. Optional YAML frontmatter at the very start of the document.
    if doc.starts_with("---\n") || doc.starts_with("---\r\n") {
        let first_nl = doc.find('\n').unwrap_or(3) + 1;
        if let Some(end) = find_frontmatter_end(doc, first_nl) {
            raw_spans.push((SpanKind::Frontmatter, 0, end));
            pos = end;
        }
    }

    // 2. Scan block-level and inline constructs in a single forward pass.
    while pos < len {
        let at_line_start = pos == 0 || bytes[pos - 1] == b'\n';

        if at_line_start {
            // Fenced code blocks: ``` or ~~~ (with up to 3 leading spaces)
            if let Some((fence_char, fence_len, line_end)) = match_code_fence(&doc[pos..]) {
                let end = find_closing_fence(doc, pos + line_end, fence_char, fence_len);
                raw_spans.push((SpanKind::CodeFence, pos, end));
                pos = end;
                continue;
            }

            // Display math block starting on its own line: $$ ... $$
            if let Some(end) = match_display_math(doc, pos) {
                raw_spans.push((SpanKind::DisplayMath, pos, end));
                pos = end;
                continue;
            }

            // Top-level ESM `import ...` statement
            if is_esm_import_start(&doc[pos..]) {
                let end = find_esm_statement_end(doc, pos);
                raw_spans.push((SpanKind::Import, pos, end));
                pos = end;
                continue;
            }

            // Top-level ESM `export ...` statement (e.g. `export const metadata = { ... };`)
            if is_esm_export_start(&doc[pos..]) {
                let end = find_esm_statement_end(doc, pos);
                raw_spans.push((SpanKind::Export, pos, end));
                pos = end;
                continue;
            }
        }

        // Inline constructs
        match bytes[pos] {
            b'`' => {
                if let Some(end) = match_inline_code(doc, pos) {
                    raw_spans.push((SpanKind::InlineCode, pos, end));
                    pos = end;
                    continue;
                }
            }
            b'$' => {
                if let Some(end) = match_display_math(doc, pos) {
                    raw_spans.push((SpanKind::DisplayMath, pos, end));
                    pos = end;
                    continue;
                }
                if let Some(end) = match_inline_math(doc, pos) {
                    raw_spans.push((SpanKind::InlineMath, pos, end));
                    pos = end;
                    continue;
                }
            }
            b'<' => {
                if let Some(end) = match_jsx_tag(doc, pos) {
                    raw_spans.push((SpanKind::JsxTag, pos, end));
                    pos = end;
                    continue;
                }
            }
            _ => {}
        }

        // Advance by one full UTF-8 character.
        let ch = doc[pos..].chars().next().unwrap();
        pos += ch.len_utf8();
    }

    // Convert byte ranges to UTF-16 offsets in a single O(n) pass.
    attach_utf16_offsets(doc, raw_spans)
}

/// Returns the first protected span overlapping `[byte_start, byte_end)`, if any.
pub fn overlaps_protected(
    spans: &[ProtectedSpan],
    byte_start: usize,
    byte_end: usize,
) -> Option<&ProtectedSpan> {
    spans
        .iter()
        .find(|s| byte_start < s.byte_end && byte_end > s.byte_start)
}

fn attach_utf16_offsets(
    doc: &str,
    mut raw_spans: Vec<(SpanKind, usize, usize)>,
) -> Vec<ProtectedSpan> {
    raw_spans.sort_by_key(|&(_, start, _)| start);

    // Precompute prefix UTF-16 counts only at the offsets we need by walking once.
    let mut result = Vec::with_capacity(raw_spans.len());
    let mut cursor_byte = 0;
    let mut cursor_utf16 = 0;

    for (kind, byte_start, byte_end) in raw_spans {
        let utf16_start = if byte_start >= cursor_byte {
            cursor_utf16 + doc[cursor_byte..byte_start].encode_utf16().count()
        } else {
            // Fallback for any nested/overlapping edge case.
            byte_to_utf16(doc, byte_start)
        };
        let span_utf16_len = doc[byte_start..byte_end].encode_utf16().count();
        let utf16_end = utf16_start + span_utf16_len;
        cursor_byte = byte_end;
        cursor_utf16 = utf16_end;

        result.push(ProtectedSpan {
            kind,
            byte_start,
            byte_end,
            utf16_start,
            utf16_end,
        });
    }

    result
}

fn find_frontmatter_end(doc: &str, mut pos: usize) -> Option<usize> {
    while pos < doc.len() {
        let line_end = doc[pos..]
            .find('\n')
            .map(|i| pos + i + 1)
            .unwrap_or(doc.len());
        let trimmed = doc[pos..line_end].trim_end_matches(['\r', '\n']);
        if trimmed == "---" || trimmed == "..." {
            return Some(line_end);
        }
        pos = line_end;
    }
    None
}

fn match_code_fence(slice: &str) -> Option<(u8, usize, usize)> {
    let bytes = slice.as_bytes();
    let mut i = 0;
    while i < bytes.len() && i < 3 && bytes[i] == b' ' {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    let ch = bytes[i];
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let start = i;
    while i < bytes.len() && bytes[i] == ch {
        i += 1;
    }
    let count = i - start;
    if count < 3 {
        return None;
    }
    let line_end = slice.find('\n').map(|n| n + 1).unwrap_or(slice.len());
    // CommonMark: backtick info strings cannot contain backticks.
    if ch == b'`' && slice[i..line_end].contains('`') {
        return None;
    }
    Some((ch, count, line_end))
}

fn find_closing_fence(doc: &str, mut pos: usize, fence_char: u8, min_len: usize) -> usize {
    while pos < doc.len() {
        let line_end = doc[pos..]
            .find('\n')
            .map(|i| pos + i + 1)
            .unwrap_or(doc.len());
        let line = doc[pos..line_end].trim_end_matches(['\r', '\n']);
        let trimmed_start = line.trim_start_matches(' ');
        let leading_spaces = line.len() - trimmed_start.len();
        if leading_spaces <= 3 {
            let count = trimmed_start
                .bytes()
                .take_while(|&b| b == fence_char)
                .count();
            if count >= min_len && trimmed_start[count..].trim().is_empty() {
                return line_end;
            }
        }
        pos = line_end;
    }
    doc.len()
}

fn is_esm_import_start(slice: &str) -> bool {
    slice.starts_with("import ") || slice.starts_with("import{") || slice.starts_with("import\"") || slice.starts_with("import'")
}

fn is_esm_export_start(slice: &str) -> bool {
    slice.starts_with("export ")
}

/// Scans an ESM `import` or `export` statement across balanced braces/parens/brackets
/// and string literals until the closing line terminator.
fn find_esm_statement_end(doc: &str, start: usize) -> usize {
    let bytes = doc.as_bytes();
    let len = bytes.len();
    let mut pos = start;
    let mut brace_depth: usize = 0;
    let mut paren_depth: usize = 0;
    let mut bracket_depth: usize = 0;
    let mut in_string: Option<u8> = None;

    while pos < len {
        let b = bytes[pos];
        if let Some(quote) = in_string {
            if b == b'\\' && pos + 1 < len {
                pos += 2;
                continue;
            }
            if b == quote {
                in_string = None;
            }
            pos += 1;
            continue;
        }

        match b {
            b'\'' | b'"' | b'`' => in_string = Some(b),
            b'{' => brace_depth += 1,
            b'}' => brace_depth = brace_depth.saturating_sub(1),
            b'(' => paren_depth += 1,
            b')' => paren_depth = paren_depth.saturating_sub(1),
            b'[' => bracket_depth += 1,
            b']' => bracket_depth = bracket_depth.saturating_sub(1),
            b'\n' if brace_depth == 0 && paren_depth == 0 && bracket_depth == 0 => {
                return pos + 1;
            }
            _ => {}
        }
        pos += 1;
    }
    len
}

fn match_inline_code(doc: &str, start: usize) -> Option<usize> {
    let bytes = doc.as_bytes();
    let mut ticks = 0;
    while start + ticks < bytes.len() && bytes[start + ticks] == b'`' {
        ticks += 1;
    }
    let mut pos = start + ticks;
    while pos < bytes.len() {
        // Inline code does not span across blank lines.
        if bytes[pos] == b'\n' && pos + 1 < bytes.len() && bytes[pos + 1] == b'\n' {
            return None;
        }
        if bytes[pos] == b'`' {
            let mut close_ticks = 0;
            while pos + close_ticks < bytes.len() && bytes[pos + close_ticks] == b'`' {
                close_ticks += 1;
            }
            if close_ticks == ticks {
                return Some(pos + close_ticks);
            }
            pos += close_ticks;
            continue;
        }
        pos += 1;
    }
    None
}

fn match_display_math(doc: &str, start: usize) -> Option<usize> {
    let bytes = doc.as_bytes();
    if !doc[start..].starts_with("$$") {
        return None;
    }
    if start > 0 && bytes[start - 1] == b'\\' {
        return None;
    }
    let mut pos = start + 2;
    while pos + 1 < bytes.len() {
        if bytes[pos] == b'\\' {
            pos += 2;
            continue;
        }
        if bytes[pos] == b'$' && bytes[pos + 1] == b'$' {
            return Some(pos + 2);
        }
        pos += 1;
    }
    None
}

fn match_inline_math(doc: &str, start: usize) -> Option<usize> {
    let bytes = doc.as_bytes();
    if bytes[start] != b'$' {
        return None;
    }
    if start > 0 && bytes[start - 1] == b'\\' {
        return None;
    }
    if start + 1 >= bytes.len() || bytes[start + 1] == b'$' {
        return None;
    }
    // Avoid matching "$ 5" (space right after opening $).
    if bytes[start + 1].is_ascii_whitespace() {
        return None;
    }

    let mut pos = start + 1;
    while pos < bytes.len() {
        let b = bytes[pos];
        if b == b'\\' && pos + 1 < bytes.len() {
            pos += 2;
            continue;
        }
        // Inline math does not cross blank lines.
        if b == b'\n' && pos + 1 < bytes.len() && bytes[pos + 1] == b'\n' {
            return None;
        }
        if b == b'$' {
            // Closing $ must not be preceded by whitespace or immediately followed by a digit
            // (which avoids false positives on currency like "$5 and $10").
            let prev_is_ws = bytes[pos - 1].is_ascii_whitespace();
            let next_is_digit = pos + 1 < bytes.len() && bytes[pos + 1].is_ascii_digit();
            if !prev_is_ws && !next_is_digit {
                return Some(pos + 1);
            }
            return None;
        }
        pos += 1;
    }
    None
}

/// Matches an individual JSX/HTML tag token such as `<PhaseVisual />`,
/// `<LocalImage src="..." alt="..." />`, `<details>`, or `</details>`.
///
/// Intentionally protects the tag tokens themselves rather than swallowing
/// prose placed between opening and closing tags (like inside `<details>`).
fn match_jsx_tag(doc: &str, start: usize) -> Option<usize> {
    let bytes = doc.as_bytes();
    if bytes[start] != b'<' || start + 1 >= bytes.len() {
        return None;
    }

    let mut pos = start + 1;
    if bytes[pos] == b'/' {
        pos += 1;
    }
    if pos >= bytes.len() || !bytes[pos].is_ascii_alphabetic() {
        return None;
    }

    // Tag name: letters, digits, '.', '-', '_', ':'
    while pos < bytes.len()
        && (bytes[pos].is_ascii_alphanumeric()
            || matches!(bytes[pos], b'.' | b'-' | b'_' | b':'))
    {
        pos += 1;
    }

    // Immediately after tag name we must see whitespace, '/', or '>'.
    if pos >= bytes.len()
        || !(bytes[pos].is_ascii_whitespace() || bytes[pos] == b'/' || bytes[pos] == b'>')
    {
        return None;
    }

    // Scan attributes, respecting strings and `{ ... }` JSX expressions.
    let mut brace_depth: usize = 0;
    let mut in_string: Option<u8> = None;

    while pos < bytes.len() {
        let b = bytes[pos];
        if let Some(quote) = in_string {
            if b == b'\\' && pos + 1 < bytes.len() {
                pos += 2;
                continue;
            }
            if b == quote {
                in_string = None;
            }
            pos += 1;
            continue;
        }

        match b {
            b'\'' | b'"' => in_string = Some(b),
            b'{' => brace_depth += 1,
            b'}' => brace_depth = brace_depth.saturating_sub(1),
            b'>' if brace_depth == 0 => return Some(pos + 1),
            b'\n' if brace_depth == 0 && pos + 1 < bytes.len() && bytes[pos + 1] == b'\n' => {
                // Never swallow past a blank line on an unclosed '<'.
                return None;
            }
            _ => {}
        }
        pos += 1;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_real_mdx_constructs_and_leaves_prose_unprotected() {
        let doc = r#"import PhaseVisual from "./_components/PhaseVisual";

export const metadata = {
  title: "Vocoders",
  tags: ["AI"],
};

Each frequency bin is a complex number $a + bi$, with length $\sqrt{a^2 + b^2}$.

<details>
<summary>More detail</summary>

This prose inside details should stay editable, and costs $5 or $10.

</details>

<PhaseVisual mode="demo" count={3} />

```python
import torch
x = 1 < 2
```
"#;

        let spans = scan_protected_spans(doc);
        let kinds: Vec<SpanKind> = spans.iter().map(|s| s.kind).collect();
        assert_eq!(
            kinds,
            vec![
                SpanKind::Import,
                SpanKind::Export,
                SpanKind::InlineMath,
                SpanKind::InlineMath,
                SpanKind::JsxTag, // <details>
                SpanKind::JsxTag, // <summary>
                SpanKind::JsxTag, // </summary>
                SpanKind::JsxTag, // </details>
                SpanKind::JsxTag, // <PhaseVisual ... />
                SpanKind::CodeFence,
            ]
        );

        // Prose inside <details> (including "$5 or $10") must NOT be protected.
        let prose = "This prose inside details should stay editable, and costs $5 or $10.";
        let prose_start = doc.find(prose).unwrap();
        assert!(overlaps_protected(&spans, prose_start, prose_start + prose.len()).is_none());

        // The `<PhaseVisual ... />` tag MUST be protected.
        let jsx = r#"<PhaseVisual mode="demo" count={3} />"#;
        let jsx_start = doc.find(jsx).unwrap();
        assert_eq!(
            overlaps_protected(&spans, jsx_start, jsx_start + jsx.len())
                .unwrap()
                .kind,
            SpanKind::JsxTag
        );
    }

    #[test]
    fn computes_accurate_utf16_offsets_across_unicode() {
        // Em-dash `—` is 3 UTF-8 bytes, 1 UTF-16 code unit.
        // Emoji `🎵` is 4 UTF-8 bytes, 2 UTF-16 code units.
        let doc = "Wave — 🎵 $x + y$ end";
        let spans = scan_protected_spans(doc);
        assert_eq!(spans.len(), 1);
        let math = &spans[0];
        assert_eq!(&doc[math.byte_start..math.byte_end], "$x + y$");
        // "Wave " (5) + "—" (1) + " " (1) + "🎵" (2) + " " (1) = 10 UTF-16 code units
        assert_eq!(math.utf16_start, 10);
        assert_eq!(math.utf16_end, 17);
    }
}
