# Runbook: a service won't stay up

**You see:** Health shows Knowledge, the Controller or Core as *down* or *needs attention*, and the status bar health dot is red.

## 1. Read what Ancile already knows

Admin → Health → the service. It shows the last error, consecutive failed probes, and restart history. Click **Logs** to open the log viewer filtered to that service and the last 15 minutes. Most failures are named in the first error line.

## 2. Common causes

| Last error says | Cause | Fix |
|---|---|---|
| `ECONNREFUSED …:5433` / `connection refused` | Postgres is down | `docker compose up -d postgres`, then `docker compose logs postgres` |
| `password authentication failed` | `.env` password differs from the one the database volume was created with | Put the original password back in `.env`, or (losing data) `docker compose down -v` |
| `relation … does not exist` | Migrations didn't run | `pnpm start` runs them; or `pnpm --filter @nvx/ancile-core run db:migrate` |
| `EADDRINUSE :7710` | Port taken | `pnpm doctor` names the port; stop the other process or change the port in `.env` |
| Knowledge: `Killed` / exit 137 | Out of memory while loading Docling or the reranker | Give Docker more memory (8 GB+), or set `KNOWLEDGE_USE_DOCLING=false` |
| Knowledge: `Cannot download BAAI/…` | Offline on first run | Connect once so the models can download to `KNOWLEDGE_MODEL_CACHE` |
| Controller: `401 from RunPod` | Bad or wrong-scope key | New key with pod read/write; update `RUNPOD_API_KEY` |
| `boot test failed` | Started outside `pnpm start` with a broken config | Run `pnpm start --no-start` to see the failing test and its fix |

## 3. Restart by hand

Health → **Restart** follows the confirmation chain (Requested → Acknowledged → In progress → Confirmed).

From a terminal:

```bash
docker compose restart knowledge        # containers
# or, in dev, stop `pnpm start` with Ctrl+C and run it again
```

## 4. If it's in "needs attention"

Ancile stops restarting a service after 3 restarts in 10 minutes, so a broken service doesn't loop forever. Fix the cause, then press **Clear and restart** on the Health page.

## 5. Still stuck

Admin → Diagnostics → **Run full check**. Copy the report with **Copy debug info** and include it in an issue. Secrets are already removed.

## What keeps working meanwhile

| Down | Effect |
|---|---|
| Knowledge | Chat works without sources; answers say so |
| Controller | Cloud models work; node-only requests wait in the outbox |
| Core | Nothing works, but no data is lost: runs resume on restart |
