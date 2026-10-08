/**
 * Phase 5 operations over HTTP: logs (ingest, filter, export), and NVX
 * Ancile as an MCP server whose apps are held to their grants.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { toCsv } from '../../src/logs/routes';
import { type Harness, harness, TOKEN } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

describe('logs', () => {
  it('takes other services’ lines, filters them and exports them', async () => {
    h = await harness({ ops: true });
    const ingest = await h.app.request('/internal/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        service: 'knowledge',
        lines: [
          { level: 'info', msg: 'source ready', component: 'jobs', trace_id: 't1' },
          { level: 'error', msg: 'embedding failed', component: 'jobs', trace_id: 't1' },
          { msg: 'uvicorn access line' },
          { not_a_log: true },
        ],
      }),
    });
    expect(await ingest.json()).toEqual({ accepted: 3 });
    await h.obs.flush();

    const errors = await h.call<{ items: { msg: string }[]; facets: { services: string[] } }>(
      'GET',
      '/logs?level=error',
    );
    expect(errors.body.items.map((l) => l.msg)).toEqual(['embedding failed']);
    expect(errors.body.facets.services).toContain('knowledge');
    const byTrace = await h.call<{ items: unknown[] }>('GET', '/logs?trace=t1');
    expect(byTrace.body.items).toHaveLength(2);
    const text = await h.call<{ items: unknown[] }>('GET', '/logs?q=uvicorn');
    expect(text.body.items).toHaveLength(1);

    const csv = await h.app.request('/api/v1/logs/export?format=csv&service=knowledge');
    expect(csv.headers.get('content-disposition')).toContain('.csv');
    const body = await csv.text();
    expect(body.split('\r\n')[0]).toBe('id,at,level,service,component,trace_id,span_id,msg,data');
    expect(body).toContain('embedding failed');
  });

  it('refuses ingest without the service token', async () => {
    h = await harness({ ops: true });
    const r = await h.app.request('/internal/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'x', lines: [] }),
    });
    expect(r.status).toBe(401);
  });

  it('defuses spreadsheet formulas in CSV', () => {
    const csv = toCsv([
      {
        id: 1,
        at: '2026-10-08T00:00:00Z',
        level: 'info',
        service: 'core',
        component: null,
        trace_id: null,
        span_id: null,
        msg: '=HYPERLINK("x")',
        data: {},
      },
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

type Rpc = { result: { tools: { name: string }[]; isError?: boolean; content: { text: string }[] } };
const json = async (r: Response) => (await r.json()) as Rpc;

describe('MCP server', () => {
  const rpc = (token: string | null, body: unknown) =>
    h.app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  };

  it('needs a token', async () => {
    h = await harness({ ops: true });
    expect((await rpc(null, init)).status).toBe(401);
    expect((await rpc('anc_mcp_nope', init)).status).toBe(401);
  });

  it('lets a connected app search under its grant, and nothing else', async () => {
    h = await harness({ ops: true });
    const made = await h.call<{ token: string; client: { id: string; tools: string[] }; config: unknown }>(
      'POST',
      '/mcp/clients',
      { name: 'My editor', tools: ['ancile.search'] },
    );
    expect(made.status).toBe(201);
    expect(made.body.client.tools).toEqual(['ancile.search']);
    const token = made.body.token;

    const hello = await rpc(token, init);
    expect(hello.status).toBe(200);
    const list = await json(await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('ancile.search');

    const search = await json(
      await rpc(token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ancile.search', arguments: { query: 'pump speed' } },
      }),
    );
    expect(search.result.isError).toBeFalsy();
    expect(search.result.content[0]?.text).toContain('P-300 sheet, page 2');

    // No grant for notebooks: refused, with the way to allow it.
    const nb = await json(
      await rpc(token, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'ancile.notebooks', arguments: {} },
      }),
    );
    expect(nb.result.isError).toBe(true);
    expect(nb.result.content[0]?.text).toContain('Admin → Plugins');

    // Disconnecting revokes the token and its grants.
    expect((await h.call('DELETE', `/mcp/clients/${made.body.client.id}`)).status).toBe(204);
    expect((await rpc(token, init)).status).toBe(401);
    const grants = await h.perms.listGrants();
    expect(grants.filter((g) => g.principal === `mcp:${made.body.client.id}` && !g.revoked_at)).toHaveLength(
      0,
    );
  });
});
