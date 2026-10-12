/**
 * Artifacts over HTTP: a thread's artifacts with every version (later
 * answers and regenerations on another branch), whether each version is on
 * the branch shown, and the per-artifact network switch (off by default).
 */
import type { ArtifactNetwork, Part, ThreadArtifacts } from '@nvx/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { artifactRoutes } from '../../src/artifacts/routes';
import { MemoryArtifactStore } from '../../src/artifacts/store';
import { errorHandler } from '../../src/obs/errors';
import { MemoryThreadRepo } from '../../src/threads/repo';

const text = (t: string): Part[] => [{ type: 'text', text: t }];
const page = (body: string) =>
  `Here:\n\n\`\`\`html artifact id="page" title="Landing page"\n${body}\n\`\`\`\n`;

describe('artifact routes', () => {
  let app: Hono;
  let threads: MemoryThreadRepo;
  let store: MemoryArtifactStore;

  beforeEach(async () => {
    threads = new MemoryThreadRepo();
    store = new MemoryArtifactStore();
    app = new Hono();
    app.onError(errorHandler);
    app.route('/', artifactRoutes({ store, threads, workspaceId: 'ws_1' }) as unknown as Hono);
    await threads.createThread({ id: 'thr_1', workspace_id: 'ws_1' });
    await threads.createThread({ id: 'thr_other', workspace_id: 'ws_2' });
    // u1 → a1 (v1) → u2 → a2 (v2); a1b regenerates a1 on another branch.
    const msgs = [
      { id: 'u1', parent_id: null, role: 'user' as const, parts: text('make a page') },
      { id: 'a1', parent_id: 'u1', role: 'assistant' as const, parts: text(page('<h1>One</h1>')) },
      { id: 'a1b', parent_id: 'u1', role: 'assistant' as const, parts: text(page('<h1>Other</h1>')) },
      { id: 'u2', parent_id: 'a1', role: 'user' as const, parts: text('bigger') },
      { id: 'a2', parent_id: 'u2', role: 'assistant' as const, parts: text(page('<h1>Two</h1>')) },
    ];
    for (const m of msgs)
      await threads.insertMessage({ ...m, thread_id: 'thr_1', status: 'complete', trace_id: 't' });
    await threads.patchThread('thr_1', { active_head_id: 'a2' });
    const all = await threads.messages('thr_1');
    store.rows.set(
      'thr_1',
      all
        .filter((m) => m.role === 'assistant')
        .map((m) => ({ id: m.id, parent_id: m.parent_id, created_at: m.created_at, parts: m.parts })),
    );
  });

  it('lists versions across branches, marking the ones on the branch shown', async () => {
    const res = await app.request('/threads/thr_1/artifacts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ThreadArtifacts;
    expect(body.items).toHaveLength(1);
    const a = body.items[0];
    expect(a?.key).toBe('page');
    expect(a?.allow_network).toBe(false);
    expect(a?.versions.map((v) => [v.version, v.message_id, v.on_path])).toEqual([
      [1, 'a1', true],
      [2, 'a1b', false],
      [3, 'a2', true],
    ]);
    expect(a?.versions[2]?.content).toBe('<h1>Two</h1>');
  });

  it('keeps the network off until the person allows it, and remembers the decision', async () => {
    const put = await app.request('/threads/thr_1/artifacts/page/network', {
      method: 'PUT',
      body: JSON.stringify({ allow: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(put.status).toBe(200);
    const decided = (await put.json()) as ArtifactNetwork;
    expect(decided.allow_network).toBe(true);
    expect(decided.network_changed_at).toBeTruthy();
    const list = (await (await app.request('/threads/thr_1/artifacts')).json()) as ThreadArtifacts;
    expect(list.items[0]?.allow_network).toBe(true);
  });

  it('refuses another workspace’s thread and a bad key', async () => {
    expect((await app.request('/threads/thr_other/artifacts')).status).toBe(404);
    const bad = await app.request('/threads/thr_1/artifacts/..%2Fx/network', {
      method: 'PUT',
      body: JSON.stringify({ allow: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('artifact.bad_key');
  });
});
