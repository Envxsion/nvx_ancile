/**
 * The answer's receipt (roadmap WY1): the figures and wording first (pure),
 * then the strip and the receipt as a person meets them: it opens from the
 * strip and from what used to open Why, closes with Escape, and an older
 * answer shows what is known without inventing zeros.
 */
import type { Explain, Usage } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { toMessageView } from '../src/lib/mappers';
import { queryClient } from '../src/lib/query';
import type { MessageView } from '../src/lib/types';
import { receiptFacts } from '../src/receipt/facts';
import {
  askedWords,
  billedToWords,
  buildSteps,
  costTable,
  planEstimateWords,
  recoveredWords,
  savingWords,
  stripFacts,
  whyThisModel,
} from '../src/receipt/figures';
import { Receipt } from '../src/receipt/Receipt';
import { ReceiptStrip } from '../src/receipt/ReceiptStrip';
import { TABS } from '../src/shell/Drawer';
import { useUi } from '../src/state/ui';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;

const key = { kind: 'key', payer: 'anthropic' } as const;
const rates = { input: 3, cached: 0.3, cache_write: 3.75, output: 15 };
const usage = (p: Partial<Usage> = {}): Usage => ({
  input_tokens: 1000,
  output_tokens: 200,
  cached_tokens: 600,
  cache_write_tokens: 100,
  cache_reported: true,
  cost_usd: 0,
  rates,
  billing: key,
  ...p,
});

describe('the cost table', () => {
  it('takes cache reads and writes off the input, never counting a token twice', () => {
    const t = costTable(usage(), { billing: key, cacheApart: false });
    const tok = (id: string) => {
      const k = t.rows.find((r) => r.id === id)?.tokens;
      return k?.state === 'known' ? k.tokens : null;
    };
    expect([tok('fresh'), tok('cached'), tok('written'), tok('output')]).toEqual([300, 600, 100, 200]);
    const usd = (300 * 3 + 600 * 0.3 + 100 * 3.75 + 200 * 15) / 1e6;
    expect(t.listUsd).toBeCloseTo(usd, 10);
  });

  it('claude code counts cache reads apart: only writes come off', () => {
    const t = costTable(usage({ input_tokens: 400, cached_tokens: 5000 }), {
      billing: key,
      cacheApart: true,
    });
    expect(t.rows[0]?.tokens).toEqual({ state: 'known', tokens: 300 });
  });

  it('says what the cache saved against a cold call', () => {
    const t = costTable(usage(), { billing: key, cacheApart: false });
    const cold = (1000 * 3 + 200 * 15) / 1e6;
    expect(t.saving?.kind).toBe('saved');
    expect(t.saving?.usd).toBeCloseTo(cold - (t.listUsd ?? 0), 10);
    expect(savingWords(t.saving)).toMatch(/^Cache saved you \$/);
  });

  it('says so when writing the cache cost more than it saved', () => {
    const t = costTable(usage({ input_tokens: 1000, cached_tokens: 0, cache_write_tokens: 900 }), {
      billing: key,
      cacheApart: false,
    });
    expect(t.saving?.kind).toBe('cost_more');
    expect(savingWords(t.saving)).toMatch(/^Writing the cache cost \$.* more this time/);
  });

  it('never shows 0 for figures a provider did not report, and makes no savings claim', () => {
    const t = costTable(usage({ cache_reported: false, cached_tokens: 0, cache_write_tokens: 0 }), {
      billing: key,
      cacheApart: false,
    });
    expect(t.rows[1]?.tokens).toEqual({ state: 'not_reported' });
    expect(t.rows[2]?.tokens).toEqual({ state: 'not_reported' });
    expect(t.rows[0]?.tokens).toEqual({ state: 'known', tokens: 1000 });
    expect(t.saving).toBeNull();
  });

  it('an older answer is "not recorded", not zero', () => {
    const t = costTable(
      { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_usd: 0.01 },
      { billing: null, cacheApart: false },
    );
    expect(t.rows[1]?.tokens).toEqual({ state: 'not_recorded' });
    expect(t.rows[2]?.tokens).toEqual({ state: 'not_recorded' });
    expect(t.priced).toBe(false);
  });

  it('shows the provider bill beside list price when they differ', () => {
    const t = costTable(usage({ billed_usd: 0.02, list_usd: 0.01, cost_usd: 0.02 }), {
      billing: key,
      cacheApart: false,
    });
    expect(t.billed).toEqual({ billedUsd: 0.02, listUsd: 0.01 });
    expect(
      costTable(usage({ billed_usd: 0.01, list_usd: 0.01 }), { billing: key, cacheApart: false }).billed,
    ).toBeNull();
  });

  it('a plan shows tokens only, with an estimate; a local model nothing to pay', () => {
    const plan = costTable(usage({ cost_usd: 0.19, billing: { kind: 'plan', payer: 'max' } }), {
      billing: { kind: 'plan', payer: 'max' },
      cacheApart: true,
    });
    expect(plan.priced).toBe(false);
    expect(plan.rows.every((r) => r.rate === null && r.usd === null)).toBe(true);
    expect(planEstimateWords(usage({ cost_usd: 0.19 }))).toBe(
      'Would have cost about $0.190 at API prices; your plan covered it.',
    );
    expect(planEstimateWords(usage({ cost_usd: 0 }))).toBeNull();
  });
});

