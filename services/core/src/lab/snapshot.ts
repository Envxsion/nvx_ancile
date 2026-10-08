/**
 * ------------------------------------------------------------------
 *  Title    |  Lab snapshots
 *  Ref      |  ROADMAP.md Phase 2 ("Undo restores the files")
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Before a lab run touches anything, Core copies the lab
 *           |  folder aside. "What changed" is that copy against the
 *           |  folder now; Undo puts the copy back. It does not depend
 *           |  on the engine's own snapshots, which only work inside a
 *           |  git project.
 *  How      |  Plain file copies under <data>/lab-snapshots/<run>,
 *           |  skipping dependency and VCS folders. A folder over the
 *           |  size limit is not snapshotted, and Undo says so.
 *           |  Restore never follows a link: every folder on the way to
 *           |  a file is checked with lstat, so a link the lab planted
 *           |  cannot send a restored file outside the lab folder.
 * ------------------------------------------------------------------
 */

import { cp, lstat, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { AncileError } from '@nvx/contracts';
import { createTwoFilesPatch } from 'diff';
import type { FileDiff } from './engine-client';

const SKIP = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', '.next', 'target']);
export const SNAPSHOT_LIMIT_BYTES = 50 * 1024 * 1024;
const TEXT_LIMIT = 512 * 1024;

async function walk(
  root: string,
  dir = root,
  out: Map<string, number> = new Map(),
): Promise<Map<string, number>> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else if (e.isFile()) out.set(relative(root, full).split(sep).join('/'), (await stat(full)).size);
  }
  return out;
}

export async function takeSnapshot(labDir: string, snapDir: string): Promise<{ ok: boolean; bytes: number }> {
  const files = await walk(labDir);
  const bytes = [...files.values()].reduce((a, b) => a + b, 0);
  await rm(snapDir, { recursive: true, force: true });
  await mkdir(snapDir, { recursive: true });
  if (bytes > SNAPSHOT_LIMIT_BYTES) {
    await writeFile(join(snapDir, '.too-large'), String(bytes));
    return { ok: false, bytes };
  }
  for (const f of files.keys()) {
    const to = join(snapDir, 'files', f);
    await mkdir(dirname(to), { recursive: true });
    await cp(join(labDir, f), to);
  }
  await writeFile(join(snapDir, '.complete'), String(files.size));
  return { ok: true, bytes };
}

export async function snapshotUsable(snapDir: string): Promise<boolean> {
  return stat(join(snapDir, '.complete')).then(
    () => true,
    () => false,
  );
}

async function textOf(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    if (buf.length > TEXT_LIMIT || buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

export async function diffSnapshot(labDir: string, snapDir: string): Promise<FileDiff[]> {
  const before = await walk(join(snapDir, 'files'));
  const after = await walk(labDir);
  const out: FileDiff[] = [];
  for (const f of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.has(f);
    const is = after.has(f);
    const a = was ? await textOf(join(snapDir, 'files', f)) : '';
    const b = is ? await textOf(join(labDir, f)) : '';
    if (was && is && a === b && a !== null) continue;
    const status = !was ? 'added' : !is ? 'deleted' : 'modified';
    if (a === null || b === null) {
      out.push({ file: f, status, additions: 0, deletions: 0, patch: '(binary or large file)' });
      continue;
    }
    const patch = createTwoFilesPatch(`a/${f}`, `b/${f}`, a, b, '', '', { context: 3 });
    const lines = patch.split('\n');
    out.push({
      file: f,
      status,
      patch,
      additions: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
      deletions: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
    });
  }
  return out;
}

const undoUnsafe = (path: string) =>
  new AncileError({
    code: 'lab.undo_unsafe',
    title: 'Undo stopped at a link inside the lab folder',
    detail: `${path} is a link, and restoring through it could write outside the lab folder.`,
    hint: 'Remove the link from the lab folder, then undo again.',
    status: 409,
    errorClass: 'permanent',
  });

const lstatOrNull = (p: string) =>
  lstat(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });

/**
 * The real path for `rel` inside `labDir`, refusing any folder on the way
 * that is a link. A link in the file's own place is removed (not followed),
 * so the restored copy replaces the link itself.
 */
async function safeTarget(labDir: string, rel: string): Promise<string> {
  const root = await lstatOrNull(labDir);
  if (root?.isSymbolicLink()) throw undoUnsafe('The lab folder');
  const segs = rel.split('/');
  let cur = labDir;
  for (let i = 0; i < segs.length; i++) {
    cur = join(cur, segs[i] as string);
    const st = await lstatOrNull(cur);
    if (!st) break; // nothing there yet: mkdir creates real folders from here on
    if (st.isSymbolicLink()) {
      if (i < segs.length - 1) throw undoUnsafe(segs.slice(0, i + 1).join('/'));
      await unlink(cur);
    }
  }
  return join(labDir, ...segs);
}

/** Put the lab folder back as it was: copy the snapshot over it, remove files it did not have. */
export async function restoreSnapshot(labDir: string, snapDir: string): Promise<number> {
  const before = await walk(join(snapDir, 'files'));
  const after = await walk(labDir);
  let changed = 0;
  for (const f of after.keys()) {
    if (!before.has(f)) {
      await rm(await safeTarget(labDir, f), { force: true });
      changed++;
    }
  }
  for (const f of before.keys()) {
    const to = await safeTarget(labDir, f);
    await mkdir(dirname(to), { recursive: true });
    // mkdir may have met a link planted since the check: look again.
    await safeTarget(labDir, f);
    await cp(join(snapDir, 'files', f), to);
    changed++;
  }
  return changed;
}
