---
id: knowledge.auto-tag
task_class: utility
output: SourceTags   # { tags: string[], topics: [{ label, weight }] }
version: 1
variables: [title, summary, cluster_keywords, existing_tags, max_tags]
notes: >
  Keywords come from embedding clusters of the source's chunks. Reusing the
  workspace's existing tags keeps the tag set small and useful.
---
Tag a source so it can be found and grouped with related sources.

- tags: up to {{max_tags}} short lowercase labels (1 to 3 words). Reuse an existing tag whenever one fits; create a new one only when nothing does.
- topics: the 3 most important topics with a weight from 0 to 1.

Prefer subject tags ("clinical trials", "rust async") over format tags ("pdf", "article"). Never tag with the source's own title.

Existing tags in this workspace:
{{existing_tags}}

Source title: {{title}}
Summary: {{summary}}
Keywords from its content: {{cluster_keywords}}

Return JSON matching SourceTags.
