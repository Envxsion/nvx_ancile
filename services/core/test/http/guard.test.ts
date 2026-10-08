/**
 * The Cockpit API's front door: another site cannot act through the
 * browser, bodies must be JSON, what a person sends is checked, and a
 * stream for a run that does not exist says so. Plus the jsonb helper
 * that keeps a NUL character from failing a write.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanText, hasBadText, pgSafe } from '../../src/db/json';
import { cockpitOrigins } from '../../src/http/guard';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const raw = (method: string, path: string, headers: Record<string, string>, body?: string) =>
  h.app.request(`/api/v1${path}`, { method, headers, ...(body !== undefined && { body }) });

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('cross-site requests', () => {
  it('refuses a change from another origin, and allows the Cockpit and no-origin callers', async () => {
    h = await harness();
    const body = JSON.stringify({ title: 'x' });
    const json = { 'content-type': 'application/json' };
    const evil = await raw('POST', '/threads', { ...json, origin: 'https://evil.example' }, body);
    expect(evil.status).toBe(403);
    expect(await errorCode(evil)).toBe('request.cross_origin');
    expect((await raw('POST', '/threads', { ...json, origin: 'null' }, body)).status).toBe(403);
    expect((await raw('POST', '/threads', { ...json, origin: 'http://localhost:7701' }, body)).status).toBe(
      201,
    );
    expect((await raw('POST', '/threads', json, body)).status).toBe(201);
    // Reading is not a change.
    expect((await raw('GET', '/threads', { origin: 'https://evil.example' })).status).toBe(200);
  });

  it('refuses a cross-site fetch even without an Origin header', async () => {
    h = await harness();
    const res = await raw(
      'POST',
      '/threads',
      { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      '{}',
    );
    expect(res.status).toBe(403);
  });

  it('refuses a body that is not JSON, and accepts a bodiless POST', async () => {
    h = await harness();
    const form = await raw('POST', '/threads', { 'content-type': 'text/plain', 'content-length': '2' }, '{}');
    expect(form.status).toBe(415);
    expect(await errorCode(form)).toBe('request.unsupported_type');
    const t = await h.newThread();
    const sent = await h.send(t, '/say hi');
    await h.settle(sent.run_id);
    const stop = await raw('POST', `/messages/${sent.assistant_message_id}/stop`, { 'content-length': '0' });
    expect(stop.status).toBe(200);
  });

  it('refuses a body over the limit', async () => {
    h = await harness();
    const res = await raw(
      'POST',
      '/threads',
      { 'content-type': 'application/json', 'content-length': String(30 * 1024 * 1024) },
      '{}',
    );
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('request.too_large');
  });

  it('includes the public URL and extra origins', () => {
    const o = cockpitOrigins('https://ancile.home.arpa:8443/', ['https://other.example/']);
    expect(o).toContain('https://ancile.home.arpa:8443');
    expect(o).toContain('https://other.example');
    expect(o).toContain('tauri://localhost');
  });
});

describe('what a person sends', () => {
  it('refuses a blank message, a NUL character, and parts a person cannot send', async () => {
    h = await harness();
    const t = await h.newThread();
    const send = (parts: unknown[]) =>
      h.call<{ error: { code: string } }>('POST', `/threads/${t}/messages`, { parent_id: null, parts });
    for (const parts of [
      [{ type: 'text', text: '   \n ' }],
      [{ type: 'text', text: `a${String.fromCharCode(0)}b` }],
      [{ type: 'tool_call', call_id: 'c', tool: 'fs_write', args: {} }],
    ]) {
      const r = await send(parts);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('request.invalid');
    }
    expect(await h.repo.messages(t)).toHaveLength(0);
  });

  it('uses the documented codes for a missing thing and a bad body', async () => {
    h = await harness();
    const missing = await h.call<{ error: { code: string } }>('GET', '/threads/thr_nope');
    expect(missing.body.error.code).toBe('request.not_found');
    const bad = await raw('POST', '/threads', { 'content-type': 'application/json' }, '{not json');
    expect(await errorCode(bad)).toBe('request.invalid');
  });
});

describe('run streams', () => {
  it('answers 404 for a run that does not exist', async () => {
    h = await harness();
    const res = await raw('GET', '/runs/run_nope/stream', {});
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('request.not_found');
  });
});

describe('jsonb-safe values', () => {
  it('removes NUL and replaces lone surrogates, keys included', () => {
    const nul = String.fromCharCode(0);
    const lone = String.fromCharCode(0xd800);
    const pair = String.fromCodePoint(0x1f600);
    expect(hasBadText(`ok ${pair}`)).toBe(false);
    expect(cleanText(`a${nul}b`)).toBe('ab');
    expect(cleanText(`x${lone}y${pair}`)).toBe(`x${String.fromCharCode(0xfffd)}y${pair}`);
    expect(pgSafe({ [`k${nul}`]: [`v${nul}`, 1, null, { deep: `z${nul}` }] })).toEqual({
      k: ['v', 1, null, { deep: 'z' }],
    });
  });
});
