/**
 * LB3: the lab finds the project's formatter and runs it on the files a run
 * edited, only those. A formatter that is missing, refused or failing is
 * reported and never blocks the edit.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFormatter, type FormatterId, formatEdited } from '../../src/lab/format';

let base: string;
let n = 0;
const proj = (files: Record<string, string>) => {
  const dir = join(base, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
};

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lb3-'));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('detectFormatter', () => {
  const cases: [FormatterId, Record<string, string>][] = [
    ['biome', { 'biome.json': '{}' }],
    ['biome', { 'biome.jsonc': '{}' }],
    ['prettier', { '.prettierrc': '{}' }],
    ['prettier', { 'package.json': '{"name":"x","prettier":{"semi":false}}' }],
    ['ruff', { 'ruff.toml': '' }],
    ['ruff', { 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' }],
    ['black', { 'pyproject.toml': '[tool.black]\nline-length = 100\n' }],
    ['gofmt', { 'go.mod': 'module x\n' }],
    ['rustfmt', { 'Cargo.toml': '[package]\nname = "x"\n' }],
  ];
  for (const [id, files] of cases)
    it(`finds ${id} from ${Object.keys(files).join(', ')}`, async () => {
      expect(await detectFormatter(proj(files))).toBe(id);
    });

  it('finds nothing in a plain folder, and prefers Biome over Prettier', async () => {
    expect(await detectFormatter(proj({ 'a.txt': 'x' }))).toBeNull();
    expect(await detectFormatter(proj({ 'biome.json': '{}', '.prettierrc': '{}' }))).toBe('biome');
  });

  it('looks up to the repository root, and no further', async () => {
    const root = proj({ 'biome.json': '{}', 'src/a.ts': '' });
    expect(await detectFormatter(join(root, 'src'), root)).toBe('biome');
    expect(await detectFormatter(join(root, 'src'))).toBeNull();
  });
});

describe('formatEdited', () => {
  const record = () => {
    const calls: { file: string; args: string[]; cwd: string }[] = [];
    return {
      calls,
      exec: async (file: string, args: string[], o: { cwd: string }) => {
        calls.push({ file, args, cwd: o.cwd });
      },
    };
  };

  it('runs Ruff on the edited Python files only, and says so', async () => {
    const dir = proj({ 'ruff.toml': '', 'a.py': 'x=1', 'b.py': 'y=2', 'notes.md': '#' });
    const r = record();
    const out = await formatEdited(dir, ['a.py', 'notes.md'], { exec: r.exec, allow: async () => true });
    expect(out).toMatchObject({
      status: 'formatted',
      name: 'Ruff',
      files: ['a.py'],
      note: 'Formatted by Ruff.',
    });
    expect(r.calls).toEqual([{ file: 'ruff', args: ['format', 'a.py'], cwd: dir }]);
  });

  it.each([
    ['black', { 'pyproject.toml': '[tool.black]\n', 'a.py': '' }, 'a.py', 'black', ['-q', 'a.py']],
    ['gofmt', { 'go.mod': 'module x\n', 'main.go': '' }, 'main.go', 'gofmt', ['-w', 'main.go']],
    [
      'rustfmt',
      { 'Cargo.toml': '[package]\n', 'src/lib.rs': '' },
      'src/lib.rs',
      'rustfmt',
      ['--edition', '2021', 'src/lib.rs'],
    ],
  ])('runs %s on the file it handles', async (_id, files, edited, exe, args) => {
    const dir = proj(files as Record<string, string>);
    const r = record();
    const out = await formatEdited(dir, [edited as string], { exec: r.exec, allow: async () => true });
    expect(out.status).toBe('formatted');
    expect(r.calls).toEqual([{ file: exe, args, cwd: dir }]);
  });

  it('runs a project-local Biome and Prettier through node, no shell', async () => {
    for (const [tool, pkg, bin, cfg] of [
      ['biome', '@biomejs/biome', 'bin/biome', 'biome.json'],
      ['prettier', 'prettier', 'bin/prettier.cjs', '.prettierrc'],
    ] as const) {
      const dir = proj({
        [cfg]: '{}',
        'a.ts': 'x',
        [`node_modules/${pkg}/package.json`]: JSON.stringify({ name: pkg, bin: { [tool]: bin } }),
      });
      const r = record();
      const out = await formatEdited(dir, ['a.ts'], { exec: r.exec, allow: async () => true });
      expect(out.status).toBe('formatted');
      expect(r.calls[0]?.file).toBe(process.execPath);
      expect(r.calls[0]?.args[0]).toBe(join(dir, 'node_modules', pkg, bin));
      expect(r.calls[0]?.args).toContain('--write');
      expect(r.calls[0]?.args).toContain('a.ts');
    }
  });

  it('says so when no formatter applies or nothing it handles changed', async () => {
    expect((await formatEdited(proj({ 'a.ts': '' }), ['a.ts'])).status).toBe('none');
    const dir = proj({ 'ruff.toml': '', 'readme.md': '' });
    expect((await formatEdited(dir, ['readme.md'])).status).toBe('none');
  });

  it('reports a missing formatter and a failing one, and never throws', async () => {
    const noBin = proj({ 'biome.json': '{}', 'a.ts': '' });
    expect(await formatEdited(noBin, ['a.ts'], { allow: async () => true })).toMatchObject({
      status: 'failed',
      note: expect.stringContaining('not installed for this project'),
    });
    const dir = proj({ 'ruff.toml': '', 'a.py': '' });
    const boom = await formatEdited(dir, ['a.py'], {
      allow: async () => true,
      exec: async () => {
        throw Object.assign(new Error('bad'), { code: 1 });
      },
    });
    expect(boom).toMatchObject({ status: 'failed', note: expect.stringContaining('The edit is unchanged') });
    const gone = await formatEdited(dir, ['a.py'], {
      allow: async () => true,
      exec: async () => {
        throw Object.assign(new Error('x'), { code: 'ENOENT' });
      },
    });
    expect(gone).toMatchObject({ status: 'failed', note: expect.stringContaining('not installed') });
  });

  it('does not run when the permission gate does not allow the command', async () => {
    const dir = proj({ 'ruff.toml': '', 'a.py': '' });
    const r = record();
    const out = await formatEdited(dir, ['a.py'], { exec: r.exec, allow: async () => false });
    expect(out.status).toBe('skipped');
    expect(r.calls).toEqual([]);
    const noGate = await formatEdited(dir, ['a.py'], { exec: r.exec });
    expect(noGate.status).toBe('formatted');
  });

  it('ignores options, missing files and paths that leave the folder', async () => {
    const dir = proj({ 'ruff.toml': '', 'a.py': '' });
    const r = record();
    const out = await formatEdited(dir, ['--config=evil.toml', '../x.py', 'gone.py', 'a.py'], {
      exec: r.exec,
      allow: async () => true,
    });
    expect(out).toMatchObject({ status: 'formatted', files: ['a.py'] });
    expect(r.calls[0]?.args).toEqual(['format', 'a.py']);
  });
});
