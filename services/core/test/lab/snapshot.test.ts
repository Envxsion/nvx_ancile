import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffSnapshot, restoreSnapshot, snapshotUsable, takeSnapshot } from '../../src/lab/snapshot';

let root = '';
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('lab snapshots', () => {
  it('shows what a run changed and puts it all back', async () => {
    root = await mkdtemp(join(tmpdir(), 'lab-'));
    const lab = join(root, 'lab');
    const snap = join(root, 'snap');
    await mkdir(join(lab, 'src'), { recursive: true });
    await writeFile(join(lab, 'src', 'a.ts'), 'const a = 1;\n');
    await writeFile(join(lab, 'gone.md'), 'keep me\n');
    await mkdir(join(lab, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(lab, 'node_modules', 'x', 'i.js'), 'ignored');

    expect((await takeSnapshot(lab, snap)).ok).toBe(true);
    expect(await snapshotUsable(snap)).toBe(true);

    await writeFile(join(lab, 'src', 'a.ts'), 'const a = 2;\n');
    await writeFile(join(lab, 'new.md'), 'hello\n');
    await rm(join(lab, 'gone.md'));

    const diff = await diffSnapshot(lab, snap);
    expect(diff.map((d) => [d.file, d.status, d.additions, d.deletions])).toEqual([
      ['gone.md', 'deleted', 0, 1],
      ['new.md', 'added', 1, 0],
      ['src/a.ts', 'modified', 1, 1],
    ]);

    await restoreSnapshot(lab, snap);
    expect(await readFile(join(lab, 'src', 'a.ts'), 'utf8')).toBe('const a = 1;\n');
    expect(await readFile(join(lab, 'gone.md'), 'utf8')).toBe('keep me\n');
    await expect(readFile(join(lab, 'new.md'))).rejects.toThrow();
    expect(await diffSnapshot(lab, snap)).toEqual([]);
  });
});
