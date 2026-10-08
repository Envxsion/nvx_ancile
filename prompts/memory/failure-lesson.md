---
id: memory.failure-lesson
task_class: utility
output: FailureLesson   # { topic: string, title: string, symptom: string, cause: string, fix: string, recognise: string, confidence: number }
version: 1
variables: [goal, failed_steps, successful_steps, user_remarks]
---
A task failed, then succeeded. Write the lesson so that next time, the same mistake is avoided or fixed quickly.

- topic: a file-name-friendly slug for the area, e.g. "python-packaging", "postgres-migrations", "citation-formatting". Reuse broad topics; don't create one per incident.
- title: one line naming the problem.
- symptom: what was observed when it went wrong, including exact error text if short.
- cause: why it went wrong. If the cause is not clear from the evidence, say "Unclear" rather than guessing.
- fix: what actually worked, concretely.
- recognise: how to spot this situation earlier next time, in one sentence.
- confidence: how sure you are that the fix addressed the cause, not a coincidence.

Only use what is in the evidence. Do not generalise beyond it.

Goal: {{goal}}

What failed:
{{failed_steps}}

What worked:
{{successful_steps}}

What the user said:
{{user_remarks}}

Return JSON matching FailureLesson.
