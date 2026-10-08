---
type: models
scope: model
updated: 2026-10-07
---
# Model notes

One file per model, named after its id with `/` replaced by `__` (`anthropic__claude-sonnet-5-5.md`). NVX Ancile records quirks it learns in use: what a model refuses, formats it gets wrong, where it falls back. Only the file for the model actually answering is injected, after any fallback.

- Example: Tends to add a summary paragraph; ask it not to when the user prefers none. <!-- m:01J9Z5 conf:0.9 src:stats at:2026-10-07 -->