describe('the strip', () => {
  const base = { badge: 'Key', modelName: 'Claude Opus 5.5', cacheApart: false, billing: key };
  it('names the model, time, cost and what the cache saved', () => {
    const f = stripFacts({ ...base, usage: usage({ cost_usd: 0.031, ms: 6400 }) });
    expect(f).toMatchObject({ modelName: 'Opus 5.5', badge: 'Key', seconds: '6.4 s', cost: '$0.031' });
    expect(f.saved).toMatch(/^cache saved \$/);
  });
  it('says Max plan for a plan answer and no cost for a local one', () => {
    const plan = { kind: 'plan', payer: 'max' } as const;
    expect(stripFacts({ ...base, billing: plan, usage: usage({ billing: plan }) }).cost).toBe('Max plan');
    const local = { kind: 'local', payer: null } as const;
    expect(stripFacts({ ...base, billing: local, usage: usage({ billing: local }) }).cost).toBe('no cost');
  });
});

describe('why this model', () => {
  const none = { attempts: [], claudeCodeSession: false };
  it('covers each case', () => {
    expect(whyThisModel({ ...none, name: 'Claude Opus 5.5', route: { kind: 'model', from: 'thread' } })).toBe(
      'Your choice for this thread.',
    );
    expect(
      whyThisModel({ ...none, name: 'Claude Sonnet 5.5', route: { kind: 'model', from: 'default' } }),
    ).toBe('Routing picked the first ready model for ordinary chat.');
    expect(
      whyThisModel({
        ...none,
        name: 'Claude Sonnet 5.5',
        attempts: [{ name: 'Claude Opus 5.5', reason: 'capacity' }],
      }),
    ).toBe('Opus 5.5 was busy (rate limited), so Sonnet 5.5 answered.');
    expect(whyThisModel({ ...none, name: 'Claude Opus 5.5', aliasName: 'Claude Opus' })).toBe(
      'You chose Opus (latest), which is Opus 5.5 now.',
    );
    expect(whyThisModel({ ...none, name: 'Claude Opus 5.5', claudeCodeSession: true })).toBe(
      'This thread is a Claude Code session. Claude Code chose Opus 5.5 for it.',
    );
    expect(whyThisModel({ ...none, name: 'GPT-5.5', flowName: 'Board review' })).toBe(
      'The Board review flow routed it.',
    );
  });
});

