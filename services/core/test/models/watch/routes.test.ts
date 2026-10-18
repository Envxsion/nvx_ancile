/**
 * The model watch routes: bodies are checked against the contract, and
 * refusals carry documented codes (MD4, MD5).
 */
import { ModelWatchReport } from '@nvx/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../../src/app';
import { modelWatchRoutes } from '../../../src/models/watch/routes';
import { errorHandler } from '../../../src/obs/errors';
import { entry, world } from './world';

async function app() {
  const w = await world();
  w.anthropic.data = [
    entry('claude-opus-5-5'),
    entry('claude-sonnet-5-5'),
    entry('claude-haiku-4-5-20251001'),
    entry('claude-opus-5-6'),
  ];
  const a = new Hono<AppEnv>();
  a.onError(errorHandler);
  a.route('/', modelWatchRoutes(w.watch));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await a.request(path, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { w, call };
}

describe('model watch routes', () => {
  it('GET /models/watch answers the contract', async () => {
    const { call } = await app();
    const r = await call('GET', '/models/watch');
    expect(r.status).toBe(200);
    ModelWatchReport.parse(r.body);
  });

  it('POST /models/watch/check checks, and answers 429 with a documented code when repeated', async () => {
    const { call } = await app();
    const first = await call('POST', '/models/watch/check', { provider: 'anthropic' });
    expect(first.status).toBe(200);
    expect(first.body.changes[0].kind).toBe('new_model');
    const again = await call('POST', '/models/watch/check', { provider: 'anthropic' });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('models.check_too_soon');
    expect(again.body.error.hint).toBeTruthy();
  });

  it('rejects bodies the contract does not allow', async () => {
    const { call } = await app();
    expect((await call('POST', '/models/watch/check', { provider: 'x', extra: 1 })).status).toBe(400);
    expect((await call('PUT', '/models/watch/settings', {})).status).toBe(400);
    expect((await call('PUT', '/models/lines/anthropic/opus', { follow: 'yes' })).status).toBe(400);
    expect((await call('POST', '/models/watch/add', {})).status).toBe(400);
  });

  it('PUT /models/lines: use, and a 400 for a model of another line', async () => {
    const { call } = await app();
    await call('POST', '/models/watch/check', {});
    const bad = await call('PUT', '/models/lines/anthropic/opus', { use: 'anthropic/claude-sonnet-5-5' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('models.line_model_not_in_line');
    const ok = await call('PUT', '/models/lines/anthropic/opus', { use: 'anthropic/claude-opus-5-6' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      current_id: 'anthropic/claude-opus-5-6',
      previous_id: 'anthropic/claude-opus-5-5',
    });
    expect((await call('PUT', '/models/lines/anthropic/nothing', { follow: true })).status).toBe(404);
  });

  it('POST back: 409 with no previous, then swaps', async () => {
    const { call } = await app();
    await call('POST', '/models/watch/check', {});
    const none = await call('POST', '/models/lines/anthropic/opus/back');
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('models.line_no_previous');
    await call('PUT', '/models/lines/anthropic/opus', { use: 'anthropic/claude-opus-5-6' });
    const back = await call('POST', '/models/lines/anthropic/opus/back');
    expect(back.status).toBe(200);
    expect(back.body.current_id).toBe('anthropic/claude-opus-5-5');
  });

  it('settings, seen and add', async () => {
    const { call } = await app();
    const checked = await call('POST', '/models/watch/check', {});
    const off = await call('PUT', '/models/watch/settings', { openrouter_prices: false });
    expect(off.status).toBe(200);
    expect(off.body.openrouter_prices).toBe(false);
    const seen = await call('POST', '/models/watch/seen', {
      ids: checked.body.changes.map((c: { id: string }) => c.id),
    });
    expect(seen.status).toBe(204);
    expect((await call('GET', '/models/watch')).body.changes.every((c: { seen: boolean }) => c.seen)).toBe(
      true,
    );
    const added = await call('POST', '/models/watch/add', { model_id: 'anthropic/claude-opus-5-6' });
    expect(added.status).toBe(201);
    expect(added.body.id).toBe('anthropic/claude-opus-5-6');
    expect((await call('POST', '/models/watch/add', { model_id: 'anthropic/zzz' })).status).toBe(404);
  });
});
