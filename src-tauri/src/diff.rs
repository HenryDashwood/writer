use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};

use crate::mdx_spans::{byte_to_utf16, overlaps_protected, scan_protected_spans, SpanKind};

/// Editorial category attached to every AI-proposed edit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditKind {
    Typo,
    Grammar,
    Conciseness,
    Clarity,
    Flow,
    Custom,
}

/// Raw structured edit returned by an LLM editing pass.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposedEdit {
    pub id: String,
    pub kind: EditKind,
    pub find: String,
    pub replace: String,
    #[serde(default)]
    pub context_before: Option<String>,
    #[serde(default)]
    pub context_after: Option<String>,
    pub rationale: String,
}

/// Token-level inline diff operation rendered inside the prose canvas.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiffOp {
    Equal,
    Delete,
    Insert,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiffToken {
    pub op: DiffOp,
    pub text: String,
}

/// A validated, anchored edit hunk ready for CodeMirror 6 to display inline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedHunk {
    pub id: String,
    pub kind: EditKind,
    pub byte_start: usize,
    pub byte_end: usize,
    pub utf16_start: usize,
    pub utf16_end: usize,
    pub original: String,
    pub replacement: String,
    pub rationale: String,
    pub tokens: Vec<DiffToken>,
}

/// Why a proposed edit from the LLM was safely discarded instead of corrupting text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RejectionReason {
    NoOp,
    EmptyAnchor,
    AnchorNotFound,
    AmbiguousAnchor,
    TouchesProtectedSpan { span_kind: SpanKind },
    OverlapsExistingHunk,
    OutsideAllowedRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RejectedEdit {
    pub id: String,
    pub reason: RejectionReason,
}

/// Constraints applied while validating proposed edits against a document.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolveOptions {
    /// Optional UTF-8 byte range restricting edits (e.g. a `Cmd+K` selection).
    pub allowed_byte_range: Option<(usize, usize)>,
    /// Allow edits that touch protected MDX/math/code spans (false by default).
    pub allow_protected_spans: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiffResolution {
    pub hunks: Vec<ResolvedHunk>,
    pub rejected: Vec<RejectedEdit>,
}

/// Raw editorial comment returned by a Critique pass (zero text mutations).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProposedComment {
    pub id: String,
    pub anchor: String,
    #[serde(default)]
    pub context_before: Option<String>,
    #[serde(default)]
    pub context_after: Option<String>,
    pub body: String,
}

/// Visual & semantic category for anchored margin highlights.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommentKind {
    #[default]
    Note,
    AiGenerated,
    AiAssisted,
}

/// A validated, anchored critique comment or AI-detection highlight ready to show in the editor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedComment {
    pub id: String,
    pub byte_start: usize,
    pub byte_end: usize,
    pub utf16_start: usize,
    pub utf16_end: usize,
    pub anchor: String,
    pub body: String,
    #[serde(default)]
    pub kind: CommentKind,
    #[serde(default)]
    pub label: Option<String>,
}

/// Resolves editorial comments against `doc`, discarding any whose anchor does not match.
pub fn resolve_comments(
    doc: &str,
    comments: Vec<ProposedComment>,
    allowed_byte_range: Option<(usize, usize)>,
) -> Vec<ResolvedComment> {
    let mut resolved = Vec::new();
    for comment in comments {
        if comment.anchor.is_empty() || comment.body.trim().is_empty() {
            continue;
        }
        if let Ok((byte_start, byte_end)) = resolve_anchor(
            doc,
            &comment.anchor,
            comment.context_before.as_deref(),
            comment.context_after.as_deref(),
            allowed_byte_range,
        ) {
            let utf16_start = byte_to_utf16(doc, byte_start);
            let utf16_end = utf16_start + comment.anchor.encode_utf16().count();
            resolved.push(ResolvedComment {
                id: comment.id,
                byte_start,
                byte_end,
                utf16_start,
                utf16_end,
                anchor: comment.anchor,
                body: comment.body,
                kind: CommentKind::Note,
                label: None,
            });
        }
    }
    resolved.sort_by_key(|c| c.byte_start);
    resolved
}

