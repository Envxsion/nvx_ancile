---
id: threads.branch-suggest
task_class: utility
output: BranchSuggestion   # { shift: boolean, confidence: number, new_topic: string, reason: string }
version: 1
variables: [recent_topics, new_message]
notes: >
  Only runs after the embedding drift detector has fired (DESIGN.md §8.5), to
  avoid false positives. It never branches by itself; it produces a chip.
---
Decide whether the user's new message starts a different topic from the conversation so far, in a way where a separate branch would help them: the new topic is self-contained, and mixing it in would make either thread harder to come back to.

A follow-up, a clarification, a tangent that serves the same goal, or the next step of the same task is NOT a shift.

Recent topics:
{{recent_topics}}

New message:
{{new_message}}

Return JSON: {"shift": true|false, "confidence": 0..1, "new_topic": "2-5 words", "reason": "one sentence"}
