---
id: factcheck.verify-claim
task_class: factcheck.verify
output: ClaimVerdict   # { stance: "supported"|"contradicted"|"insufficient", evidence: [{ ref, quote, stance }], rationale }
version: 1
variables: [claim, evidence]
notes: >
  The verifier is from a different model family than the generator where
  possible (DESIGN.md §10). Evidence arrives wrapped as untrusted content.
---
Judge one claim strictly against the evidence provided. Do not use outside knowledge: if the evidence does not settle it, the answer is "insufficient", even if you believe the claim.

- supported: the evidence states or directly entails the claim, including its numbers and qualifiers.
- contradicted: the evidence states something incompatible with the claim. A different number, date, name or direction counts.
- insufficient: the evidence is silent, partial, or too vague.

For each piece of evidence you relied on, give its ref, the shortest exact quote that matters, and whether it supports or contradicts. Quotes must be copied exactly from the evidence.

rationale: one or two sentences a reader can check.

Claim:
{{claim}}

Evidence:
{{evidence}}

Return JSON matching ClaimVerdict.
