/**
 * Chaos (ROADMAP Phase 6, DESIGN §7): failures injected into the running
 * test profile. Each scenario asserts that no message is lost, nothing is
 * answered twice, and the failure is explained where you see the answer.
 *
 * Injection uses what the product already has: the offline model's
 * directives (/fail, /slow), Core's own restart endpoint (Postgres, the
 * Controller), and Core's file watcher for a Core restart mid-answer.
 * Postgres is shared with your everyday stack, which recovers the same way.
 */
import { utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect, test } from '@playwright/test';

const BACKEND = Boolean(process.env.E2E_BACKEND);

interface Msg {
  id: string;
  role: string;
  status: string;
  parent_id: string | null;
  parts: { type: string; text?: string }[];
  provenance?: { attempts?: unknown[] };
}

async function send(request: APIRequestContext, text: string, extra: Record<string, unknown> = {}) {
  const thread = (await (
    await request.post('/api/v1/threads', { data: { title: `chaos ${text.slice(0, 20)}` } })
  ).json()) as {
    id: string;
  };
  const r = await request.post(`/api/v1/threads/${thread.id}/messages`, {
    data: { parent_id: null, parts: [{ type: 'text', text }], ...extra },
  });
  expect(r.status(), await r.text()).toBe(202);
  const body = (await r.json()) as { run_id: string; assistant_message_id: string };
  return { threadId: thread.id, ...body };
}

async function messages(request: APIRequestContext, threadId: string): Promise<Msg[]> {
  const r = await request.get(`/api/v1/threads/${threadId}/path`);
  const body = (await r.json()) as { messages?: Msg[]; items?: Msg[] } | Msg[];
  return Array.isArray(body) ? body : (body.messages ?? body.items ?? []);
}

/** Wait until the answer is final, then check there is exactly one of it. */
async function settled(request: APIRequestContext, threadId: string, timeout = 90_000) {
  let last: Msg[] = [];
  await expect
    .poll(
      async () => {
        last = await messages(request, threadId).catch(() => last);
        return last.find((m) => m.role === 'assistant')?.status ?? 'none';
      },
      { timeout, intervals: [500, 1000, 2000] },
    )
    .toMatch(/^(done|complete|completed|failed|stopped)$/);
  // The whole tree, not only the active path: a duplicate would be a sibling.
  const tree = (await (await request.get(`/api/v1/threads/${threadId}/tree`)).json()) as { total: number };
  expect(tree.total, 'one question and one answer: nothing lost, nothing duplicated').toBe(2);
  expect(last.filter((m) => m.role === 'assistant')).toHaveLength(1);
  return last.find((m) => m.role === 'assistant') as Msg;
}

const text = (m: Msg) =>
  m.parts
    .map((p) => p.text ?? '')
    .join(' ')
    .trim();

async function waitHealthy(request: APIRequestContext, service: string, timeout = 60_000) {
  await expect
    .poll(
      async () => {
        const r = await request.get('/api/v1/system/health?fresh=1').catch(() => null);
        if (!r?.ok()) return 'core down';
        const body = (await r.json()) as { services: { service: string; status: string }[] };
        return body.services.find((s) => s.service === service)?.status ?? 'missing';
      },
      { timeout, intervals: [1000, 2000] },
    )
    .toBe('ok');
}

test.describe('chaos', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!BACKEND, 'needs the test profile (E2E_BACKEND=1, pnpm start:e2e)');
  test.setTimeout(180_000);

  test('a provider 500 falls back, and the answer says which model stood in', async ({ request }) => {
    const { threadId } = await send(request, '/fail 500');
    const a = await settled(request, threadId);
    expect(a.status).toMatch(/done|complete/);
    expect(text(a)).toMatch(/Offline echo/);
  });

  test('a provider timeout falls back the same way', async ({ request }) => {
    const { threadId } = await send(request, '/fail timeout');
    const a = await settled(request, threadId, 120_000);
    expect(a.status).toMatch(/done|complete|failed/);
    expect(text(a).length).toBeGreaterThan(0);
  });

  test('ten flaky answers at once all finish, each exactly once', async ({ request }) => {
    const sent = await Promise.all(
      Array.from({ length: 10 }, (_, i) => send(request, i % 3 === 0 ? '/fail 500' : `/say steady ${i}`)),
    );
    for (const s of sent) {
      const a = await settled(request, s.threadId);
      expect(a.status).toMatch(/done|complete/);
    }
  });

  test('Postgres restarts mid-answer: the answer resumes and finishes once', async ({ request }) => {
    const { threadId } = await send(
      request,
      '/slow one two three four five six seven eight nine ten eleven twelve',
    );
    await new Promise((r) => setTimeout(r, 800));
    const r = await request.post('/api/v1/system/services/postgres/restart', { data: {} });
    test.skip(r.status() === 409 || r.status() === 404, 'this runner cannot restart Postgres');
    const a = await settled(request, threadId, 150_000);
    expect(a.status).toMatch(/done|complete/);
    expect(text(a)).toContain('twelve');
    await waitHealthy(request, 'postgres');
  });

  test('Core restarts mid-answer: the run is reclaimed and finishes once', async ({ request }) => {
    const { threadId } = await send(
      request,
      '/slow alpha beta gamma delta epsilon zeta eta theta iota kappa',
    );
    await new Promise((r) => setTimeout(r, 800));
    // tsx watch restarts Core when its entry file changes.
    const main = fileURLToPath(new URL('../../services/core/src/main.ts', import.meta.url));
    const now = new Date();
    utimesSync(main, now, now);
    const a = await settled(request, threadId, 150_000);
    expect(a.status).toMatch(/done|complete/);
    expect(text(a)).toContain('kappa');
  });

  test('the Controller goes down: health says so, then it comes back', async ({ request }) => {
    const r = await request.post('/api/v1/system/services/controller/restart', { data: {} });
    test.skip(r.status() === 409 || r.status() === 404, 'this runner cannot restart the Controller');
    // A cloud answer is unaffected while the Controller is away.
    const { threadId } = await send(request, '/say still answering');
    const a = await settled(request, threadId);
    expect(text(a)).toContain('still answering');
    await waitHealthy(request, 'controller');
  });
});