/// Validates and anchors a batch of proposed edits against `doc`, computing
/// UTF-16 offsets and word-level inline diff tokens for every accepted hunk.
pub fn resolve_edits(
    doc: &str,
    edits: Vec<ProposedEdit>,
    options: &ResolveOptions,
) -> DiffResolution {
    let protected = scan_protected_spans(doc);
    let mut hunks: Vec<ResolvedHunk> = Vec::new();
    let mut rejected: Vec<RejectedEdit> = Vec::new();

    for edit in edits {
        if edit.find.is_empty() {
            rejected.push(RejectedEdit {
                id: edit.id,
                reason: RejectionReason::EmptyAnchor,
            });
            continue;
        }
        if edit.find == edit.replace {
            rejected.push(RejectedEdit {
                id: edit.id,
                reason: RejectionReason::NoOp,
            });
            continue;
        }

        let (byte_start, byte_end) = match resolve_anchor(
            doc,
            &edit.find,
            edit.context_before.as_deref(),
            edit.context_after.as_deref(),
            options.allowed_byte_range,
        ) {
            Ok(range) => range,
            Err(reason) => {
                rejected.push(RejectedEdit {
                    id: edit.id,
                    reason,
                });
                continue;
            }
        };

        if !options.allow_protected_spans {
            if let Some(span) = overlaps_protected(&protected, byte_start, byte_end) {
                rejected.push(RejectedEdit {
                    id: edit.id,
                    reason: RejectionReason::TouchesProtectedSpan {
                        span_kind: span.kind,
                    },
                });
                continue;
            }
        }

        // Prevent overlapping hunks from corrupting each other during review.
        let overlaps = hunks
            .iter()
            .any(|existing| byte_start < existing.byte_end && byte_end > existing.byte_start);
        if overlaps {
            rejected.push(RejectedEdit {
                id: edit.id,
                reason: RejectionReason::OverlapsExistingHunk,
            });
            continue;
        }

        let utf16_start = byte_to_utf16(doc, byte_start);
        let utf16_end = utf16_start + edit.find.encode_utf16().count();
        let tokens = compute_word_diff(&edit.find, &edit.replace);

        hunks.push(ResolvedHunk {
            id: edit.id,
            kind: edit.kind,
            byte_start,
            byte_end,
            utf16_start,
            utf16_end,
            original: edit.find,
            replacement: edit.replace,
            rationale: edit.rationale,
            tokens,
        });
    }

    // Sort top-to-bottom so keyboard navigation steps naturally through the document.
    hunks.sort_by_key(|h| h.byte_start);

    DiffResolution { hunks, rejected }
}

/// Locates `needle` inside `doc` (optionally scoped to `allowed_range`),
/// disambiguating multiple occurrences via `context_before` / `context_after`.
fn resolve_anchor(
    doc: &str,
    needle: &str,
    context_before: Option<&str>,
    context_after: Option<&str>,
    allowed_range: Option<(usize, usize)>,
) -> Result<(usize, usize), RejectionReason> {
    let all_matches: Vec<(usize, usize)> = doc
        .match_indices(needle)
        .map(|(start, m)| (start, start + m.len()))
        .collect();

    if all_matches.is_empty() {
        return Err(RejectionReason::AnchorNotFound);
    }

    let candidates: Vec<(usize, usize)> = match allowed_range {
        Some((min, max)) => {
            let scoped: Vec<(usize, usize)> = all_matches
                .into_iter()
                .filter(|&(start, end)| start >= min && end <= max)
                .collect();
            if scoped.is_empty() {
                return Err(RejectionReason::OutsideAllowedRange);
            }
            scoped
        }
        None => all_matches,
    };

    if candidates.len() == 1 {
        return Ok(candidates[0]);
    }

    // Multiple occurrences: score each candidate against optional context hints.
    let mut best_score = 0usize;
    let mut best_candidates: Vec<(usize, usize)> = Vec::new();

    for &(start, end) in &candidates {
        let mut score = 0usize;

        if let Some(before) = context_before.map(str::trim).filter(|s| !s.is_empty()) {
            let prefix = doc[..start].trim_end();
            if prefix.ends_with(before) {
                score += before.len();
            }
        }

        if let Some(after) = context_after.map(str::trim).filter(|s| !s.is_empty()) {
            let suffix = doc[end..].trim_start();
            if suffix.starts_with(after) {
                score += after.len();
            }
        }

        if score > best_score {
            best_score = score;
            best_candidates.clear();
            best_candidates.push((start, end));
        } else if score == best_score && score > 0 {
            best_candidates.push((start, end));
        }
    }

    if best_candidates.len() == 1 {
        Ok(best_candidates[0])
    } else {
        Err(RejectionReason::AmbiguousAnchor)
    }
}

