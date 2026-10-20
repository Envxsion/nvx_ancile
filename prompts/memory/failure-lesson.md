---
id: memory.failure-lesson
task_class: utility
output: FailureLesson   # { topic: string, title: string, symptom: string, cause: string, fix: string, recognise: string, confidence: number, skip?: boolean }
version: 2
variables: [goal, failed_steps, successful_steps, user_remarks]
---
A task failed, then succeeded. Write the lesson so that next time, the same mistake is avoided or fixed quickly.

- topic: a file-name-friendly slug for the area, e.g. "python-packaging", "postgres-migrations", "citation-formatting". Reuse broad topics; don't create one per incident.
- title: one line naming the problem.
- symptom: what was observed when it went wrong, including exact error text if short.
- cause: why it went wrong, stated plainly. The error text and the difference between the failed call and the one that worked usually show it (a wrong name or case, a missing file, a bad argument, a missing permission). Do not write "Unclear" and do not guess.
- fix: what actually worked, concretely.
- recognise: how to spot this situation earlier next time, in one sentence.
- confidence: how sure you are that the fix addressed the cause, not a coincidence.
- skip: set to true, and keep the other fields short, when the evidence does not show why it failed or why the retry worked (a flaky network, a plain retry). An unexplained retry is not a lesson, and no lesson is written.

Paths: never write an absolute path or a folder from this computer (a home folder, a drive letter, the data folder). Use a path relative to the workspace, or just the file name.

Only use what is in the evidence. Do not generalise beyond it.

Goal: {{goal}}

What failed:
{{failed_steps}}

What worked:
{{successful_steps}}

What the user said:
{{user_remarks}}

Return JSON matching FailureLesson.
