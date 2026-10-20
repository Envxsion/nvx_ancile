---
id: factcheck.verify-claim
task_class: factcheck.verify
output: ClaimVerdict   # { stance: "supported"|"contradicted"|"insufficient", evidence: [{ ref, quote, stance }], rationale, confidence }
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

confidence: a number from 0 to 1 for how sure you are of your stance. Say less than 0.6 when the evidence could be read two ways.

Claim:
{{claim}}

Evidence:
{{evidence}}

Reply with one JSON object and nothing else, with exactly these fields:
- "stance": a string, one of "supported", "contradicted", "insufficient"
- "evidence": a list; each item is { "ref": the evidence number such as "E1", "quote": the exact words, "stance": "supports" or "contradicts" }. An empty list when none.
- "rationale": a string, one or two sentences
- "confidence": a number from 0 to 1
Example: {"stance":"supported","evidence":[{"ref":"E1","quote":"Everest is 8,849 m tall.","stance":"supports"}],"rationale":"E1 gives the same height.","confidence":0.9}
Do not put the object inside another key.

Return JSON matching ClaimVerdict.
