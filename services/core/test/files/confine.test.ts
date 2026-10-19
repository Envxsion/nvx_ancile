/**
 * SC1: one agent can never write into another notebook's folder through a
 * symlink, a junction or "..". Every refusal is the typed fs.path_escape;
 * a normal write inside the root works.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  confinedRemove,
  confinedRename,
  confinedWrite,
  confineEntry,
  confineRead,
  isInside,
  PATH_ESCAPE,
} from '../../src/files/confine';
import { fsTools, Workspace } from '../../src/tools/builtin/fs';

let base: string;
let a: string;
let b: string;
let canLink = true;
let canJunction = process.platform === 'win32';
/** A link to a folder in another notebook: a symlink, or a junction where symlinks are not allowed. */
let dirLink: string | null = null;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'sc1-'));
  a = join(base, 'labs', 'A');
  b = join(base, 'labs', 'B');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, 'secret.txt'), 'B only');
  try {
    symlinkSync(b, join(a, 'dirlink'), 'dir');
    symlinkSync(join(b, 'secret.txt'), join(a, 'filelink'), 'file');
    symlinkSync(join(base, 'nowhere'), join(a, 'dangling'), 'file');
  } catch {
    canLink = false; // no symlink right on this machine (Windows without developer mode)
  }
  if (canJunction) {
    try {
      symlinkSync(b, join(a, 'junction'), 'junction');
    } catch {
      canJunction = false;
    }
  }
  dirLink = canLink ? 'dirlink' : canJunction ? 'junction' : null;
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: PATH_ESCAPE, status: 403 });

