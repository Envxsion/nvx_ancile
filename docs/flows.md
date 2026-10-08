# Flows

A flow decides how a message is answered: which models take part, what each one is given, and how their work becomes one answer. You draw it as a graph. With no flow, the default model answers on its own, which is fine for most chats. Add a flow when you want different models for different kinds of work.

## A first flow in five minutes

1. Open a notebook and choose the **Flow** tab.
2. Press **New flow** and pick **Router to specialists**. You get: your message → a Router → a coder, a maths model and a generalist → the answer.
3. Click the Router. In the side panel, change its model and rewrite its routes in plain language. Each route is an edge label plus a sentence saying when to take it.
4. Click each specialist and choose its model: an API model, an OpenRouter model, or `node/<model>` on a GPU node. [Models](models.md) explains how to add them.
5. Press **Try a message** (`Ctrl Enter`), type something like "fix this regex", and watch the route light up. Turn on **Mock models** to run it with stand-in answers, which costs nothing.
6. Press **Versions** (`v`) and publish. Then, in the notebook's list of flows, choose **Use this flow**. Every new message in the notebook now goes through it.

Under each answer, the **Teamwork** fold shows the flow working live: each node as it runs, the Router's choice and its reason, and the hand-offs. The Why panel (`w`) names the path afterwards.

## The nodes

| Node | What it does |
|---|---|
| Input | Your message entering the flow |
| Model | One call to one model, with a role, tools (still asked about under your permissions) and fallbacks |
| Router | A model that reads the request and picks a route by its labels; below its confidence threshold it takes the default route |
| Rule | A condition with no model call: keywords, attachments, length, time, budget left, whether a GPU node is awake |
| Manager | Plans, hands parts to workers along its edges, reads what they return, and writes the answer; it may ask again, up to its round limit |
| Parallel and Join | Run several branches at once, then keep all, the first, a vote, or the one a judge picks |
| Context | Changes what the next node sees (see below) |
| Retrieve | Searches the notebook's sources |
| Fact-check | Checks a draft claim by claim before it is shown |
| Tool | Calls a tool or an MCP server as a step |
| Template | Builds text from earlier outputs |
| Human | Stops and asks you, then carries on |
| Loop | Repeats a part until a condition holds, with a limit |
| Subflow | Another flow used as one node |
| Output | What you see as the answer |
| Note and Group | Labels for you; they do nothing when the flow runs |

## What each node sees

Every edge says what crosses it, so a small model on a cheap GPU gets only what it needs. Click an edge to set:

- **Conversation:** none, the last few turns, the whole branch, a short summary, the other versions of this answer, or a summary of the whole tree.
- **Sources:** none, the passages retrieved for this message, or sources you name.
- **Memory:** none, the memory pack, or only this notebook's memory file.
- **Upstream:** only the plan, the previous node's output, or everything so far.
- **Budget:** a token limit for all of it, trimmed in that order.

The context lens on the canvas shows what a node will receive before you run it.

## Which flow answers

The most specific choice wins:

1. `@flow` on the message.
2. A model picked for the message (`@model`, or **Just the next message**): it answers on its own, instead of any flow, for that one message.
3. The thread's own flow, or flows turned off for the thread.
4. The notebook's flow.
5. The workspace's flow.

With no flow, the thread's model answers, or your default.

### Changing the model while a flow answers

Pick a model (`m`, the model chip or the status bar) in a thread a flow answers and NVX Ancile asks how it should take part:

- **Just the next message.** The model answers your next message alone; then the flow answers again.
- **This thread instead of the flow.** The flow is paused in this thread only (the flow chip reads **Flow paused**); other threads in the notebook keep it. Turn it back on from the flow chip.
- **Inside the flow.** Open the flow and choose which step uses the model. For one thread only, use the flow chip's **Change one step here only**: the notebook's flow stays as it is.

The model switcher never changes a flow's steps by itself. While a flow answers, the model chip is dimmed: it is the model for plain chat, used when no flow does.

### Edge cases

- **Regenerate** a flow's answer and it goes through that flow again (**Same route** repeats its decisions). **Regenerate with another model** answers alone, without the flow. If the flow was deleted, regenerate answers the way the thread answers now.
- **Moving a thread** to another notebook switches it to that notebook's flow. Steps you changed for that thread stay with the old flow.
- **Deleting a notebook or thread** keeps its flows as switched-off workspace drafts.
- **@-mentioned sources** hold inside a flow: a Retrieve step with no sources of its own searches only those.
- A step whose models all run on **GPU nodes** cannot offer "Use a cloud model instead" while its node wakes. Give it a cloud fallback.
- A flow whose models have **no keys** cannot be turned on.
- A message in progress keeps the version of the flow it started with, even if you publish a new one meanwhile.

## Guards

Each flow has a step limit, a cost cap per answer, and a time limit (the flow's settings). A Manager stops after its round limit. Saving a flow that loops forever is refused; use a Loop node with a limit instead. If a guard stops a flow, the answer says which one and what to change.

## Branching and regenerating

Each answer records the flow, its version and the route taken. Regenerate offers **Same route** or **Route again**, so siblings in the branch tree can come from different routes or different flows, and the tree marks them. Compare shows the route beside each version.

## Example: Jev and the specialists

The workspace has an example draft, **Jev: specialists (example)**: a Router called Jev sends writing to Opus, code to a lead engineer (a Manager) who hands a plan to a coder on a GPU node and the result to a reviewer, maths to a model on another GPU node, and everything else to a generalist. The coder's edge passes **only the plan**, no conversation. GPU models wait up to two minutes for their node to wake, then fall back to a cloud model. Open it from the Flow tab, swap in your own models, and try it.

## Sharing

A flow can be exported and imported as YAML from the Versions panel (**Export YAML**), and shared flows live in `config/flows/`.
