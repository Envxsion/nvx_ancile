---
id: factcheck.extract-claims
task_class: utility
output: ClaimList   # { claims: [{ text, char_start, char_end, importance, checkable }] }
version: 1
variables: [message_text, question]
notes: >
  VeriScore-style: only verifiable claims. Offsets must index into
  message_text exactly; Core re-validates them and drops any that don't match.
---
Split the answer below into atomic, verifiable claims so each can be checked against evidence.

A claim is:
- a single fact that could be true or false: a number, a date, a name, a causal statement, a quotation, a property of something.
- self-contained: resolve pronouns ("it", "they") so the claim makes sense alone. The text field may be rewritten for that; the offsets still point at the span in the original answer.

Not claims (set checkable: false or omit): opinions, advice, hedged speculation, statements about the future, definitions the answer is introducing, and anything about the conversation itself.

importance: 1 for claims the answer depends on, 0.5 for supporting detail, 0.2 for incidental remarks.

Return at most 25 claims, the most important first.

Question that was asked:
{{question}}

Answer:
{{message_text}}

Return JSON matching ClaimList.
