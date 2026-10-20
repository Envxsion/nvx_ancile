---
id: factcheck.verify-general
task_class: factcheck.verify
output: ClaimVerdict   # { stance, evidence: [], rationale, confidence }
version: 1
variables: [claim]
notes: >
  Only for obvious claims that no source covers (triage.ts). A small model may answer alone here,
  never in a critical notebook. It must say "insufficient" when there is any doubt.
---
The claim below is short and widely known. Say whether it is true using common knowledge alone.

- supported: it is plainly true and nobody would argue.
- contradicted: it is plainly false.
- insufficient: it depends on context, on recent events, or you are not certain. When in doubt, say this.

rationale: one short sentence.

confidence: a number from 0 to 1. Say less than 0.6 if you hesitated.

Claim:
{{claim}}

Return JSON matching ClaimVerdict, with "evidence" as an empty list.
