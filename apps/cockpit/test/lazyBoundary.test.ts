/**
 * ------------------------------------------------------------------
 *  Title    |  Lazy boundary check
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Live updates must not depend on code that has not
 *           |  loaded: the global event handler and the data stores
 *           |  may not import, even through other modules, anything
 *           |  that is loaded on demand.
 *  How      |  Every module named in a dynamic import() or a
 *           |  lazyHost / lazyRouteComponent call is "lazy". Starting
 *           |  from lib/events.ts and the stores (state/*, lib/data,
 *           |  lib/query, lib/run, lib/connection, lib/sse), follow
 *           |  static imports only; reaching a lazy module fails.
 *  Note     |  main.tsx is skipped as a source of lazy modules: its only
 *           |  dynamic imports are dev-only tooling. A type position
 *           |  (import('./x').Type) loads nothing and is skipped too.
 * ------------------------------------------------------------------
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..', 'src');
const EXT = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const e of ['', ...EXT]) {
    const p = base + e;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
// A type position (`import('./x').Type`) loads nothing; main.tsx's only dynamic imports are dev tooling.
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)(?!\.[A-Z])/g;

const files = walk(SRC);
const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

/** Static (runtime) imports of one file. */
function staticImports(file: string): string[] {
  const out: string[] = [];
  for (const m of (text.get(file) ?? '').matchAll(STATIC)) {
    const r = resolveSpec(file, m[1] ?? '');
    if (r) out.push(r);
  }
  return out;
}

const rel0 = (p: string) => relative(SRC, p).split(sep).join('/');
const lazy = new Set<string>();
for (const f of files.filter((x) => rel0(x) !== 'main.tsx'))
  for (const m of (text.get(f) ?? '').matchAll(DYNAMIC)) {
    const r = resolveSpec(f, m[1] ?? '');
    if (r) lazy.add(r);
  }

const rel = (p: string) => relative(SRC, p).split(sep).join('/');

describe('lazy modules and live updates', () => {
  it('finds the lazy modules it is meant to guard against', () => {
    const names = [...lazy].map(rel);
    expect(names).toContain('fixtures/demo.ts');
    expect(names).toContain('thread/ToolStepCards.tsx');
    expect(names).toContain('ui/ErrorFallback.tsx');
  });

  it('keeps the event handler and the stores free of lazy imports', () => {
    const roots = [
      'lib/events.ts',
      'lib/data.ts',
      'lib/query.ts',
      'lib/run.ts',
      'lib/connection.ts',
      'lib/sse.ts',
      ...readdirSync(join(SRC, 'state'))
        .filter((n) => /\.tsx?$/.test(n))
        .map((n) => `state/${n}`),
    ].map((r) => join(SRC, r));
    const problems: string[] = [];
    for (const root of roots) {
      expect(existsSync(root), `${rel(root)} is a root of this check`).toBe(true);
      const seen = new Map<string, string>([[root, '']]);
      const queue = [root];
      while (queue.length) {
        const cur = queue.pop() as string;
        for (const next of staticImports(cur)) {
          if (seen.has(next)) continue;
          seen.set(next, cur);
          if (lazy.has(next)) {
            const chain: string[] = [];
            for (let p: string | undefined = next; p; p = seen.get(p) || undefined) chain.unshift(rel(p));
            problems.push(`${chain.join(' -> ')} is loaded on demand`);
            continue;
          }
          queue.push(next);
        }
      }
    }
    expect(
      problems,
      'Live updates must not wait on a chunk. Move what they need into a module the shell imports:\n' +
        problems.join('\n'),
    ).toEqual([]);
  });
});
