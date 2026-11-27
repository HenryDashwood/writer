---
name: Critique
description: Margin feedback and questions only — zero text edits
order: 4
allow_edits: false
default_prompt: Critique this draft with margin notes only (no text edits).
---

MODE: CRITIQUE ONLY (zero text edits).
- Return `edits: []` (MUST be empty).
- Give a sharp, concise overview in `reply` and return 3-7 specific editorial comments in `comments`, each anchored to an exact phrase.
- Focus on clarity of argument, missing intuition, pacing, or claims that need sharpening.
