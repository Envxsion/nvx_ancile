/**
 * Settings → Usage: totals across every engine, by local hour or day, by
 * engine and by model, with Claude Code's estimate told apart.
 */
import type { ClaudeCodeUsage, UsageReport } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { bucketOf, buildReport, engineOf, type UsageRow, window } from '../../src/usage/report';
import { type Harness, harness, WORKSPACE_ID } from '../support/harness';

// 2026-10-12 14:30 in London (BST, UTC+1).
const NOW = Date.parse('2026-10-12T13:30:00Z');

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function seed(x: Harness) {
  await x.repo.createThread({ id: 'thr_usage', workspace_id: WORKSPACE_ID });
  await x.repo.createThread({ id: 'thr_other', workspace_id: 'wsp_SOMEONEELSE00000000000000' });
  let n = 0;
  const msg = (o: {
    at: string;
    model?: string | null;
    provenance?: Record<string, unknown>;
    i: number;
    o: number;
    cost: number;
    thread?: string;
  }) =>
    x.repo.insertMessage({
      id: `m_${n++}`,
      thread_id: o.thread ?? 'thr_usage',
      parent_id: null,
      role: 'assistant',
      parts: [{ type: 'text', text: 'ok' }],
      status: 'complete',
      model_id: o.model ?? null,
      trace_id: 't',
      created_at: o.at,
      usage: { input_tokens: o.i, output_tokens: o.o, cached_tokens: 0, cost_usd: o.cost },
      ...(o.provenance && { provenance: o.provenance }),
    });
  const cc = { claude_code: { session_id: 's' } };
  // Today, London time.
  await msg({ at: '2026-10-12T08:05:00Z', model: 'openai/gpt-5', i: 1000, o: 200, cost: 0.01 });
  await msg({
    at: '2026-10-12T12:10:00Z',
    model: 'claude-code/opus',
    provenance: cc,
    i: 5000,
    o: 500,
    cost: 0.2,
  });
  await msg({ at: '2026-10-12T12:20:00Z', provenance: { lab: { session_id: 's' } }, i: 300, o: 30, cost: 0 });
  // 23:30 UTC on the 11th is 00:30 on the 12th in London: today.
  await msg({ at: '2026-10-11T23:30:00Z', model: 'openai/gpt-5', i: 10, o: 10, cost: 0 });
  // Earlier this week.
  await msg({
    at: '2026-10-09T10:00:00Z',
    model: 'claude-code/sonnet',
    provenance: cc,
    i: 4000,
    o: 400,
    cost: 0.05,
  });
  // Another workspace, and too long ago: never counted.
  await msg({ at: '2026-10-12T09:00:00Z', model: 'x', i: 999_999, o: 0, cost: 9, thread: 'thr_other' });
  await msg({ at: '2026-09-01T09:00:00Z', model: 'x', i: 999_999, o: 0, cost: 9 });
}

