---
id: threads.compare
task_class: utility
output: BranchComparison   # { summary: string, differences: [{aspect, a, b}], better_for: {a: string, b: string} }
version: 1
variables: [shared_context_summary, branch_a, branch_b, model_a, model_b]
---
Two branches of the same conversation diverged from a shared point. Explain how they differ, so the user can choose between them or merge the best of both.

- summary: 2 sentences on the essential difference.
- differences: up to 6 concrete aspects (approach, conclusion, facts used, tone, completeness, correctness), each with what A does and what B does. Quote short phrases where that makes it clearer.
- better_for: what each branch is better for, in one sentence each. If one is simply wrong somewhere, say where.

Be even-handed. Don't prefer a branch because of which model wrote it.

Shared context up to the fork:
{{shared_context_summary}}

Branch A ({{model_a}}):
{{branch_a}}

Branch B ({{model_b}}):
{{branch_b}}

Return JSON matching BranchComparison.
