# Runbook: restore from backup

Ancile keeps three kinds of data, and each one is backed up differently:

| Data | Where | Backup |
|---|---|---|
| Memory | `data/memory` (git) | Every change is a commit. A remote, if configured, is pushed hourly. |
| Files (uploads, extracted markdown) | `data/files` | Copy the folder |
| Database (threads, runs, grants, indexes) | Postgres volume `nvx-ancile_pgdata` | `pg_dump` (below) |
| Secrets key | `ANCILE_SECRET_KEY` in `.env` | Keep a copy somewhere else, such as a password manager |

## Take a backup

```bash
docker compose exec -T postgres pg_dump -U ancile -Fc ancile > backups/ancile-$(date +%F).dump
tar czf backups/files-$(date +%F).tgz data/files
git -C data/memory bundle create ../../backups/memory-$(date +%F).bundle --all
```

## Restore the database

```bash
pnpm stop                                   # stop services; Postgres stays up
docker compose exec -T postgres dropdb -U ancile ancile
docker compose exec -T postgres createdb -U ancile ancile
docker compose exec -T postgres pg_restore -U ancile -d ancile < backups/ancile-2026-10-07.dump
pnpm start                                     # migrations bring the schema forward if the dump is older
```

## Restore memory

Memory has its own history, so usually you don't need a backup at all:

```bash
git -C data/memory log --oneline            # find a good commit
git -C data/memory revert <bad-commit>      # undo one change, keeping history
```

If the repository is corrupt:

```bash
mv data/memory data/memory.broken
git clone backups/memory-2026-10-07.bundle data/memory     # or: git clone <your remote> data/memory
```

With no backup at all, move `data/memory` aside and restart. Ancile recreates it from `memory-template/`, and you can copy entries back from `data/memory.broken` by hand.

## Rebuild derived data

Search indexes and memory embeddings are derived from files, so they can always be rebuilt:
- Admin → Diagnostics → **Rebuild indexes**
- or `POST /api/v1/system/reindex`

This re-embeds in the background, and search keeps working on the old index until the new one is ready.

## Lost ANCILE_SECRET_KEY

You lose only the stored provider keys and MCP OAuth tokens. Set a new key with `node scripts/gen-keys.mjs`, start Ancile, and re-enter keys in Settings → Models. Everything else is intact.
