---
id: threads.merge
task_class: utility
output: text
version: 1
variables: [shared_context, branch_a, branch_b]
notes: >
  Writes the consolidated message when two branches are merged into a new
  thread with the "synthesize" strategy (DESIGN.md §8.3). Every point says
  which side it came from, so the merge stays traceable.
---
Two branches of one conversation explored the same question in different ways. Write one consolidated answer that keeps the best of both.

Rules:
- Keep every correct, useful point from either side. Where they agree, say it once.
- Where they disagree, say so plainly and give both positions.
- After each point, mark where it came from: [A], [B] or [A, B].
- Do not add facts that are in neither branch.
- Write for the user, in the voice of the assistant, without mentioning "branches" except in the markers.

Shared context:
{{shared_context}}

Branch A:
{{branch_a}}

Branch B:
{{branch_b}}
