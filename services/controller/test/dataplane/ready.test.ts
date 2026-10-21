/**
 * ------------------------------------------------------------------
 *  Title    |  A woken node is dispatched to only when its model is loaded
 *  Ref      |  DESIGN.md §7.3 · routes/openai.ts
 *  ID       |  controller/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live on RunPod: once the pod was up, requests went
 *           |  through while vLLM was still loading, and the proxy's
 *           |  502 and 404 pages came back as answers. Now the node's
 *           |  /v1/models must list the model first, and a proxy page
 *           |  reads as node_waking.
 * ------------------------------------------------------------------
 */

import { describe, expect, it, vi } from 'vitest';
import { register } from '../../src/nodes';
import { FakeProvider } from '../../src/providers/fake';
import { isProxyPage, listsModel, openaiRoutes } from '../../src/routes/openai';
import { MemoryStore } from '../../src/store';

async function world(answer: (url: string) => Response) {
  const store = new MemoryStore();
  const provider = new FakeProvider(0).add({
    ref: 'p1',
    name: 'Pod 3060',
    state: 'running',
    gpuType: 'RTX 3060',
    hourlyRate: 0.2,
    endpointUrl: 'http://pod.test/v1',
  });
  const node = await register(store, provider, { provider_ref: 'p1', served_models: ['qwen2.5-7b'] });
  await store.putNode({ ...node, observed_state: 'running', endpoint_url: 'http://pod.test/v1' });
  const urls: string[] = [];
  const app = openaiRoutes({
    store,
    routingBlocked: () => false,
    queueDeadlineS: 60,
    wake: async () => undefined,
    fetch: (async (url: string) => {
      urls.push(String(url));
      return answer(String(url));
    }) as unknown as typeof fetch,
  });
  const chat = () =>
    app.request('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'node/qwen2.5-7b', messages: [{ role: 'user', content: 'hi' }] }),
    });
  return { chat, urls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (status: number) =>
  new Response('<html><body>502 Bad Gateway</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });

describe('a node that is up', () => {
  it("estimates a first load in minutes, counting down, not a minute's guess", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const w = await world(() => html(502));
      const eta = async () => ((await (await w.chat()).json()) as { error: { eta_s: number } }).error.eta_s;
      expect(await eta()).toBe(600);
      vi.setSystemTime(Date.now() + 240_000);
      expect(await eta()).toBe(360);
      vi.setSystemTime(Date.now() + 600_000);
      expect(await eta()).toBe(60);
    } finally {
      vi.useRealTimers();
    }
  });
  it('is not sent the request while its server is still loading the model', async () => {
    let models: Response = html(502);
    const w = await world((url) =>
      url.endsWith('/models') ? models : json({ choices: [{ message: { content: 'hello' } }] }),
    );
    const first = await w.chat();
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ error: { code: 'node_waking', phase: 'loading' } });
    expect(w.urls.some((u) => u.endsWith('/chat/completions'))).toBe(false);

    // Up, but another model listed: still loading.
    models = json({ data: [{ id: 'other' }] });
    expect((await w.chat()).status).toBe(503);

    models = json({ data: [{ id: 'qwen2.5-7b' }] });
    const ok = await w.chat();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ choices: [{ message: { content: 'hello' } }] });
    // Asked once: the next request goes straight through.
    const probes = w.urls.filter((u) => u.endsWith('/models')).length;
    await w.chat();
    expect(w.urls.filter((u) => u.endsWith('/models')).length).toBe(probes);
  });

  it("never passes a proxy's error page on as an answer", async () => {
    let page = false;
    const w = await world((url) =>
      url.endsWith('/models')
        ? json({ data: [{ id: 'qwen2.5-7b' }] })
        : page
          ? html(404)
          : json({ ok: true }),
    );
    expect((await w.chat()).status).toBe(200);
    page = true;
    const res = await w.chat();
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).not.toContain('<html>');
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'node_waking' } });
  });

  it('reads model lists and proxy pages', () => {
    expect(listsModel({ data: [{ id: 'a' }, { id: 'b' }] }, 'b')).toBe(true);
    expect(listsModel({ object: 'list' }, 'b')).toBe(false);
    expect(isProxyPage(html(502))).toBe(true);
    expect(isProxyPage(json({ error: 'x' }, 400))).toBe(false);
  });
});
