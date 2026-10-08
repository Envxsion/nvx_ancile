# Runbook: a memory conflict

**You see:** saving a memory file shows "This memory file changed while you were editing", with both versions side by side.

## Why it happens

You opened `USER.md` and started editing. Meanwhile Ancile learned a preference and committed it to the same file. When you save, Ancile tries a three-way merge (`git merge-file`) between the version you started from, yours, and the current one:
- If your edits and Ancile's don't touch the same lines, the merge is automatic and you never see this.
- If they overlap, you choose.

## Resolve it in the app

The conflict view has three panes: **yours**, **current**, and **result**.

1. For each highlighted block, choose yours, theirs, or both, or edit the result directly.
2. Press **Save merged**. This creates a normal commit authored by you, with the message `memory: resolve conflict in USER.md`.

Nothing is lost either way. Both versions stay in the file's history, and **Revert** can bring either back.

## Resolve it by hand

```bash
cd data/memory
git log --oneline -5 -- USER.md      # see who changed what
git diff HEAD~1 -- USER.md
$EDITOR USER.md                      # make it right
git commit -am "memory: resolve conflict in USER.md"
```

Ancile re-indexes on its next check (within seconds).

## If the repository itself is broken

If Diagnostics reports `memory.repo_corrupt`, or `git status` in `data/memory` errors, follow [restore-backup.md](restore-backup.md).
