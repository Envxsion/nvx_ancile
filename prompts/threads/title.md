---
id: threads.title
task_class: utility
output: ThreadTitle   # { title: string }
version: 1
variables: [first_user_message, first_assistant_reply]
---
Write a title for this conversation so the user can find it again in a list.

Rules:
- 2 to 6 words, sentence case, no quotes, no trailing punctuation.
- Name the subject, not the activity: "Grant budget for the 2027 trial", not "Helping with a budget".
- Keep proper nouns, product names and version numbers exactly as written.
- No emoji. Don't use "Discussion", "Question about", "Help with" or "Chat".

First message:
{{first_user_message}}

First reply (excerpt):
{{first_assistant_reply}}

Return JSON: {"title": "..."}
