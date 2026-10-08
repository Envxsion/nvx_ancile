---
id: knowledge.insight-default
task_class: utility
output: text
version: 1
apply_on_ingest: true
variables: [title, content]
notes: >
  The default transformation run on every new source. Users add their own
  transformations as prompt files with the same front-matter. Its output is
  the "insights" context level for the source.
---
Read the source below and write a dense brief that lets someone decide whether, and how, to use it, without reading it.

Structure:
**What it is:** one sentence: kind of document, author or origin if stated, date if stated.
**Key points:** 3 to 7 bullets with the substantive claims, numbers and conclusions, copied exactly where precise.
**Methods or basis:** one or two sentences on how it reaches its conclusions, if it does.
**Limits:** what it does not cover, caveats it states, or weaknesses that are evident from the text itself.

Only report what is in the source. Do not evaluate it against outside knowledge.

Title: {{title}}

Source:
{{content}}
