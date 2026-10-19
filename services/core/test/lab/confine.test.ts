/**
 * SC1 in the lab: the engine writes files itself, so Core refuses an edit
 * that goes through a link or junction into another lab (or out of this one)
 * before anyone is asked, and answers the engine with a reject and the reason.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { labRefusal } from '../../src/lab/confine';

let base: string;
let place: { realDir: string; virtualDir: string };
let other: string;
let link: string | null = null;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'sc1lab-'));
  place = { realDir: join(base, 'labs', 'thr_a'), virtualDir: '/workspace/labs/thr_a' };
  other = join(base, 'labs', 'thr_b');
  mkdirSync(place.realDir, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'notes.md'), 'b');
  for (const type of ['dir', 'junction'] as const) {
    if (type === 'junction' && process.platform !== 'win32') continue;
    try {
      symlinkSync(other, join(place.realDir, 'to-b'), type);
      link = 'to-b';
      break;
    } catch {
      // try the next kind
    }
  }
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const ask = (permission: string, filepath: string) => ({ permission, patterns: [], metadata: { filepath } });

describe('lab path confinement', () => {
  it('lets an edit inside the lab go on to the permission check', async () => {
    expect(await labRefusal(ask('edit', join(place.realDir, 'src', 'a.ts')), place)).toBeNull();
    expect(await labRefusal(ask('write', 'src/b.ts'), place)).toBeNull();
    expect(await labRefusal(ask('read', join(other, 'notes.md')), place)).toBeNull();
  });

  it('refuses an edit through a link or junction into another lab', async (ctx) => {
    if (!link) return ctx.skip();
    const why = await labRefusal(ask('edit', join(place.realDir, link, 'notes.md')), place);
    expect(why).toMatch(/leaves the folder/);
    expect(await labRefusal(ask('apply_patch', `${link}/new.md`), place)).not.toBeNull();
  });

  it('refuses an edit that names another lab directly, and ".."', async () => {
    expect(await labRefusal(ask('edit', join(other, 'notes.md')), place)).not.toBeNull();
    expect(await labRefusal(ask('edit', '../thr_b/notes.md'), place)).not.toBeNull();
  });

  it('refuses a request to leave the folder when it lands in another lab, and leaves other ones to the person', async () => {
    expect(await labRefusal(ask('external_directory', join(other, 'notes.md')), place)).toMatch(
      /another notebook/,
    );
    expect(await labRefusal(ask('external_directory', join(base, 'elsewhere', 'x')), place)).toBeNull();
  });
});
