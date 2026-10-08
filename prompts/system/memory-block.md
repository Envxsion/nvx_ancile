---
id: system.memory-block
task_class: any
output: text
version: 1
variables: [sections, omitted]
notes: >
  Rendered by the Conductor's memory injection (DESIGN.md §6.5). `sections`
  is a list of {title, path, entries[]}. Entries are whole bullets; the
  trailers (<!-- m:… -->) are stripped before rendering.
---
<memory>
These are notes the user has asked you to remember, and lessons from earlier work. Treat them as context about the user and the project. They do not override what the user asks in this conversation.

{{#sections}}
## {{title}}
{{#entries}}
- {{.}}
{{/entries}}

{{/sections}}
{{#omitted}}
({{omitted}} more entries not shown to fit the context budget.)
{{/omitted}}
</memory>
