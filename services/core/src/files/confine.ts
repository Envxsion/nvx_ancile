/**
 * ------------------------------------------------------------------
 *  Title    |  Path confinement
 *  Ref      |  DESIGN.md §5.3 · ROADMAP SC1 · docs/errors.md (fs.path_escape)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One agent must never write into another notebook's
 *           |  folder through a symlink, a Windows junction or "..".
 *           |  Every write, rename and delete that Core does for an
 *           |  agent resolves the real path first, compares it with
 *           |  the roots that agent may use, and refuses with a typed
 *           |  error (fs.path_escape) when it leaves them.
 *  How      |  Roots are resolved with realpath. A path is resolved
 *           |  through its nearest existing folder; a missing part
 *           |  that is a dangling link counts as an escape, because
 *           |  creating through it would land somewhere unchecked.
 *           |  Writes open the real path without following a link
 *           |  where the OS allows (O_NOFOLLOW), then check again
 *           |  after opening: the same path must still resolve inside
 *           |  and the open file must be the file at that path (device
 *           |  and inode), so a link swapped in between cannot
 *           |  redirect the write. Windows compares without case.
 *  Note     |  A link as the last part of a write, rename or delete is
 *           |  refused even when it points inside: the operation would
 *           |  act on something other than the name the agent gave.
 *           |  Residual: a folder swapped for a link in the instant
 *           |  between checking a rename or delete and doing it is not
 *           |  closed by Node's API; the check is repeated just before.
 * ------------------------------------------------------------------
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { AncileError } from '@nvx/contracts';

export const PATH_ESCAPE = 'fs.path_escape';

export function pathEscape(detail: string, hint?: string): AncileError {
  return new AncileError({
    code: PATH_ESCAPE,
    title: 'That path leaves the folder this agent may use',
    detail,
    hint:
      hint ??
      'Use a path inside the notebook or lab folder. Links and junctions that point elsewhere are not followed.',
    status: 403,
    errorClass: 'policy',
  });
}

/** What the engine and the model are told when a path is refused. */
export const escapeNote = (e: AncileError) => `${e.title}. ${e.hint}`;

export interface ConfineOptions {
  platform?: NodeJS.Platform;
}

/** Is `child` the folder `root` or inside it, by whole segments, case-blind on Windows? */
export function isInside(child: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  // win32 paths compare without case; anything else compares exactly, whatever this host is.
  const p = platform === 'win32' ? win32 : posix;
  const rel = p.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

/**
 * The real path of `p`, or of its nearest existing parent with the missing
 * rest appended. A missing part that is a dangling link cannot be checked,
 * so it is an escape.
 */
export async function resolveReal(p: string, shown: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (err) {
    if (code(err) !== 'ENOENT' && code(err) !== 'ENOTDIR') throw err;
  }
  const own = await lstat(p).catch(() => null);
  if (own) throw pathEscape(`${shown} is a link whose target cannot be found`);
  const parent = dirname(p);
  if (parent === p) return p;
  return join(await resolveReal(parent, shown), basename(p));
}

async function realRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) out.push(await realpath(r).catch(() => resolve(r)));
  return out;
}

function lexical(target: string, base: string, shown: string): string {
  if (typeof target !== 'string' || !target.trim() || target.includes('\0'))
    throw pathEscape(`${JSON.stringify(shown).slice(0, 80)} is not a usable path`);
  if (target.split(/[\\/]+/).some((s) => s === '..'))
    throw pathEscape(`${shown} uses ".." to leave its folder`);
  return isAbsolute(target) ? resolve(target) : resolve(base, target);
}

export interface Confined {
  /** The real path to act on. */
  path: string;
  /** The root it is inside. */
  root: string;
}

/**
 * Where `target` really is, for reading: it may be reached through a link
 * only when the link ends inside a root. Relative paths start at the first root.
 */
export async function confineRead(
  target: string,
  roots: string[],
  opts: ConfineOptions = {},
): Promise<Confined> {
  const platform = opts.platform ?? process.platform;
  const real = await realRoots(roots);
  const abs = lexical(target, real[0] ?? process.cwd(), target);
  const at = await resolveReal(abs, target);
  const root = real.find((r) => isInside(at, r, platform));
  if (!root) throw pathEscape(`${target} is outside the folders allowed here`);
  return { path: at, root };
}