describe('confinement to the roots an agent may use', () => {
  it('lets an ordinary write, rename and delete inside the root through', async () => {
    const p = await confinedWrite('notes/one.md', [a], 'hello', { mkdirp: true });
    expect(readFileSync(p, 'utf8')).toBe('hello');
    await confinedWrite('notes/one.md', [a], 'again');
    expect(readFileSync(p, 'utf8')).toBe('again');
    const moved = await confinedRename('notes/one.md', 'notes/two.md', [a]);
    expect(existsSync(moved)).toBe(true);
    await confinedRemove('notes/two.md', [a]);
    expect(existsSync(moved)).toBe(false);
    expect((await confineRead(join(a, 'notes'), [a])).root).toContain('A');
  });

  it('refuses ".." traversal', async () => {
    await refused(confinedWrite('../B/x.txt', [a], 'x'));
    await refused(confinedWrite(join(a, 'sub', '..', '..', 'B', 'x.txt'), [a], 'x'));
    await refused(confinedRemove('../B/secret.txt', [a]));
    expect(existsSync(join(b, 'x.txt'))).toBe(false);
  });

  it('refuses an absolute path in another notebook, and an unusable path', async () => {
    await refused(confinedWrite(join(b, 'x.txt'), [a], 'x'));
    await refused(confinedWrite('', [a], 'x'));
    await refused(confinedWrite('a\0b', [a], 'x'));
  });

  it('refuses a write through a symlinked folder', async (ctx) => {
    if (!canLink) return ctx.skip();
    await refused(confinedWrite('dirlink/pwned.txt', [a], 'x', { mkdirp: true }));
    expect(existsSync(join(b, 'pwned.txt'))).toBe(false);
  });

  it('refuses a write to a symlinked file, a dangling link, and a read through a link out', async (ctx) => {
    if (!canLink) return ctx.skip();
    await refused(confinedWrite('filelink', [a], 'overwritten'));
    await refused(confinedWrite('dangling', [a], 'x'));
    await refused(confineRead('dirlink/secret.txt', [a]));
    expect(readFileSync(join(b, 'secret.txt'), 'utf8')).toBe('B only');
  });

  it('refuses to make a folder through a link', async (ctx) => {
    if (!canLink) return ctx.skip();
    await refused(confinedWrite('dirlink/newdir/f.txt', [a], 'x', { mkdirp: true }));
    expect(existsSync(join(b, 'newdir'))).toBe(false);
  });

  it('refuses a Windows junction', async (ctx) => {
    if (!canJunction) return ctx.skip();
    await refused(confinedWrite('junction/pwned.txt', [a], 'x'));
    await refused(confinedWrite('junction/deep/pwned.txt', [a], 'x', { mkdirp: true }));
    await refused(confinedRemove('junction/secret.txt', [a]));
    expect(readFileSync(join(b, 'secret.txt'), 'utf8')).toBe('B only');
    expect(existsSync(join(b, 'pwned.txt'))).toBe(false);
  });

  it('refuses a rename across roots and a rename that ends in another notebook', async (ctx) => {
    writeFileSync(join(a, 'mine.txt'), 'mine');
    await refused(confinedRename('mine.txt', join(b, 'mine.txt'), [a]));
    await refused(confinedRename('mine.txt', '../B/mine.txt', [a]));
    // Two roots allowed: moving between them is still refused.
    await refused(confinedRename('mine.txt', join(b, 'mine.txt'), [a, b]));
    if (!dirLink) return ctx.skip();
    await refused(confinedRename('mine.txt', `${dirLink}/mine.txt`, [a]));
    expect(existsSync(join(a, 'mine.txt'))).toBe(true);
  });

  it('refuses to delete through a link, and to delete the root itself', async (ctx) => {
    await refused(confinedRemove(a, [a]));
    if (!dirLink) return ctx.skip();
    await refused(confinedRemove(`${dirLink}/secret.txt`, [a]));
    if (canLink) await refused(confinedRemove('filelink', [a]));
    expect(existsSync(join(b, 'secret.txt'))).toBe(true);
  });

  it('compares without case on Windows only', () => {
    expect(isInside('C:\\Work\\Labs\\A\\x', 'c:\\work\\labs\\a', 'win32')).toBe(true);
    expect(isInside('C:\\Work\\Labs\\AB\\x', 'c:\\work\\labs\\a', 'win32')).toBe(false);
    expect(isInside('/Work/Labs/A/x', '/work/labs/a', 'linux')).toBe(false);
    expect(isInside('/work/labs/a/x', '/work/labs/a', 'linux')).toBe(true);
    expect(isInside('/work/labs/a-evil', '/work/labs/a', 'linux')).toBe(false);
  });

  it('on Windows an upper-cased path still lands inside, and a sibling in another case does not', async (ctx) => {
    if (process.platform !== 'win32') return ctx.skip();
    const shouty = a.toUpperCase();
    const ok = await confineEntry(join(shouty, 'case.txt'), [a]);
    expect(isInside(ok.path, a, 'win32')).toBe(true);
    await refused(confinedWrite(join(b.toUpperCase(), 'x.txt'), [a], 'x'));
  });
});

describe('the built-in file tools confine again at execution', () => {
  const run = (name: string, args: unknown) => {
    const ws = new Workspace(a);
    const tool = fsTools(ws).find((t) => t.name === name);
    return tool!.execute(args, { idempotencyKey: 'k', signal: new AbortController().signal });
  };

  it('write, read, list and delete work inside the workspace', async () => {
    await run('fs_write', { path: 'tools/x.txt', content: 'hi' });
    expect(await run('fs_read', { path: 'tools/x.txt' })).toMatchObject({ content: 'hi' });
    expect(await run('fs_list', { path: 'tools' })).toMatchObject({ entries: [{ name: 'x.txt' }] });
    await run('fs_delete', { path: 'tools/x.txt' });
    expect(existsSync(join(a, 'tools', 'x.txt'))).toBe(false);
  });

  it('refuse a link out of the workspace on every tool', async (ctx) => {
    if (!dirLink) return ctx.skip();
    await refused(run('fs_write', { path: `${dirLink}/t.txt`, content: 'x' }));
    await refused(run('fs_read', { path: `${dirLink}/secret.txt` }));
    await refused(run('fs_list', { path: dirLink }));
    await refused(run('fs_delete', { path: `${dirLink}/secret.txt` }));
    expect(readFileSync(join(b, 'secret.txt'), 'utf8')).toBe('B only');
  });
});
