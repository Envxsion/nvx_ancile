/**
 * ------------------------------------------------------------------
 *  Title    |  Who pays for a model (MD3)
 *  Ref      |  docs/claude-code.md (Plan or key)
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  The same Claude model on a plan and on an API key is
 *           |  labelled in every list; a thread on the key is offered
 *           |  the plan once, never switched; Admin → Models groups by
 *           |  who pays.
 * ------------------------------------------------------------------
 */

import type { ModelBilling } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { GROUP_NOTE, modelGroups } from '../src/engines/api';
import { api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import type { ModelView } from '../src/lib/types';
import {
  billingBadge,
  billingTitle,
  billingWords,
  displayName,
  modelBadge,
  planTwinOf,
  sameModelBothWays,
} from '../src/models/billing';
import { PlanNotice } from '../src/models/PlanNotice';
import { groupModels, ModelBlocksView } from '../src/routes/admin/modelBlocks';
import { EMPTY_LIVE, useUi } from '../src/state/ui';

const mocked = api as unknown as Record<'get' | 'post' | 'patch', ReturnType<typeof vi.fn>>;

const m = (id: string, name: string, billing: ModelBilling, p: Partial<ModelView> = {}): ModelView => ({
  id,
  name,
  provider: 'Anthropic',
  hue: 'coral',
  via: 'direct',
  contextWindow: 200_000,
  status: 'ready',
  chat: true,
  billing,
  price: { in: 0, out: 0 },
  ...p,
});

const OPUS_PLAN = m('claude-code/opus', 'Claude Code: Opus', { kind: 'plan', payer: 'max' });
const OPUS_KEY = m(
  'anthropic/claude-opus-5-5',
  'Claude Opus 5.5',
  { kind: 'key', payer: 'anthropic' },
  { price: { in: 5, out: 25 } },
);
const GPT = m(
  'openai/gpt-5.5',
  'GPT-5.5',
  { kind: 'key', payer: 'openai' },
  { provider: 'OpenAI', price: { in: 2, out: 10 } },
);
const QWEN = m('ollama/qwen3', 'Qwen3 14B', { kind: 'local', payer: null }, { provider: 'Ollama' });
const NODE = m(
  'node/qwen3-72b',
  'Qwen3 72B',
  { kind: 'local', payer: null },
  { provider: 'Your GPU node', via: 'controller' },
);

describe('billing words', () => {
  it('says who pays in plain words', () => {
    expect(billingWords({ kind: 'plan', payer: 'max' })).toBe('Your Claude Max plan');
    expect(billingWords({ kind: 'plan', payer: 'pro' })).toBe('Your Claude Pro plan');
    expect(billingWords({ kind: 'plan', payer: null })).toBe('Your Claude plan');
    expect(billingWords({ kind: 'key', payer: 'anthropic' })).toBe('Anthropic API key, pay per use');
    expect(billingWords({ kind: 'key', payer: 'openai' })).toBe('OpenAI API key, pay per use');
    expect(billingWords({ kind: 'key', payer: 'bedrock' })).toBe('Amazon Bedrock, pay per use');
    expect(billingWords({ kind: 'key', payer: 'vertex' })).toBe('Google Vertex AI, pay per use');
    expect(billingWords({ kind: 'key', payer: 'foundry' })).toBe('Microsoft Foundry, pay per use');
    expect(billingWords({ kind: 'local', payer: null })).toBe('Your computer');
    expect(billingWords({ kind: 'rented', payer: null })).toBe('Rented GPU, billed by the hour');
    expect(billingWords({ kind: 'none', payer: null })).toBe('Offline test model, no cost');
  });

  it('badges and titles', () => {
    expect(
      (['plan', 'key', 'local', 'rented', 'none'] as const).map((kind) =>
        billingBadge({ kind, payer: null }),
      ),
    ).toEqual(['Plan', 'Key', 'Local', 'Rented', 'Test']);
    expect(billingTitle({ kind: 'plan', payer: 'max' })).toBe(
      'Your Claude Max plan, counted against its limits',
    );
    expect(billingTitle({ kind: 'key', payer: 'anthropic' }, { in: 2, out: 10 })).toBe(
      'Anthropic API key, pay per use: $2 in, $10 out per million tokens',
    );
    expect(billingTitle({ kind: 'key', payer: 'anthropic' }, { in: 0, out: 0 })).toBe(
      'Anthropic API key, pay per use',
    );
    expect(modelBadge(NODE)).toBe('GPU node');
    expect(modelBadge(QWEN)).toBe('Local');
  });
});

describe('the same model both ways', () => {
  it('finds a Claude line on the plan and on the key, and only those', () => {
    const dupes = sameModelBothWays([OPUS_PLAN, OPUS_KEY, GPT, QWEN]);
    expect([...dupes].sort()).toEqual(['anthropic/claude-opus-5-5', 'claude-code/opus']);
    expect(displayName(OPUS_PLAN, dupes)).toBe('Claude Code: Opus · Max plan');
    expect(displayName(OPUS_KEY, dupes)).toBe('Claude Opus 5.5 · API key');
    expect(displayName(GPT, dupes)).toBe('GPT-5.5');
  });

  it('leaves names alone when a side is missing or cannot answer', () => {
    expect(sameModelBothWays([OPUS_PLAN]).size).toBe(0);
    expect(sameModelBothWays([OPUS_KEY]).size).toBe(0);
    expect(sameModelBothWays([{ ...OPUS_PLAN, status: 'signed_out' }, OPUS_KEY]).size).toBe(0);
    const sonnetKey = m('anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5', {
      kind: 'key',
      payer: 'anthropic',
    });
    expect(sameModelBothWays([OPUS_PLAN, sonnetKey]).size).toBe(0);
  });

  it('finds the plan twin of a key model', () => {
    expect(planTwinOf(OPUS_KEY, [OPUS_PLAN, OPUS_KEY])?.id).toBe('claude-code/opus');
    expect(planTwinOf(GPT, [OPUS_PLAN, GPT])).toBeNull();
    expect(planTwinOf(OPUS_KEY, [OPUS_KEY])).toBeNull();
  });
});

describe('the model picker groups', () => {
  const groups = modelGroups({
    models: [OPUS_PLAN, OPUS_KEY, GPT, QWEN, NODE],
    engines: undefined,
    scope: undefined,
    session: null,
    currentId: null,
  });

  it('badges each entry by who pays and says how each group runs', () => {
    const entries = groups.flatMap((g) => g.items);
    const badge = (id: string) => entries.find((e) => e.id === id)?.badge;
    expect(badge('claude-code/opus')).toBe('Plan');
    expect(badge('anthropic/claude-opus-5-5')).toBe('Key');
    expect(badge('ollama/qwen3')).toBe('Local');
    expect(badge('node/qwen3-72b')).toBe('GPU node');
    expect(entries.find((e) => e.id === 'claude-code/opus')?.badgeTitle).toBe(
      'Your Claude Max plan, counted against its limits',
    );
    expect(groups.map((g) => g.note)).toEqual([
      'Runs as Claude Code, with its own tools and session.',
      "Runs through NVX Ancile, with your notebook's tools, memory and sources.",
      null,
    ]);
    expect(GROUP_NOTE.local).toBeNull();
  });

  it('names the same model on the plan and on the key differently', () => {
    const names = groups.flatMap((g) => g.items).map((e) => e.name);
    expect(names).toContain('Claude Code: Opus · Max plan');
    expect(names).toContain('Claude Opus 5.5 · API key');
  });
});

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  mocked.get.mockRejectedValue(new Error('not mocked'));
  mocked.patch.mockResolvedValue({});
  useUi.setState({
    demo: false,
    live: { ...EMPTY_LIVE, modelId: OPUS_KEY.id },
    planNoticeDone: {},
  });
  queryClient.setQueryData(keys.models, [OPUS_PLAN, OPUS_KEY, GPT]);
});
afterEach(() => cleanup());

