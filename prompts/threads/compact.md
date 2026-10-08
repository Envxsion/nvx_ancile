---
id: threads.compact
task_class: utility
output: text
version: 1
variables: [turns, keep_verbatim_after]
notes: >
  Produces the compaction summary that replaces older turns in context
  (DESIGN.md §8.4). It is keyed by upto_message_id and reused by every branch
  through that message, so it must not mention anything after it.
---
Compress the earlier part of a conversation so the model can continue it with a much smaller context. The most recent turns will follow your summary verbatim.

Preserve, in this order of priority:
1. The user's goal and any constraints they stated (formats, audiences, deadlines, things to avoid).
2. Decisions made and the reasons given for them.
3. Facts, numbers, names, file paths, code identifiers and URLs that later turns may depend on, copied exactly.
4. Work in progress: what has been drafted, what remains.
5. Corrections the user made to the assistant, and what was wrong.

Drop pleasantries, superseded drafts, and reasoning that led nowhere. Write in the third person ("The user wants…", "The assistant proposed…"). Use compact bullet points under short headings. Do not invent anything.

Conversation to compress:
{{turns}}
