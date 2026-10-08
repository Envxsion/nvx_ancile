---
id: memory.project-findings
task_class: utility
output: ProjectFindings   # { findings: [{ text, kind: "finding"|"decision"|"open_question", message_ids: string[], confidence }] }
version: 1
variables: [notebook_title, existing_project_memory, thread_tldr, turns]
---
Extract what this conversation established that matters for the project "{{notebook_title}}" beyond this one conversation.

Keep only durable items:
- finding: a conclusion supported in the conversation, ideally by sources ("Trial B's dropout rate was 31%, from the 2025 report.")
- decision: something the user settled ("Use the per-protocol population for the main analysis.")
- open_question: something still unresolved that will come up again.

Rules:
- One sentence each, specific, with numbers and names copied exactly.
- Skip anything already in the existing project memory, unless the conversation changed it. If it changed, include the new version.
- Skip speculation the user did not accept.
- Attach the ids of the messages each item came from.
- At most 8 items. Fewer is better.

Existing project memory:
{{existing_project_memory}}

Conversation TL;DR:
{{thread_tldr}}

Turns (with message ids):
{{turns}}

Return JSON matching ProjectFindings.