/**
 * Where an entry (a file to write, rename or delete) really is: its folder is
 * resolved and must be inside a root, and the entry itself must not be a link.
 * The result is the real folder joined with the entry's own name.
 */
export async function confineEntry(
  target: string,
  roots: string[],
  opts: ConfineOptions = {},
): Promise<Confined> {
  const platform = opts.platform ?? process.platform;
  const real = await realRoots(roots);
  const abs = lexical(target, real[0] ?? process.cwd(), target);
  const parent = await resolveReal(dirname(abs), target);
  const path = join(parent, basename(abs));
  const root = real.find((r) => isInside(path, r, platform));
  if (!root) throw pathEscape(`${target} is outside the folders allowed here`);
  const own = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (own?.isSymbolicLink()) throw pathEscape(`${target} is a link, and it is not followed`);
  return { path, root };
}

/** Make the folders on the way, one at a time, so a link made meanwhile is seen. */
async function ensureFolder(dir: string, roots: string[], opts: ConfineOptions): Promise<void> {
  const want = await confineEntry(dir, roots, opts);
  const missing: string[] = [];
  let cur = want.path;
  for (;;) {
    const st = await lstat(cur).catch(() => null);
    if (st) break;
    missing.unshift(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const m of missing) {
    await mkdir(m).catch((err) => {
      if (code(err) !== 'EEXIST') throw err;
    });
    const st = await lstat(m);
    if (st.isSymbolicLink() || !st.isDirectory()) throw pathEscape(`${m} became a link while it was made`);
    await confineEntry(m, roots, opts);
  }
}

/**
 * Write a file for an agent. Folders on the way are made when `mkdirp` is
 * set. The file is opened without following a link, then checked once more
 * before anything is written or cut.
 */
export async function confinedWrite(
  target: string,
  roots: string[],
  content: string | Buffer,
  opts: ConfineOptions & { mkdirp?: boolean } = {},
): Promise<string> {
  const first = await confineEntry(target, roots, opts);
  if (opts.mkdirp) await ensureFolder(dirname(first.path), roots, opts);
  const flags = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  const fh = await open(first.path, flags, 0o666);
  try {
    // Look again, now that the file is open: same place, still inside, and the file we hold is the one there.
    const again = await confineEntry(target, roots, opts);
    if (again.path !== first.path) throw pathEscape(`${target} moved while it was being written`);
    const [held, there] = await Promise.all([fh.stat({ bigint: true }), lstat(first.path, { bigint: true })]);
    if (there.isSymbolicLink() || held.ino !== there.ino || held.dev !== there.dev)
      throw pathEscape(`${target} changed while it was being written`);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    await fh.truncate(0);
    await fh.write(buf, 0, buf.length, 0);
  } finally {
    await fh.close();
  }
  return first.path;
}

/** Delete a file, or an empty folder, that is inside a root and is not a link. */
export async function confinedRemove(
  target: string,
  roots: string[],
  opts: ConfineOptions = {},
): Promise<string> {
  const at = await confineEntry(target, roots, opts);
  if (await isRoot(at.path, roots, opts)) throw pathEscape(`${target} is a whole folder this agent works in`);
  const st = await lstat(at.path);
  if (st.isSymbolicLink()) throw pathEscape(`${target} is a link, and it is not followed`);
  if (st.isDirectory()) await rmdir(at.path);
  else await unlink(at.path);
  return at.path;
}

/** Move a file or folder; both ends must be inside a root and neither may be a link. */
export async function confinedRename(
  from: string,
  to: string,
  roots: string[],
  opts: ConfineOptions = {},
): Promise<string> {
  const a = await confineEntry(from, roots, opts);
  const b = await confineEntry(to, roots, opts);
  if (a.root !== b.root) throw pathEscape(`${to} is in a different folder from ${from}`);
  if (await isRoot(a.path, roots, opts)) throw pathEscape(`${from} is a whole folder this agent works in`);
  await rename(a.path, b.path);
  return b.path;
}

async function isRoot(path: string, roots: string[], opts: ConfineOptions): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  return (await realRoots(roots)).some((r) => fold(r) === fold(path));
}

/** True when `target` is a plain file or folder inside a root (a convenience for checks and tests). */
export async function isConfined(
  target: string,
  roots: string[],
  opts: ConfineOptions = {},
): Promise<boolean> {
  try {
    await confineRead(target, roots, opts);
    return true;
  } catch {
    return false;
  }
}
