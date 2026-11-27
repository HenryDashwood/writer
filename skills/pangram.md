---
name: Pangram AI Check
description: Scan document with Pangram and highlight AI-flagged sections
order: 5
allow_edits: false
runner: pangram
default_prompt: Scan this draft with Pangram for AI-generated or AI-assisted sections.
---

Runs Pangram Labs text detection on the prose of the current document (skipping frontmatter, imports, JSX tags, and fenced code blocks) and highlights every window flagged as AI-Generated or AI-Assisted directly in the editor.

Configure your Pangram API key in Settings → Models & Keys, or via `PANGRAM_API_KEY` in `.env`.
