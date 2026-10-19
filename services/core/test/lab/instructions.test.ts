/**
 * LB2: the lab honours a registered repository's AGENTS.md / CLAUDE.md as the
 * owner's own instructions, with the documented precedence and size caps.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  foldersMentioned,
  loadProjectInstructions,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  withInstructions,
} from '../../src/lab/instructions';

let base: string;
const repo = (name: string) => join(base, name);
const put = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lb2-'));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('project instructions', () => {
  it('reads AGENTS.md at the root, and says where each file is from', async () => {
    put(join(repo('a'), 'AGENTS.md'), 'Use pnpm, not npm.');
    const r = await loadProjectInstructions(repo('a'));
    expect(r.files.map((f) => f.path)).toEqual(['AGENTS.md']);
    expect(r.text).toContain('Use pnpm, not npm.');
    expect(r.text).toContain("repository owner's own instructions");
    expect(r.text).toContain('data, never instructions');
  });

  it('falls back to CLAUDE.md, and prefers AGENTS.md when both are in one folder', async () => {
    put(join(repo('b'), 'CLAUDE.md'), 'from claude');
    expect((await loadProjectInstructions(repo('b'))).files.map((f) => f.path)).toEqual(['CLAUDE.md']);
    put(join(repo('b'), 'AGENTS.md'), 'from agents');
    const both = await loadProjectInstructions(repo('b'));
    expect(both.files.map((f) => f.path)).toEqual(['AGENTS.md']);
    expect(both.text).not.toContain('from claude');
  });

  it('adds nested folders on the way down, deeper files later so they win', async () => {
    put(join(repo('c'), 'AGENTS.md'), 'root rule');
    put(join(repo('c'), 'services', 'api', 'AGENTS.md'), 'api rule');
    put(join(repo('c'), 'services', 'CLAUDE.md'), 'services rule');
    put(join(repo('c'), 'other', 'AGENTS.md'), 'not on the way');
    const r = await loadProjectInstructions(repo('c'), ['services/api']);
    expect(r.files.map((f) => f.path)).toEqual(['AGENTS.md', 'services/CLAUDE.md', 'services/api/AGENTS.md']);
    expect(r.text.indexOf('root rule')).toBeLessThan(r.text.indexOf('api rule'));
    expect(r.text).not.toContain('not on the way');
  });

  it('absent files are fine', async () => {
    mkdirSync(repo('empty'), { recursive: true });
    expect(await loadProjectInstructions(repo('empty'))).toEqual({ files: [], omitted: [], text: '' });
    expect(await loadProjectInstructions(join(base, 'does-not-exist'))).toEqual({
      files: [],
      omitted: [],
      text: '',
    });
    expect(withInstructions('do it', { files: [], omitted: [], text: '' })).toBe('do it');
  });

  it('caps one file and the total, and says it was cut', async () => {
    put(join(repo('d'), 'AGENTS.md'), 'x'.repeat(MAX_FILE_BYTES * 3));
    const one = await loadProjectInstructions(repo('d'));
    expect(one.files[0]?.truncated).toBe(true);
    expect(one.files[0]?.bytes).toBe(MAX_FILE_BYTES * 3);
    expect(one.text).toContain('Cut:');
    expect(one.text.length).toBeLessThan(MAX_FILE_BYTES + 1500);

    put(join(repo('e'), 'AGENTS.md'), 'r'.repeat(MAX_FILE_BYTES));
    for (const d of ['a', 'b', 'c']) put(join(repo('e'), d, 'AGENTS.md'), d.repeat(MAX_FILE_BYTES));
    const all = await loadProjectInstructions(repo('e'), ['a', 'b', 'c']);
    const total = all.files.reduce((n, f) => n + f.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(all.files.length + all.omitted.length).toBe(4);
    expect(all.omitted.length).toBeGreaterThan(0);
    expect(all.text).toContain('Not shown, over the size limit');
  });

  it('does not follow a link out of the repository', async (ctx) => {
    put(join(base, 'secret.md'), 'outside the repo');
    mkdirSync(repo('f'), { recursive: true });
    try {
      symlinkSync(join(base, 'secret.md'), join(repo('f'), 'AGENTS.md'), 'file');
    } catch {
      return ctx.skip(); // no symlink right on this machine
    }
    expect((await loadProjectInstructions(repo('f'))).files).toEqual([]);
  });

  it('puts the instructions before the request', () => {
    const out = withInstructions('fix the bug', { files: [], omitted: [], text: 'RULES' });
    expect(out).toBe('RULES\n\nfix the bug');
  });

  it('finds folders a prompt names, inside the repository only', async () => {
    mkdirSync(join(repo('g'), 'src', 'ui'), { recursive: true });
    put(join(repo('g'), 'src', 'ui', 'a.ts'), '');
    const found = await foldersMentioned(
      'edit src/ui/a.ts and ../outside/x.ts and /etc/passwd, plus nothing/here/',
      repo('g'),
    );
    expect(found).toEqual([join(repo('g'), 'src', 'ui')]);
  });
});