describe('worth knowing', () => {
  it('words a retry that worked', () => {
    expect(
      recoveredWords({ what: 'tool', name: 'web_search', attempts: 2, waited_ms: 1200, reason: 'timeout' }),
    ).toBe('The web search tool timed out once and was retried after 1.2 s.');
    expect(
      recoveredWords({
        what: 'model',
        name: 'Anthropic',
        attempts: 2,
        waited_ms: 2000,
        reason: 'rate_limited',
      }),
    ).toBe('Anthropic was rate limited; retried after 2.0 s.');
  });
  it('says which tools asked you first', () => {
    const t = {
      call_id: 'c',
      tool: 'fs_write',
      args: {},
      ok: true,
      result: null,
      declined_reason: null,
      duration_ms: null,
      decision: {
        outcome: 'approved',
        tier: 'gated',
        action: 'fs.write',
        resource: 'fs:/workspace/notes.md',
        at: '',
        rule: null,
        scope: null,
      },
    } as Explain['tools'][number];
    expect(askedWords([t], (r) => r.replace('fs:/workspace/', ''))).toBe(
      '1 tool asked you first (fs write on notes.md, you allowed it)',
    );
    expect(
      askedWords([{ ...t, decision: { ...(t.decision as object), outcome: 'auto' } } as never], (r) => r),
    ).toBeNull();
  });
  it('names where a metered Claude Code bill goes', () => {
    expect(billedToWords('anthropic')).toBe('your Anthropic API key');
    expect(billedToWords('vertex')).toBe('Google Vertex AI');
  });
});

describe('step by step', () => {
  it('orders context, model calls and the tools between them, with times', () => {
    const call = (i: number, stop: 'tool_calls' | 'end') => ({
      model_id: 'm',
      started_ms: 500 + i * 2000,
      ms: 900,
      input_tokens: 100,
      cached_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 10,
      cost_usd: 0.001,
      stop,
    });
    const steps = buildSteps({
      calls: [call(0, 'tool_calls'), call(1, 'end')],
      parts: [
        { type: 'tool_call', call_id: 'a', tool: 'web_search', args: { query: 'rust' } },
        { type: 'tool_result', call_id: 'a', ok: true, result: 'x', duration_ms: 1300 },
        { type: 'text', text: 'done' },
      ],
      recovered: [{ what: 'tool', name: 'web_search', attempts: 2, waited_ms: 1200, reason: 'timeout' }],
      priced: true,
    });
    expect(steps.map((s) => s.label)).toEqual([
      'Context gathered',
      'Model call 1',
      'web search',
      'Model call 2',
    ]);
    expect(steps[2]).toMatchObject({ ms: 1300, detail: 'rust' });
    expect(steps[2]?.note).toContain('timed out once, retried');
    expect(steps[1]?.costUsd).toBe(0.001);
  });
  it('shows no time for a tool whose time was never recorded', () => {
    const steps = buildSteps({
      calls: undefined,
      parts: [
        { type: 'tool_call', call_id: 'a', tool: 'fs_read', args: {} },
        { type: 'tool_result', call_id: 'a', ok: true, result: 'x' },
      ],
      recovered: [],
      priced: false,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.ms).toBeNull();
  });
});

/* ---- as a person meets it ----------------------------------------------------- */

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

function answer(u: Usage | null): MessageView {
  return toMessageView({
    id: 'a1',
    thread_id: 't1',
    parent_id: 'u1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Hello' }],
    model_id: 'anthropic/claude-opus-5-5',
    requested_model_id: null,
    status: 'complete',
    edit_of_id: null,
    provenance: { route: { kind: 'model', from: 'thread' } },
    usage: u,
    run_id: null,
    trace_id: 'tr',
    created_at: '2026-10-07T08:31:12Z',
  } as never) as MessageView;
}

