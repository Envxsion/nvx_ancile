---
id: memory.hindsight
task_class: utility
output: HindsightReview   # { nothing_worth_keeping: boolean, note: string, items: [{ kind, topic, root_cause, text, turn, confidence }] }
version: 1
variables: [session]
---
Review this finished session for what it taught, so that next time goes better. Look for root causes, not symptoms.

Sort what you find into two kinds and keep them apart:

- process_lesson: how to work. A habit, a check or an order of steps that would have avoided a mistake or a detour. Write it as an instruction.
- environment_fact: what is true of this machine, project or setup, and was learned the hard way. Write it as a plain statement.

Rules:

- Every item must give the number of the turn it came from ("turn"). Use only turns shown below. If you cannot point to a turn, leave the item out.
- root_cause: one sentence on why it happened. Write "Unclear" rather than guess.
- Only use what is in the session. Do not invent lessons, and do not generalise from one small event.
- Skip anything the user would find obvious, and skip one-off details that will not come up again.
- If nothing is worth keeping, set nothing_worth_keeping to true and give an empty items list. That is a good answer.
- note: one or two sentences on what the session was about and what you decided.
- topic: a file-name-friendly slug for the area, e.g. "python-packaging". Reuse broad topics.

Session (turns are numbered; a line saying some turns were left out means they were quiet):

{{session}}

Return JSON matching HindsightReview.
