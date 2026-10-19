# Runbook: restore from backup

Ancile keeps three kinds of data, and each one is backed up differently:

| Data | Where | Backup |
|---|---|---|
| Memory | `data/memory` (git) | Every change is a commit. A remote, if configured, is pushed hourly. |
| Files (uploads, extracted markdown) | `data/files` | Copy the folder |
| Database (threads, runs, grants, indexes) | Postgres (pg0 in `.ancile/` or the data folder; the compose volume `nvx-ancile_pgdata`) | Automatic before every update, in `<data>/backups` (below); `pg_dump` by hand |
| Secrets key | `ANCILE_SECRET_KEY` in `.env` | Keep a copy somewhere else, such as a password manager |

## Backups before every update

NVX Ancile backs the whole database up before it applies any migration (Core's or Knowledge's), and keeps the newest five in `<data>/backups` (the desktop app: the `backups` folder inside its data folder). An empty database is not backed up. No migration runs without a backup; if the backup fails, nothing is changed and the start-up screen offers Try again, or updating once without a backup.

From a checkout (the stack stopped with `pnpm stop`; Postgres stays up):

```bash
pnpm db:backups                       # list them, newest first, with the version and schema each was taken at
pnpm db:backup                        # take one now
pnpm db:restore ancile-20261012-093005-before-migration.dump
```

`db:restore` first takes a safety backup of what is there now (`…-before-restore.dump`), then drops NVX Ancile's schemas and restores the chosen backup in one transaction. Start again with `pnpm start`: migrations bring an older backup forward, backing it up first.

From the first-run setup (Moving from another computer), choose a backup and select Restart and restore: the choice is staged, nothing changes until the restart, and the restart applies it with progress shown. A large restore carries on if NVX Ancile is closed part-way (the marker `backups/restore-staged.json` remembers it; the safety copy is taken once). If it cannot read the backup, it says so and names the safety copy.

In the desktop app, restore from the start-up screen it shows when it cannot open your data (for example after an older version was installed over newer data): pick the backup, confirm, and every service starts again.

By hand, with the Postgres tools pg0 installed (`~/.pg0/installation/<version>/bin`) and the app quit:

```bash
pg_restore --list backups/ancile-….dump | head      # check it reads
# Start only the database, then, connected as the ancile user:
psql -c "drop schema if exists core, knowledge, controller, pro cascade"
pg_restore --single-transaction --exit-on-error -d ancile backups/ancile-….dump
```

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
