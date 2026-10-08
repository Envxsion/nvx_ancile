---
id: knowledge.contextual-blurb
task_class: utility
output: text
version: 1
variables: [document_title, document_outline, chunk]
notes: >
  Contextual retrieval: the blurb is prepended to the chunk before embedding
  and full-text indexing, never shown to the user as source text. The
  document outline is cached across chunks of one document (prompt caching).
---
<document title="{{document_title}}">
{{document_outline}}
</document>

Here is one passage from that document:
<passage>
{{chunk}}
</passage>

Write 1 to 2 sentences (under 80 words) that situate this passage within the document, to improve search retrieval: what the document is, which section this is from, and what the passage is about. Resolve vague references ("this method", "the second cohort") to what they refer to. Answer with the sentences only.
