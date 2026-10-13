/**
 * Every guide tour can run: its screens are real routes, and every step's
 * target is drawn by the components of the screen the step happens on (or
 * by the frame around every screen). A renamed data-tour, or a tour that
 * points at a screen it never opens, fails here instead of floating.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARTICLES } from '../src/help/articles';
import { paramOf, pickFor, placeOf, routeMatches } from '../src/help/tourPlace';
import { TOURS } from '../src/help/tours';

const SRC = resolve(__dirname, '../src');
const read = (f: string) => readFileSync(f, 'utf8');

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const f of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.ts'), join(base, 'index.tsx')])
    if (existsSync(f) && /\.tsx?$/.test(f)) return f;
  return null;
}

/** Every source file reachable from `entry` by relative imports, stopping at `stop`. */
function closure(entry: string, stop: Set<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = read(f);
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g)) {
      const next = resolveImport(f, m[1] as string);
      if (next && !seen.has(next) && !stop.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** Routes in router.tsx: full path → the file that draws it. */
function routes(): Map<string, string> {
  const file = join(SRC, 'router.tsx');
  const text = read(file);
  const imports = new Map<string, string>();
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g))
    for (const name of (m[1] as string).split(',').map((n) => n.trim()))
      if (name) imports.set(name, resolveImport(file, m[2] as string) ?? '');
  const byVar = new Map<string, { path: string; parent: string; file: string | null }>();
  for (const m of text.matchAll(/const (\w+) = createRoute\(\{([\s\S]*?)\n?\}\);/g)) {
    const body = m[2] as string;
    const path = /path: '([^']*)'/.exec(body)?.[1] ?? '';
    const parent = /getParentRoute: \(\) => (\w+)/.exec(body)?.[1] ?? 'rootRoute';
    const lazy = /lazyRouteComponent\(\(\) => import\('([^']+)'\)/.exec(body)?.[1];
    const comp = /component: (\w+)/.exec(body)?.[1];
    const f = lazy ? resolveImport(file, lazy) : comp ? (imports.get(comp) ?? null) : null;
    byVar.set(m[1] as string, { path, parent, file: f });
  }
  const full = (v: string): string => {
    const r = byVar.get(v);
    if (!r) return '';
    const head = r.parent === 'rootRoute' ? '' : full(r.parent);
    const joined = r.path.startsWith('/') ? `${head}${r.path}` : `${head}/${r.path}`;
    return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
  };
  const out = new Map<string, string>();
  for (const [v, r] of byVar) if (r.file) out.set(full(v), r.file);
  return out;
}

const ROUTES = routes();
const routeFiles = new Set(ROUTES.values());
const SHELL = closure(join(SRC, 'app/AppShell.tsx'), routeFiles);
const draws = (files: Iterable<string>, target: string) => {
  const re = new RegExp(`data-tour=(?:"${target}"|\\{[^}]*'${target}')`);
  for (const f of files) if (re.test(read(f))) return true;
  return false;
};

describe('guide tours', () => {
  it('finds the routes it checks against', () => {
    expect(ROUTES.get('/flows')).toMatch(/FlowsPage\.tsx$/);
    expect(ROUTES.get('/n/$notebookId')).toMatch(/Notebook\.tsx$/);
    expect(SHELL.size).toBeGreaterThan(10);
    // The frame alone does not draw a screen's own targets, so the check is real.
    expect(draws(SHELL, 'flow-canvas')).toBe(false);
    expect(draws(SHELL, 'notebook-ask')).toBe(false);
    expect(draws(SHELL, 'palette')).toBe(true);
  });

  for (const tour of Object.values(TOURS)) {
    describe(tour.title, () => {
      it('starts and moves only to routes that exist, with a way to fill their parameter', () => {
        tour.steps.forEach((_, i) => {
          const place = placeOf(tour, i);
          if (!place) return;
          expect([...ROUTES.keys()], `${tour.id} step ${i + 1}`).toContain(place.route);
          expect(!!paramOf(place.route), `${tour.id} step ${i + 1}: needs`).toBe(!!place.needs);
        });
      });

      it('lights only targets drawn on the screen each step is on', () => {
        tour.steps.forEach((step, i) => {
          if (!step.target) return;
          const place = placeOf(tour, i);
          const file = place ? ROUTES.get(place.route) : undefined;
          const files = file ? new Set([...closure(file), ...SHELL]) : SHELL;
          expect(draws(files, step.target), `${tour.id} step ${i + 1}: [data-tour="${step.target}"]`).toBe(
            true,
          );
        });
      });
    });
  }

  it('each article that offers a tour names one that exists', () => {
    for (const a of ARTICLES) if (a.tour) expect(TOURS[a.tour], a.id).toBeDefined();
  });

  it('the flows tour starts on the Flows tab', () => {
    expect(placeOf(TOURS.flows as never, 0)?.route).toBe('/flows');
  });
});

describe('where a tour step happens', () => {
  it('matches route patterns', () => {
    expect(routeMatches('/flows', '/flows')).toBe(true);
    expect(routeMatches('/flows', '/flows/')).toBe(true);
    expect(routeMatches('/flows', '/flows/f1')).toBe(false);
    expect(routeMatches('/n/$notebookId', '/n/abc')).toBe(true);
    expect(routeMatches('/n/$notebookId', '/n/abc/flow')).toBe(false);
    expect(routeMatches('/', '/t/x')).toBe(false);
  });

  it('a step keeps the screen of the step before it until it names its own', () => {
    const flows = TOURS.flows as never;
    expect(placeOf(flows, 1)).toEqual({ route: '/flows/$flowId', needs: 'flow' });
    expect(placeOf(flows, 2)).toEqual({ route: '/flows/$flowId', needs: 'flow' });
  });

  it('picks a notebook with sources, a thread in one, and a workspace flow', () => {
    const lists = {
      notebooks: [
        { id: 'empty', sources: 0 },
        { id: 'full', sources: 3 },
      ],
      threads: [
        { id: 't-plain', notebookId: null },
        { id: 't-grounded', notebookId: 'full' },
      ],
      flows: [
        { id: 'block', scope: 'workspace', name: 'Block: x' },
        { id: 'nb', scope: 'notebook', name: 'N' },
        { id: 'ws', scope: 'workspace', name: 'W' },
      ],
    };
    expect(pickFor('notebook', lists)).toBe('full');
    expect(pickFor('thread', lists)).toBe('t-grounded');
    expect(pickFor('flow', lists)).toBe('ws');
    expect(pickFor('flow', { flows: [] })).toBeNull();
  });
});