/// Computes a prose-friendly word/token-level inline diff between `old` and `new`.
///
/// Adjacent tokens with the same operation are coalesced so the UI renders clean,
/// readable runs rather than fragmented character spans.
pub fn compute_word_diff(old: &str, new: &str) -> Vec<DiffToken> {
    let old_tokens = tokenize_prose(old);
    let new_tokens = tokenize_prose(new);

    let diff = TextDiff::from_slices(&old_tokens, &new_tokens);
    let mut result: Vec<DiffToken> = Vec::new();

    for change in diff.iter_all_changes() {
        let op = match change.tag() {
            ChangeTag::Equal => DiffOp::Equal,
            ChangeTag::Delete => DiffOp::Delete,
            ChangeTag::Insert => DiffOp::Insert,
        };
        let piece = change.value();

        if let Some(last) = result.last_mut() {
            if last.op == op {
                last.text.push_str(piece);
                continue;
            }
        }

        result.push(DiffToken {
            op,
            text: piece.to_string(),
        });
    }

    result
}

/// Splits prose into words (keeping internal apostrophes like `we've`),
/// whitespace runs, and individual punctuation characters.
fn tokenize_prose(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut iter = text.char_indices().peekable();

    while let Some(&(start, ch)) = iter.peek() {
        if ch.is_whitespace() {
            let mut end = start;
            while let Some(&(idx, c)) = iter.peek() {
                if c.is_whitespace() {
                    end = idx + c.len_utf8();
                    iter.next();
                } else {
                    break;
                }
            }
            tokens.push(&text[start..end]);
        } else if ch.is_alphanumeric() {
            let mut end = start;
            while let Some(&(idx, c)) = iter.peek() {
                if c.is_alphanumeric() {
                    end = idx + c.len_utf8();
                    iter.next();
                } else if matches!(c, '\'' | '’') {
                    // Keep apostrophes inside contractions ("we've", "don’t"),
                    // but don't absorb a trailing closing single quote.
                    let after_idx = idx + c.len_utf8();
                    let next_is_alnum = text[after_idx..]
                        .chars()
                        .next()
                        .is_some_and(char::is_alphanumeric);
                    if next_is_alnum {
                        end = after_idx;
                        iter.next();
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            tokens.push(&text[start..end]);
        } else {
            let end = start + ch.len_utf8();
            iter.next();
            tokens.push(&text[start..end]);
        }
    }

    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_diff_isolates_single_typo_without_highlighting_punctuation() {
        let tokens = compute_word_diff(
            "it sounds identical to the orginal.",
            "it sounds identical to the original.",
        );
        assert_eq!(
            tokens,
            vec![
                DiffToken {
                    op: DiffOp::Equal,
                    text: "it sounds identical to the ".into(),
                },
                DiffToken {
                    op: DiffOp::Delete,
                    text: "orginal".into(),
                },
                DiffToken {
                    op: DiffOp::Insert,
                    text: "original".into(),
                },
                DiffToken {
                    op: DiffOp::Equal,
                    text: ".".into(),
                },
            ]
        );
    }

    #[test]
    fn word_diff_preserves_contractions_as_single_words() {
        let tokens = compute_word_diff("So we've thrown away", "So we have thrown away");
        assert_eq!(
            tokens,
            vec![
                DiffToken {
                    op: DiffOp::Equal,
                    text: "So ".into(),
                },
                DiffToken {
                    op: DiffOp::Delete,
                    text: "we've".into(),
                },
                DiffToken {
                    op: DiffOp::Insert,
                    text: "we have".into(),
                },
                DiffToken {
                    op: DiffOp::Equal,
                    text: " thrown away".into(),
                },
            ]
        );
    }

    #[test]
    fn resolves_real_prose_edits_and_blocks_protected_mdx_spans() {
        let doc = r#"import PhaseVisual from "./_components/PhaseVisual";

In the diagram below, it sounds identical to the orginal. Because it is.

<PhaseVisual />

This didn't happen with the with the steady sine waves.
"#;

        let edits = vec![
            ProposedEdit {
                id: "e1".into(),
                kind: EditKind::Typo,
                find: "with the with the steady".into(),
                replace: "with the steady".into(),
                context_before: None,
                context_after: None,
                rationale: "Remove duplicated words.".into(),
            },
            ProposedEdit {
                id: "e2".into(),
                kind: EditKind::Typo,
                find: "sounds identical to the orginal.".into(),
                replace: "sounds identical to the original.".into(),
                context_before: None,
                context_after: None,
                rationale: "Fix spelling.".into(),
            },
            ProposedEdit {
                id: "e3".into(),
                kind: EditKind::Clarity,
                find: "<PhaseVisual />".into(),
                replace: "<PhaseDiagram />".into(),
                context_before: None,
                context_after: None,
                rationale: "Should be blocked by MDX guard.".into(),
            },
        ];

        let res = resolve_edits(doc, edits, &ResolveOptions::default());

        // Accepted hunks are sorted top-to-bottom (e2 appears before e1 in the doc).
        assert_eq!(res.hunks.len(), 2);
        assert_eq!(res.hunks[0].id, "e2");
        assert_eq!(res.hunks[1].id, "e1");

        // JSX mutation was rejected cleanly.
        assert_eq!(res.rejected.len(), 1);
        assert_eq!(res.rejected[0].id, "e3");
        assert_eq!(
            res.rejected[0].reason,
            RejectionReason::TouchesProtectedSpan {
                span_kind: SpanKind::JsxTag
            }
        );
    }

    #[test]
    fn disambiguates_duplicate_anchors_with_context_and_rejects_ambiguous_ones() {
        let doc = "First paragraph has the word phase here. Second paragraph also has the word phase there.";

        let edits = vec![
            ProposedEdit {
                id: "disambiguated".into(),
                kind: EditKind::Clarity,
                find: "the word phase".into(),
                replace: "the phase angle".into(),
                context_before: Some("also has".into()),
                context_after: Some("there.".into()),
                rationale: "Be more specific.".into(),
            },
            ProposedEdit {
                id: "ambiguous".into(),
                kind: EditKind::Clarity,
                find: "the word phase".into(),
                replace: "phase".into(),
                context_before: None,
                context_after: None,
                rationale: "No context given.".into(),
            },
        ];

        let res = resolve_edits(doc, edits, &ResolveOptions::default());
        assert_eq!(res.hunks.len(), 1);
        assert_eq!(res.hunks[0].id, "disambiguated");
        assert!(res.hunks[0].byte_start > doc.find("Second").unwrap());

        assert_eq!(res.rejected.len(), 1);
        assert_eq!(res.rejected[0].id, "ambiguous");
        assert_eq!(res.rejected[0].reason, RejectionReason::AmbiguousAnchor);
    }

    #[test]
    fn enforces_allowed_range_for_selection_scoped_edits() {
        let doc = "Paragraph one has a typo. Paragraph two also has a typo.";
        let second_start = doc.find("Paragraph two").unwrap();

        let edits = vec![ProposedEdit {
            id: "out_of_scope".into(),
            kind: EditKind::Typo,
            find: "Paragraph one".into(),
            replace: "First paragraph".into(),
            context_before: None,
            context_after: None,
            rationale: "Outside user's Cmd+K selection.".into(),
        }];

        let res = resolve_edits(
            doc,
            edits,
            &ResolveOptions {
                allowed_byte_range: Some((second_start, doc.len())),
                allow_protected_spans: false,
            },
        );
        assert!(res.hunks.is_empty());
        assert_eq!(res.rejected[0].reason, RejectionReason::OutsideAllowedRange);
    }
}