describe('the one-time plan notice', () => {
  it('shows when the thread is on the key and the plan could answer, and Use my plan switches', async () => {
    wrap(<PlanNotice threadId="thr_1" />);
    expect(
      await screen.findByText(/Claude Opus 5\.5 bills your Anthropic API key per use\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Your Claude Max plan can answer this as Claude Code/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use my plan' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { model: 'claude-code/opus' }),
    );
    expect(useUi.getState().planNoticeDone.thr_1).toBe(true);
  });

  it('Keep the API key dismisses it for the thread and changes nothing', async () => {
    const { rerender } = wrap(<PlanNotice threadId="thr_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep the API key' }));
    expect(mocked.patch).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/bills your Anthropic API key/)).toBeNull());
    rerender(
      <QueryClientProvider client={queryClient}>
        <PlanNotice threadId="thr_1" />
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/bills your Anthropic API key/)).toBeNull();
    // Another thread still gets its one notice.
    cleanup();
    wrap(<PlanNotice threadId="thr_2" />);
    expect(await screen.findByText(/bills your Anthropic API key per use/)).toBeInTheDocument();
  });

  it('stays away when the plan cannot answer or the model is not on the key', async () => {
    queryClient.setQueryData(keys.models, [{ ...OPUS_PLAN, status: 'signed_out' }, OPUS_KEY]);
    wrap(<PlanNotice threadId="thr_1" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/bills your Anthropic API key/)).toBeNull();
  });
});

