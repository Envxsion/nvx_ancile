/**
 * ------------------------------------------------------------------
 *  Title    |  Bundle budget check
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The check that fails the build counts the entry and its
 *           |  static imports only, and says what to do when over.
 * ------------------------------------------------------------------
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script, no types
import { BUDGET, measureEntry, overBudget } from '../scripts/bundle-budget.mjs';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeDist(files: Record<string, string>, html?: string): string {
  dir = mkdtempSync(join(tmpdir(), 'ancile-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(
    join(dir, 'index.html'),
    html ?? '<script type="module" crossorigin src="/assets/index-a.js"></script>',
  );
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), body);
  return dir;
}

describe('bundle budget', () => {
  it('counts the entry and what it imports statically, not what it imports on demand', () => {
    const d = fakeDist({
      'index-a.js':
        'import{x as y}from"./vendor-b.js";import"./side-c.js";const l=()=>import("./Admin-d.js");',
      'vendor-b.js': 'export const x=1;'.repeat(10),
      'side-c.js': 'console.log(1);',
      'Admin-d.js': `export const huge="${'x'.repeat(500_000)}";`,
    });
    const m = measureEntry(d);
    expect(m.chunks.map((c: { file: string }) => c.file).sort()).toEqual([
      'index-a.js',
      'side-c.js',
      'vendor-b.js',
    ]);
    expect(m.raw).toBeLessThan(1000);
  });

  it('follows modulepreload links and reads each chunk once', () => {
    const d = fakeDist(
      { 'index-a.js': 'import"./v.js";', 'v.js': 'export const a=1;', 'pre-p.js': 'export const p=1;' },
      '<script type="module" src="/assets/index-a.js"></script><link rel="modulepreload" href="/assets/pre-p.js"><link rel="modulepreload" href="/assets/v.js">',
    );
    const m = measureEntry(d);
    expect(m.chunks).toHaveLength(3);
  });

  it('is silent within budget and says what to do over it', () => {
    expect(overBudget({ raw: BUDGET.raw, gzip: BUDGET.gzip })).toEqual([]);
    const problems: string[] = overBudget({ raw: BUDGET.raw + 1, gzip: BUDGET.gzip + 1 });
    expect(problems[0]).toMatch(/raw; the budget is/);
    expect(problems[1]).toMatch(/gzipped; the budget is/);
    expect(problems.at(-1)).toMatch(/Load the new code on demand/);
  });

  it('fails clearly when there is nothing built', () => {
    dir = mkdtempSync(join(tmpdir(), 'ancile-dist-'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    expect(() => measureEntry(dir)).toThrow(/build the Cockpit first/);
  });
});
