/**
 * One trace id flows Cockpit → Core → Knowledge / lab / Controller. Core
 * keeps the caller's trace, a live health check (?fresh=1) runs every probe
 * inside it, and each service's log lines can be read back by that trace
 * from the log store.
 */
import { expect, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

const traceId = `${'a'.repeat(31)}1`;
const traceparent = `00-${traceId}-${'b'.repeat(16)}-01`;

test('Core keeps the caller’s trace and probes every service inside it', async ({ request }) => {
  test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
  const res = await request.get('/api/v1/system/health?fresh=1', { headers: { traceparent } });
  expect(res.ok()).toBeTruthy();
  expect(res.headers()['x-trace-id']).toBe(traceId);
  const body = (await res.json()) as { services: { service: string; status: string }[] };
  const names = body.services.map((s) => s.service);
  // The notebook engine runs inside Knowledge since Phase 3.
  for (const expected of ['postgres', 'knowledge', 'controller', 'disk']) expect(names).toContain(expected);
});

test('the trace can be read back from every service’s logs', async ({ request }) => {
  test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
  await request.get('/api/v1/system/health?fresh=1', { headers: { traceparent } });
  await expect
    .poll(async () => {
      const logs = await request.get(`/api/v1/logs?trace=${traceId}`);
      const body = (await logs.json()) as { items: { service: string }[] };
      return new Set(body.items.map((l) => l.service));
    })
    .toEqual(new Set(['core', 'knowledge', 'controller']));
});
