---
id: memory.reconcile
task_class: utility
output: ReconcileDecision   # { op: "add"|"update"|"supersede"|"noop", target_key: string|null, text: string, reason: string }
version: 1
variables: [candidate, neighbours]
notes: >
  The extract-and-reconcile step (after mem0). `neighbours` are the nearest
  existing entries by embedding, with their keys. Supersede keeps the old
  entry under "Superseded" with a pointer (DESIGN.md §6.2), so nothing is lost.
---
A new memory entry is about to be written. Compare it with the closest existing entries and choose one operation:

- add: it says something none of them say.
- update: it says the same thing as one entry, but more precisely or completely. Give that entry's key and the merged text.
- supersede: it contradicts or replaces an entry (the user changed their mind, or a fact changed). Give that entry's key and the new text.
- noop: an existing entry already says this.

Prefer noop over near-duplicates. Prefer update over add when the subject is the same. Use supersede only for a real change, not a difference in wording.

Candidate:
{{candidate}}

Closest existing entries:
{{neighbours}}

Return JSON matching ReconcileDecision. The text must follow the entry style: one sentence, present tense, third person.
