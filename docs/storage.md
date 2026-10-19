# Tidy storage

Over time NVX Ancile collects duplicates: a source that is read again keeps the chunks of its older versions, and an older version of a page is often the same text as the one after it. **Tidy storage** gives that space back. It is a button in **Admin → Diagnostics** and a built-in automation (off until you switch it on).

## What it does

In this order, stopping at the first thing that is not right and changing nothing:

1. **Nothing is running.** It refuses while a run is queued or running (a run waiting for an approval or a GPU is not reading anything). The automation also waits until nothing has started or finished for 10 minutes (`IDLE_MINUTES`).
2. **There is room.** It checks free disk space for a backup plus 64 MB, on top of the 256 MB kept free for the database. If there is not enough it stops with `system.disk_full`.
3. **A backup.** A database backup is taken first (`…-before-tidy.dump`). The newest two are kept. If the backup fails (`system.backup_failed`), nothing is removed.
4. **Still nothing running.** A backup can take minutes, so it looks again.
5. **The knowledge service tidies** (`POST /kn/v1/maintenance/tidy`):
   - A chunk of an older version of a source is removed when a chunk with the same content hash (its text with white space collapsed, plus its context blurb) exists in the current version, or in a newer older version. Search and the "is this citation still current?" check read the current version only, and a citation keeps its own quote and hash, so nothing you can see or search changes. A parent chunk goes only when none of its children is left. Embeddings go with their chunks.
   - Old version bodies (`v{N}.md`) with the same content hash, checked again by reading both files, become one file with two names (a hard link), so every reader still finds its path. Where the file system cannot link, the copy is left alone.
   - It refuses while sources are being read or the embedding model is being changed.
6. **VACUUM (ANALYZE)** on the database.

**See what would change** runs the same checks and counts, with no backup and no changes.

## What it does not do

It does not touch the current version of any source, a source version being written, messages, memory, or anything a run has recorded. The text sent to a model for each message (kept so each turn's request starts with the previous turn's exact bytes) is never changed.

VACUUM makes the space reusable by the database; the operating system gets space back only where whole files go (the shared version bodies).

## Errors

`maintenance.busy`, `system.disk_full` and `system.backup_failed` (docs/errors.md). Each says nothing was changed.

Idea from Octop (MIT); the code is ours.