describe('GET /usage', () => {
  it('totals today by local hour, split by engine and model', async () => {
    h = await harness({ now: () => NOW });
    await seed(h);
    const r = await h.call<UsageReport>('GET', '/usage?range=day&tz=Europe/London');
    expect(r.status).toBe(200);
    const u = r.body;
    expect(u.bucket).toBe('hour');
    expect(u.series).toHaveLength(24);
    expect(u.series[0]?.start).toBe('2026-10-12T00:00');
    expect(u.series[0]?.tokens).toBe(20);
    expect(u.series[9]?.tokens).toBe(1200);
    expect(u.series[13]?.by_engine).toEqual({ claude_code: 5500, lab: 330 });
    expect(u.totals).toEqual({
      input_tokens: 6310,
      output_tokens: 740,
      cached_tokens: 0,
      cost_usd: 0.21,
      answers: 4,
    });
    expect(u.by_engine.map((e) => [e.engine, e.input_tokens + e.output_tokens])).toEqual([
      ['gateway', 1220],
      ['claude_code', 5500],
      ['lab', 330],
    ]);
    expect(u.by_model[0]).toMatchObject({ model_id: 'claude-code/opus', engine: 'claude_code' });
    expect(u.estimated_cost_usd).toBe(0.2);
  });

  it('totals the week by local day, and refuses a bad range or zone', async () => {
    h = await harness({ now: () => NOW });
    await seed(h);
    const u = (await h.call<UsageReport>('GET', '/usage?range=week&tz=Europe/London')).body;
    expect(u.bucket).toBe('day');
    expect(u.series.map((s) => s.start)).toEqual([
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ]);
    expect(u.series[3]?.tokens).toBe(4400);
    expect(u.series[6]?.tokens).toBe(7050);
    expect(u.totals.answers).toBe(5);
    expect(u.estimated_cost_usd).toBe(0.25);
    expect((await h.call('GET', '/usage?range=year')).status).toBe(400);
    expect((await h.call('GET', '/usage?range=day&tz=Not/AZone')).status).toBe(400);
    // Without a zone, UTC.
    expect((await h.call<UsageReport>('GET', '/usage?range=month')).body.series).toHaveLength(30);
  });

  it("measures Claude Code's own part: today, the week by day, and its threads", async () => {
    h = await harness({ now: () => NOW });
    await seed(h);
    const u = (await h.call<ClaudeCodeUsage>('GET', '/claude-code/usage?tz=Europe/London')).body;
    expect(u.today).toMatchObject({ input_tokens: 5000, output_tokens: 500, answers: 1 });
    expect(u.week).toMatchObject({ input_tokens: 9000, output_tokens: 900, answers: 2 });
    expect(u.days).toHaveLength(7);
    expect(u.days[3]).toMatchObject({ start: '2026-10-09', input_tokens: 4000 });
    // Nothing came from the cache in this seed.
    expect(u.cache_hit_rate).toBe(0);
    expect(u.by_thread.map((t) => [t.thread_id, t.answers])).toEqual([['thr_usage', 2]]);
    expect((await h.call('GET', '/claude-code/usage?tz=Not/AZone')).status).toBe(400);
  });

  it('answers empty plan limits when Claude Code is not wired', async () => {
    h = await harness();
    const r = await h.call<{ available: unknown; can_refresh: boolean }>('GET', '/claude-code/plan-limits');
    expect(r.body).toMatchObject({ available: null, can_refresh: false });
  });
});

describe('usage report', () => {
  it('names the engine from provenance, then the run, then the model', () => {
    expect(engineOf({ claude_code: {} }, null, null)).toBe('claude_code');
    expect(engineOf({}, 'claude_code', 'x')).toBe('claude_code');
    expect(engineOf({ lab: {} }, null, null)).toBe('lab');
    expect(engineOf({}, 'agent', null)).toBe('lab');
    expect(engineOf({}, 'chat_turn', null)).toBe('gateway');
    expect(engineOf({}, null, 'openai/gpt-5')).toBe('gateway');
    expect(engineOf({}, 'factcheck', null)).toBe('other');
  });

  it('cuts days at local midnight, also across a clock change', () => {
    expect(bucketOf('Europe/London', Date.parse('2026-10-11T23:30:00Z'), 'day')).toBe('2026-10-12');
    const w = window('week', 'Europe/London', Date.parse('2026-10-27T12:00:00Z'));
    // British Summer Time ended on 25 October: the 21st began at 23:00 UTC the day before.
    expect(w.from.toISOString()).toBe('2026-10-20T23:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-28T00:00:00.000Z');
  });

  it('folds models past the top few into one row', () => {
    const rows: UsageRow[] = Array.from({ length: 9 }, (_, i) => ({
      bucket: '2026-10-12',
      engine: 'gateway',
      model_id: `m${i}`,
      input_tokens: 100 * (i + 1),
      output_tokens: 0,
      cached_tokens: 0,
      cost_usd: 0,
      estimated_usd: 0,
      answers: 1,
    }));
    const w = window('day', 'UTC', NOW);
    const r = buildReport('day', 'UTC', { ...w, bucket: 'day', keys: ['2026-10-12'] }, rows, 3);
    expect(r.by_model.map((m) => m.model_id)).toEqual(['m8', 'm7', 'm6', null]);
    expect(r.by_model[3]?.input_tokens).toBe(100 + 200 + 300 + 400 + 500 + 600);
  });
});