const explain = (p: Partial<Explain> = {}): Explain =>
  ({
    message_id: 'a1',
    thread_id: 't1',
    status: 'complete',
    trace_id: 'tr',
    run_id: null,
    model: { id: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5', requested: null, chain: [] },
    attempts: [],
    memory: null,
    retrieval: null,
    retrieval_error: null,
    tools: [],
    compaction: null,
    usage: null,
    factcheck: null,
    error: null,
    recovered: [],
    flow: null,
    scope: null,
    links: [],
    origin: 'ancile',
    trace_url: '/admin/traces?trace=tr',
    ...p,
  }) as Explain;

function Pair({ m }: { m: MessageView }) {
  const facts = receiptFacts(m);
  return (
    <>
      {facts ? <ReceiptStrip messageId={m.id} facts={facts} showCost /> : null}
      <Receipt m={m} threadId="t1" />
    </>
  );
}

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  mocked.get.mockResolvedValue(explain());
  window.scrollTo = vi.fn() as never;
  useUi.setState({ receiptOpen: null, receiptScroll: null, demo: false });
});

describe('the strip and the receipt', () => {
  it('open from the strip and close again, with aria-expanded to match', async () => {
    wrap(<Pair m={answer(usage({ cost_usd: 0.031, ms: 6400 }))} />);
    const strip = screen.getByRole('button', { name: /Receipt: Opus 5.5/ });
    expect(strip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Receipt' })).toBeNull();
    fireEvent.click(strip);
    expect(strip).toHaveAttribute('aria-expanded', 'true');
    expect(strip).toHaveAttribute('aria-controls', 'rc-a1');
    expect(await screen.findByRole('region', { name: 'Receipt' })).toBeInTheDocument();
    expect(screen.getByText('Answered by')).toBeInTheDocument();
    expect(screen.getByText('What it cost')).toBeInTheDocument();
    expect(screen.getByText('Your choice for this thread.')).toBeInTheDocument();
    fireEvent.click(strip);
    expect(strip).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape closes it and puts focus back on the strip', async () => {
    wrap(<Pair m={answer(usage({ ms: 1000 }))} />);
    const strip = screen.getByRole('button', { name: /Receipt:/ });
    fireEvent.click(strip);
    const region = await screen.findByRole('region', { name: 'Receipt' });
    fireEvent.keyDown(region, { key: 'Escape' });
    expect(useUi.getState().receiptOpen).toBeNull();
    expect(strip).toHaveFocus();
  });

  it('what used to open Why opens the receipt', async () => {
    wrap(<Pair m={answer(usage())} />);
    act(() => useUi.getState().showReceipt('a1'));
    expect(await screen.findByRole('region', { name: 'Receipt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Receipt:/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('only one receipt is open at a time', () => {
    act(() => useUi.getState().showReceipt('a1'));
    act(() => useUi.getState().showReceipt('a2'));
    expect(useUi.getState().receiptOpen).toBe('a2');
  });

  it('an older answer shows what is known and says the rest was not recorded', async () => {
    const old = answer({ input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_usd: 0.01 });
    wrap(<Pair m={old} />);
    fireEvent.click(screen.getByRole('button', { name: /Receipt:/ }));
    await screen.findByRole('region', { name: 'Receipt' });
    expect(screen.getAllByText('not recorded').length).toBeGreaterThan(0);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('a provider that reported no cache figures says so instead of 0', async () => {
    wrap(<Pair m={answer(usage({ cache_reported: false, cached_tokens: 0, cache_write_tokens: 0 }))} />);
    fireEvent.click(screen.getByRole('button', { name: /Receipt:/ }));
    await screen.findByRole('region', { name: 'Receipt' });
    expect(screen.getAllByText('not reported')).toHaveLength(2);
  });

  it('an answer with no usage has no strip', () => {
    wrap(<Pair m={answer(null)} />);
    expect(screen.queryByRole('button', { name: /Receipt:/ })).toBeNull();
  });
});

describe('the drawer', () => {
  it('has no Why tab any more, and keeps Evidence', () => {
    const ids = TABS.map((t) => t.id as string);
    expect(ids).not.toContain('why');
    expect(ids).toContain('evidence');
  });
});
