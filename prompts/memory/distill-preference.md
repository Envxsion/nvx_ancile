---
id: memory.distill-preference
task_class: utility
output: MemoryCandidate   # { text: string, target: "USER.md"|"PROJECTS/{notebook}.md", section: string, confidence: number }
version: 1
variables: [statement, scope, notebook_slug, evidence]
---
Turn a detected preference into one memory entry.

Rules for the entry text:
- One sentence, present tense, third person, at most 20 words: "Prefers tables over long lists when comparing options."
- General enough to apply next time, specific enough to act on. "Likes good writing" is useless; "Wants a one-line summary before any detail" is useful.
- No dates, no reference to this conversation, no hedging.
- If the evidence shows the preference applies only in a context, include the context: "In code reviews, wants severity before explanation."

target: USER.md for scope "user", PROJECTS/{{notebook_slug}}.md for scope "notebook".
section: an existing heading in that file if one fits (Preferences, Writing, Code, Tools), otherwise "Preferences".

Statement: {{statement}}
Scope: {{scope}}
Evidence from the conversation:
{{evidence}}

Return JSON matching MemoryCandidate.
