import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryConflict } from '@nvx/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitMemoryProvider, MemoryMergeConflict, mergeFile, safeMemoryPath } from '../../src/memory/repo';
import { MEMORY_TEMPLATE } from '../support/harness';

const AUTO = { name: 'NVX Ancile', email: 'memory@ancile.local' };
const ME = { name: 'You', email: 'you@ancile.local' };

let dir: string;
let repo: GitMemoryProvider;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ancile-mem-'));
  repo = new GitMemoryProvider({ root: join(dir, 'memory'), author: AUTO, template: MEMORY_TEMPLATE });
  await repo.ensure();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the memory repository (DESIGN.md §6.1, §6.4)', () => {
  it('starts from the template, as one commit', async () => {
    const files = (await repo.list()).map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(['AGENTS.md', 'USER.md', 'FAILURES/README.md']));
    expect(await repo.log()).toHaveLength(1);
    // ensure() again is a no-op.
    await new GitMemoryProvider({ root: join(dir, 'memory'), author: AUTO }).ensure();
    expect(await repo.log()).toHaveLength(1);
  });

  it('writes a commit per change, with the right author, and reads old versions', async () => {
    const before = await repo.read('USER.md');
    const r = await repo.writeDetailed({
      path: 'USER.md',
      content: `${before.content}\n- Uses British spelling.\n`,
      baseVersion: before.version,
      message: 'memory(user): use British spelling',
      author: ME,
    });
    expect(r.changed).toBe(true);
    const hist = await repo.history('USER.md');
    expect(hist[0]).toMatchObject({ author: 'You', message: 'memory(user): use British spelling' });
    expect((await repo.read('USER.md', before.version)).content).toBe(before.content);
    // Writing the same bytes again commits nothing.
    const again = await repo.writeDetailed({
      path: 'USER.md',
      content: (await repo.read('USER.md')).content,
      baseVersion: r.version,
      message: 'noop',
      author: ME,
    });
    expect(again.changed).toBe(false);
  });

  it('keeps CRLF files byte for byte', async () => {
    const content = '# Notes\r\n\r\n- One. <!-- m:a1 -->\r\n';
    await repo.writeDetailed({
      path: 'PROJECTS/crlf.md',
      content,
      baseVersion: null,
      message: 'x',
      author: ME,
    });
    expect(await readFile(join(repo.root, 'PROJECTS/crlf.md'), 'utf8')).toBe(content);
    expect((await repo.read('PROJECTS/crlf.md')).content).toBe(content);
  });

  it('merges an edit with a change made meanwhile when they touch different lines', async () => {
    const base = await repo.read('USER.md');
    // Ancile appends a preference…
    await repo.writeDetailed({
      path: 'USER.md',
      content: base.content.replace('## Preferences\n', '## Preferences\n\n- Uses metric units.\n'),
      baseVersion: base.version,
      message: 'auto',
      author: AUTO,
    });
    // …while the person edits the heading, from the old version.
    const r = await repo.writeDetailed({
      path: 'USER.md',
      content: base.content.replace('# About me', '# About me and my work'),
      baseVersion: base.version,
      message: 'edit',
      author: ME,
    });
    expect(r.merged).toBe(true);
    const now = (await repo.read('USER.md')).content;
    expect(now).toContain('# About me and my work');
    expect(now).toContain('- Uses metric units.');
  });

  it('refuses a conflicting edit and hands back both sides', async () => {
    const base = await repo.read('USER.md');
    await repo.writeDetailed({
      path: 'USER.md',
      content: base.content.replace('# About me', '# About Ancile'),
      baseVersion: base.version,
      message: 'auto',
      author: AUTO,
    });
    const err = await repo
      .writeDetailed({
        path: 'USER.md',
        content: base.content.replace('# About me', '# About you'),
        baseVersion: base.version,
        message: 'edit',
        author: ME,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MemoryConflict);
    expect(err).toBeInstanceOf(MemoryMergeConflict);
    expect((err as MemoryMergeConflict).mergedWithMarkers).toMatch(
      /<<<<<<< saved meanwhile[\s\S]*>>>>>>> your edit/,
    );
    expect((await repo.read('USER.md')).content).toContain('# About Ancile');
  });

  it('reverts a commit with a new commit', async () => {
    const base = await repo.read('USER.md');
    const w = await repo.writeDetailed({
      path: 'USER.md',
      content: `${base.content}- Wrong thing.\n`,
      baseVersion: base.version,
      message: 'auto',
      author: AUTO,
    });
    await repo.revert(w.version, ME);
    expect((await repo.read('USER.md')).content).toBe(base.content);
    expect((await repo.log())[0]?.message).toMatch(/^Revert/);
  });

  it('diffs two versions', async () => {
    const base = await repo.read('USER.md');
    const w = await repo.writeDetailed({
      path: 'USER.md',
      content: `${base.content}- Added.\n`,
      baseVersion: base.version,
      message: 'x',
      author: ME,
    });
    const patch = await repo.diff(base.version, w.version, 'USER.md');
    expect(patch).toContain('+- Added.');
  });

  it('checks integrity, and reports a broken front matter', async () => {
    expect((await repo.check()).ok).toBe(true);
    await writeFile(join(repo.root, 'PROJECTS', 'bad.md'), '---\ntype: [unclosed\nscope: x\n---\n# Bad\n');
    const r = await repo.check();
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('PROJECTS/bad.md');
  });
});

describe('memory paths', () => {
  it.each([
    '../etc/passwd.md',
    '.git/config.md',
    'USER.txt',
    'a/../../b.md',
    '/abs/../x.md',
    'C:\\x\\..\\y.md',
    'CON.md',
    'PROJECTS/aux.md',
    'PROJECTS/nul.notes.md',
    'trailing./x.md',
    '',
  ])('refuses the path %j', (p) => {
    expect(() => safeMemoryPath(p)).toThrow(/not a memory file/);
  });

  it('accepts ordinary paths', () => {
    expect(safeMemoryPath('PROJECTS/grant-2026.md')).toBe('PROJECTS/grant-2026.md');
    expect(safeMemoryPath('/USER.md')).toBe('USER.md');
  });
});

describe('mergeFile', () => {
  it('is clean when the sides do not overlap', async () => {
    const r = await mergeFile('a\nb\nc\nd\nE\n', 'a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n');
    expect(r).toEqual({ clean: true, text: 'A\nb\nc\nd\nE\n' });
  });
});
