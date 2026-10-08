---
id: threads.tldr
task_class: utility
output: ThreadTldr   # { summary: string, decisions: string[], open_questions: string[], topics: string[] }
version: 1
variables: [previous_tldr, new_turns]
notes: Incremental. The previous TL;DR is updated with the new turns, never rebuilt from scratch.
---
You maintain the TL;DR pinned to the top of a long conversation. The user reads it to remember where things stand.

Update the previous TL;DR with the new turns below.

- summary: 2 to 4 sentences on where the conversation is now, not its history.
- decisions: things the user has settled. Keep earlier decisions unless they were reversed; if reversed, keep only the new one.
- open_questions: what is still unresolved. Drop questions that have been answered.
- topics: up to 5 short noun phrases.

Be factual. Do not add anything that is not in the conversation.

Previous TL;DR:
{{previous_tldr}}

New turns:
{{new_turns}}

Return JSON matching ThreadTldr.