describe('Admin → Models grouped by who pays', () => {
  it('groups models into subscriptions, API keys and your own computers', () => {
    const g = groupModels([OPUS_PLAN, OPUS_KEY, GPT, QWEN, NODE]);
    expect(g.subscription.map((x) => x.id)).toEqual(['claude-code/opus']);
    expect(g.keys.map((k) => k.title)).toEqual(['Anthropic API key', 'OpenAI API key']);
    expect(g.local.map((x) => x.id)).toEqual(['ollama/qwen3', 'node/qwen3-72b']);
  });

  it('lists Claude Code on an API key under API keys, labelled', () => {
    const onKey = { ...OPUS_PLAN, billing: { kind: 'key', payer: 'bedrock' } } as ModelView;
    const g = groupModels([onKey, GPT]);
    expect(g.subscription).toEqual([]);
    expect(g.keys[0]?.title).toBe('Claude Code on Amazon Bedrock');
  });

  it('shows the plan, the account and the models; prices on keys', async () => {
    mocked.get.mockImplementation(async (path: string) => {
      if (path === '/claude-code/status')
        return {
          signed_in: true,
          installed: true,
          account: 'me@example.com',
          plan: 'max',
          install: { state: 'idle' },
        };
      if (path === '/credentials')
        return { items: [{ id: 'openai', set: true, last4: '4f2a', source: 'saved' }] };
      return { available: false, windows: [], can_refresh: false };
    });
    wrap(<ModelBlocksView models={[OPUS_PLAN, GPT, QWEN]} />);
    const subs = await screen.findByRole('region', { name: 'Subscriptions' });
    expect(within(subs).getByText('Claude Code: Opus')).toBeInTheDocument();
    expect(
      await within(subs).findByText(/Your Claude Max plan · Signed in as me@example\.com/),
    ).toBeInTheDocument();
    const keysBlock = screen.getByRole('region', { name: 'OpenAI API key' });
    expect(within(keysBlock).getByText(/\$2 in · \$10 out per M/)).toBeInTheDocument();
    expect(await within(keysBlock).findByText('Saved · ends in 4f2a')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'On your computer and GPU nodes' })).toBeInTheDocument();
  });

  it('greys Claude Code out with a Sign in action while signed out', async () => {
    mocked.get.mockImplementation(async (path: string) =>
      path === '/claude-code/status'
        ? { signed_in: false, installed: true, install: { state: 'idle' } }
        : { items: [] },
    );
    mocked.post.mockResolvedValue({ started: true });
    const signedOut = { ...OPUS_PLAN, status: 'signed_out' } as ModelView;
    wrap(<ModelBlocksView models={[signedOut]} />);
    const subs = await screen.findByRole('region', { name: 'Subscriptions' });
    expect(subs.querySelector('[data-signed-out]')).not.toBeNull();
    fireEvent.click(within(subs).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/claude-code/sign-in'));
  });
});
