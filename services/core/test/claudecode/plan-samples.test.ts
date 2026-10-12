import type { Part, PlanWindow } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  MemoryPlanSampleStore,
  PgPlanSampleStore,
  type PlanSampleStore,
  PlanSamples,
  SAMPLE_EVERY_MS,
} from '../../src/claudecode/plan-samples';
import { assembleForGateway, fullTokensOf } from '../../src/engines/context';
import type { MessageRecord } from '../../src/threads/repo';
import { eachBackend } from '../support/stores';

const win = (percent: number | null, id = 'five_hour'): PlanWindow => ({
  id,
  kind: id === 'five_hour' ? 'session' : 'week',
  label: null,
  percent,
  resets_at: '2026-10-12T15:00:00.000Z',
  status: null,
  updated_at: '2026-10-12T10:00:00.000Z',
});

describe('plan-limit samples', () => {
  it('keeps a figure when it changes, or an hour on; never a figure Claude Code did not give', async () => {
    const store = new MemoryPlanSampleStore();
    const s = new PlanSamples(store);
    const t0 = Date.parse('2026-10-12T10:00:00Z');
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    await s.record([win(10), win(null, 'seven_day')], at(0));
    await s.record([win(10)], at(60_000));
    await s.record([win(25)], at(120_000));
    await s.record([win(25)], at(120_000 + SAMPLE_EVERY_MS));
    await s.record([win(140)], at(130_000 + SAMPLE_EVERY_MS));
    expect(store.rows.map((r) => r.percent)).toEqual([10, 25, 25, 100]);
    expect(store.rows[0]).toMatchObject({
      window_id: 'five_hour',
      kind: 'session',
      resets_at: '2026-10-12T15:00:00.000Z',
    });
  });

  it('a failed write is dropped quietly and tried again next time', async () => {
    let fail = true;
    const kept: number[] = [];
    const store: PlanSampleStore = {
      insert: async (rows) => {
        if (fail) throw new Error('db down');
        kept.push(...rows.map((r) => r.percent));
      },
    };
    const s = new PlanSamples(store);
    await expect(s.record([win(5)], '2026-10-12T10:00:00Z')).resolves.toBeUndefined();
    fail = false;
    await s.record([win(5)], '2026-10-12T10:01:00Z');
    expect(kept).toEqual([5]);
  });
});

eachBackend('plan-limit samples store', (backend) => {
  it('writes rows the insights can read back', async () => {
    const b = backend();
    if (!b.sql) return;
    await new PgPlanSampleStore(b.sql).insert([
      {
        window_id: 'test_window',
        kind: 'week',
        label: 'Opus',
        percent: 42.5,
        resets_at: null,
        at: '2026-10-12T10:00:00Z',
      },
    ]);
    const rows = await b.sql<{ percent: number; label: string }[]>`
      select percent, label from core.plan_limit_samples where window_id = 'test_window'`;
    expect(rows.at(-1)).toMatchObject({ percent: 42.5, label: 'Opus' });
  });
});

describe('what context assembly saved', () => {
  const msg = (id: string, role: 'user' | 'assistant', parts: Part[]): MessageRecord =>
    ({
      id,
      role,
      parts,
      parent_id: null,
      provenance: {},
      thread_id: 't',
      created_at: '',
    }) as unknown as MessageRecord;

  it('counts the whole path, tool output in full, against what was sent', () => {
    const big = 'x'.repeat(40_000);
    const path = [
      msg('u1', 'user', [{ type: 'text', text: 'Read the log' }]),
      msg('a1', 'assistant', [
        { type: 'tool_call', call_id: 'c1', tool: 'fs.read', args: { path: 'log.txt' } },
        { type: 'tool_result', call_id: 'c1', ok: true, result: big },
        { type: 'text', text: 'It failed at step 3.' },
      ] as Part[]),
      msg('u2', 'user', [{ type: 'text', text: 'Why?' }]),
    ];
    const full = fullTokensOf(path);
    expect(full).toBeGreaterThan(10_000);
    const a = assembleForGateway({
      path,
      summary: null,
      window: 128_000,
      maxOutput: 4_000,
      fixedTokens: 500,
    });
    expect(a.report.full_tokens).toBe(full);
    expect(a.report.tokens).toBeLessThan(full / 10);
  });
});
