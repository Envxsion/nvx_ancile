/**
 * The permission decision log lives at /permissions/decisions; GET /decisions is the decision
 * layer's status (decisions/routes.ts). The Admin log once asked /decisions and got the status.
 * The decision log (Admin) and the decision routes (Settings) read different shapes from
 * /decisions. They once shared the query key ['decisions'], so opening one put the other's
 * data in the cache and the log crashed ("Query data cannot be undefined").
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const keyIn = (file: string, re: RegExp) => {
  const m = read(file).match(re);
  expect(m, file).not.toBeNull();
  return m?.[1] ?? '';
};

describe('decision query keys', () => {
  it('the log and the routes do not share a cache entry', () => {
    const log = keyIn('../src/routes/admin/live.tsx', /queryKey: (\[[^\]]*'decisions'[^\]]*\])/);
    const routes = keyIn('../src/decisions/DecisionsPanel.tsx', /const KEY = (\[[^\]]*\])/);
    expect(log).not.toBe(routes);
  });

  it('the Admin log asks the permission log, not the decision layer', () => {
    const src = read('../src/routes/admin/live.tsx');
    expect(src).toContain("'/permissions/decisions?limit=");
    expect(src).not.toMatch(/api\.get<[^>]*>\('\/decisions/);
  });
});
