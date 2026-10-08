/**
 * The internal OpenAI-compatible endpoint: what the lab's agent engine
 * (and later Knowledge) use to spend tokens through Core's gateway.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fromOpenAI } from '../../src/internal/openai';
import { GATEWAY, type Harness, harness, TOKEN } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const post = (path: string, body: unknown, auth = true) =>
  h.app.request(`/internal/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${TOKEN}` }) },
    body: JSON.stringify(body),
  });

function chunks(sse: string): Record<string, unknown>[] {
  return sse
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

describe('internal chat completions', () => {
  it('refuses callers without the service token', async () => {
    h = await harness();
    const res = await post(
      '/openai/chat/completions',
      { model: 'ancile', messages: [{ role: 'user', content: 'hi' }] },
      false,
    );
    expect(res.status).toBe(401);
  });

  it('takes the lab gateway token for model calls only', async () => {
    h = await harness();
    const asLab = (path: string, init: RequestInit = {}) =>
      h.app.request(`/internal/v1${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY}` },
      });
    expect((await asLab('/openai/models')).status).toBe(200);
    const res = await asLab('/openai/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'ancile', messages: [{ role: 'user', content: '/say ok' }] }),
    });
    expect(res.status).toBe(200);
    expect((await asLab('/permissions/decide', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('answers without streaming, through the gateway', async () => {
    h = await harness();
    const res = await post('/openai/chat/completions', {
      model: 'ancile',
      messages: [{ role: 'user', content: '/say hello there' }],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      model: string;
      choices: { message: { content: string }; finish_reason: string }[];
    };
    expect(json.model).toBe('offline/test');
    expect(json.choices[0]?.message.content).toBe('hello there');
    expect(json.choices[0]?.finish_reason).toBe('stop');
  });

  it('streams OpenAI chunks, tool calls included, and ends with [DONE]', async () => {
    h = await harness();
    const res = await post('/openai/chat/completions', {
      model: 'offline/test',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: '/tool read_file {"path":"a.md"}' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    });
    const raw = await res.text();
    expect(raw.trim().endsWith('data: [DONE]')).toBe(true);
    const all = chunks(raw);
    const calls = all.flatMap(
      (c) =>
        ((c.choices as { delta: { tool_calls?: unknown[] } }[])[0]?.delta.tool_calls ?? []) as {
          function: { name: string; arguments: string };
        }[],
    );
    expect(calls[0]?.function).toEqual({ name: 'read_file', arguments: '{"path":"a.md"}' });
    const finish = all
      .flatMap((c) => (c.choices as { finish_reason: string | null }[]).map((x) => x.finish_reason))
      .filter(Boolean);
    expect(finish).toEqual(['tool_calls']);
    expect(all.at(-1)?.usage).toBeDefined();
  });

  it('feeds tool results back so the model can finish', async () => {
    h = await harness();
    const res = await post('/openai/chat/completions', {
      model: 'offline/test',
      messages: [
        { role: 'user', content: '/tool read_file {"path":"a.md"}' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'file says hi' },
      ],
    });
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(json.choices[0]?.message.content).toContain('file says hi');
  });

  it('falls back across models like chat does', async () => {
    h = await harness();
    const res = await post('/openai/chat/completions', {
      model: 'ancile',
      messages: [{ role: 'user', content: '/fail 500' }],
    });
    const json = (await res.json()) as { model: string };
    expect(json.model).toBe('offline/echo');
  });

  it('lists only models that can answer', async () => {
    h = await harness();
    const res = await h.app.request('/internal/v1/openai/models', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.map((m) => m.id)).toEqual(['offline/test', 'offline/echo']);
  });
});

describe('OpenAI messages → parts', () => {
  it('folds tool results into the assistant turn that asked for them', () => {
    const req = fromOpenAI({
      model: 'x',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: 'ok',
          tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"p":1}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'done' },
      ],
    });
    expect(req.system).toBe('be brief');
    expect(req.messages[1]?.parts).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'tool_call', call_id: 'c1', tool: 'read', args: { p: 1 } },
      { type: 'tool_result', call_id: 'c1', ok: true, result: 'done' },
    ]);
  });
});
