# Branching

A conversation in Ancile is a tree, not a list. Any message can be a branch point. Branches share everything up to the fork and diverge after it, and you can see the whole tree, compare two branches, and merge the best of both.

## The model

- **Messages are immutable** and point to their parent. A *branch* is any path from the first message to a last one.
- **Branch here** (`b`) marks a message as a fork. The next message you send on that branch hangs off it. Nothing is copied, so nothing drifts.
- **Edit** (`e`) a message of yours: a new sibling is created and the original path stays intact.
- **Regenerate** (`r`), or regenerate with a different model (`m`): a new sibling reply under the same message.
- **Siblings** are browsable in place with `‹ 2 / 3 ›`, or `Alt [` and `Alt ]`.

The context sent to a model is exactly the path from the first message to where you are. Long paths are compacted. A compaction of a shared prefix is reused by every branch that passes through it, so branching never multiplies the summarising work.

## The tree

Open it with `g b` or the **Tree** tab in the drawer.

```
●  How should we analyse the dropout data?
│
├─●  …  (6 messages)
│  ├─●  Frequentist: mixed model   [Sonnet]   ✓ verified
│  └─●  Try a Bayesian framing     [GPT-5.5]  ◐ mixed
│     └─●  …  (4 messages)  ← you are here
└─●  What about the safety endpoints?          (branch suggested by Ancile)
```

- Straight runs of messages collapse into one node with a count, so even a long thread stays readable.
- Each node shows its first line, the model in that model's colour, and its fact-check state.
- Keys: `j`/`k` to parent and child, `h`/`l` across siblings, `Enter` to jump the conversation there. A minimap appears for large trees.

## Compare

Pick two branch heads, or press **Compare** on a sibling arrow. Ancile finds where they split and shows the two halves side by side, scrolled together turn by turn. Above them:

- a short summary of how they differ (approach, conclusion, facts used, completeness)
- per-side metrics: models, tokens, cost, fact-check confidence

## Merge

**Merge** creates a new thread. Two ways:

- **Pick messages** from either branch. They're copied in order, each linked back to where it came from.
- **Synthesize:** a model writes one consolidated answer from both branches, noting which side each point came from.

The new thread's first message records the merge, and the "why" view can follow it back to both branches. (Merging inside the same tree was considered and rejected: a message with two parents makes "what was the context?" ambiguous.)

## Suggestions

When you change topic sharply (the new message's meaning drifts from the recent conversation and the TL;DR topics), a quiet chip appears above the composer:

> This looks like a new topic · **Branch from here**

Ancile never branches by itself.

## Long conversations

The context meter in the status bar shows how full the model's window is, split by system prompt, memory, sources, history and the space reserved for the reply.
- **At 80%** it turns amber, and **Compact now** appears.
- **At 95%**, Ancile compacts before sending. The latest turns stay word for word; earlier ones are replaced by a summary that keeps goals, decisions, exact numbers and names.
- **Switching to a model with a smaller window** runs the same check first.

## Edge cases

- **Deleting a message with replies under it** asks first, showing how many messages would go. Undo is available for 30 s.
- **A reply that's still streaming** can't be branched until it finishes or you stop it. You can always branch from the message before it.
- **Two branches can run at once.** Two runs on the same branch head can't. You'll be told to wait or branch.
- **A fork point between a tool call and its result** snaps to the result, so no branch has a half-finished tool call.
- **Switching model mid-path:** each message is translated for the new model.
  - Hidden reasoning is dropped for models that can't take it, but kept in storage.
  - Images become captions for models without vision (marked as such).
  - Tool calls become text for models without tools.
