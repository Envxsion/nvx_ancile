/**
 * OpenRouter in the Cockpit: endpoint table warnings, routing presets and
 * the Auto Exacto note, the served provider and retry in Why, the cost
 * calculator, the model assistant and the local precision picker.
 */
import type { CostEstimate, EndpointsReport, LocalModelView, RoutingPreview, Usage } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/turns', () => ({ regenerate: vi.fn(async () => undefined) }));

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { regenerate } from '../src/lib/turns';
import { quantOptions } from '../src/models/QuantPicker';
import { DEFAULT_ROUTING } from '../src/openrouter/api';
import { CostCalculator } from '../src/openrouter/CostCalculator';
import { EndpointTable } from '../src/openrouter/EndpointExplorer';
import { ModelAdvisor } from '../src/openrouter/ModelAdvisor';
import { RoutingControls } from '../src/openrouter/RoutingControls';
import { roomierRouting, ServedBy } from '../src/openrouter/ServedBy';

const mocked = api as unknown as Record<'get' | 'post' | 'put', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const REPORT: EndpointsReport = {
  model: 'qwen/qwen3-coder',
  name: 'Qwen3 Coder',
  native_context: 262144,
  original_precision: { precision: 'bf16', source: 'https://huggingface.co/Qwen' },
  fetched_at: '2026-10-12T10:00:00.000Z',
  offline: true,
  endpoints: [
    {
      provider: 'Tiny',
      tag: null,
      precision: 'bf16',
      original_precision: true,
      context: 24000,
      context_pct: 9.2,
      max_output: 4096,
      tools: false,
      price: { input: 0.1, output: 0.4, cache_read: null, cache_write: null },
      uptime: 82,
      supported_parameters: [],
      warnings: [
        { code: 'short_context', text: 'This endpoint can only read 9% of what the model can.' },
        { code: 'short_output', text: 'Answers capped at 4,096 tokens: reasoning will be cut off.' },
        { code: 'no_tools', text: "Can't use tools." },
      ],
    },
  ],
};

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
});
afterEach(cleanup);

describe('endpoint explorer', () => {
  it('shows plain columns, warnings in words and that it is offline', () => {
    wrap(<EndpointTable report={REPORT} />);
    expect(screen.getByText('BF16, original')).toBeTruthy();
    expect(screen.getByText('This endpoint can only read 9% of what the model can.')).toBeTruthy();
    expect(screen.getByText('Answers capped at 4,096 tokens: reasoning will be cut off.')).toBeTruthy();
    expect(screen.getByText("Can't use tools.")).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.getByText(/Offline: this list was read/)).toBeTruthy();
  });

  it('explains Auto, which has no providers of its own', () => {
    wrap(<EndpointTable report={{ ...REPORT, model: 'openrouter/auto', endpoints: [] }} />);
    expect(screen.getByText(/Auto picks a model for each request/)).toBeTruthy();
  });
});

describe('routing controls', () => {
  it('says when a preset turns Auto Exacto off, and shows what is sent', async () => {
    const preview: RoutingPreview = {
      provider: { require_parameters: true, sort: 'throughput' },
      max_tokens: 4000,
      auto_exacto: false,
      notes: ['Sorted by speed (like the :nitro suffix, without its priority tier).'],
    };
    mocked.post.mockResolvedValue(preview);
    const onChange = vi.fn();
    wrap(
      <RoutingControls
        model="qwen/qwen3-coder"
        value={{ ...DEFAULT_ROUTING, preset: 'fastest' }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/Auto Exacto is off with this choice/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Sorted by speed/)).toBeTruthy());
    expect(mocked.post).toHaveBeenCalledWith('/openrouter/routing/preview', {
      model: 'qwen/qwen3-coder',
      settings: { ...DEFAULT_ROUTING, preset: 'fastest' },
    });
    fireEvent.click(screen.getByLabelText(/^Recommended/));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_ROUTING, preset: 'recommended' });
  });

  it('Recommended does not warn about Auto Exacto', () => {
    mocked.post.mockResolvedValue({ provider: {}, max_tokens: null, auto_exacto: true, notes: [] });
    wrap(<RoutingControls model="m/x" value={DEFAULT_ROUTING} onChange={() => undefined} />);
    expect(screen.queryByText(/Auto Exacto is off/)).toBeNull();
  });
});

describe('which provider served', () => {
  const usage: Usage = {
    input_tokens: 100,
    output_tokens: 4096,
    cached_tokens: 0,
    cost_usd: 0.01,
    served: { provider: 'Tiny', model: 'qwen/qwen3-coder', cut_off: true },
  };

  it('shows the provider and offers a roomier retry when cut off', async () => {
    mocked.get.mockResolvedValue({ settings: null });
    mocked.put.mockResolvedValue({});
    queryClient.setQueryData(['thread', 't1'], { messages: [{ id: 'm1', parentId: 'u1' }] });
    wrap(<ServedBy usage={usage} threadId="t1" messageId="m1" />);
    expect(screen.getByText('Tiny')).toBeTruthy();
    expect(screen.getByText("Cut off by this endpoint's output limit.")).toBeTruthy();
    fireEvent.click(screen.getByText('Retry on an endpoint with more room'));
    await waitFor(() => expect(regenerate).toHaveBeenCalled());
    expect(mocked.put).toHaveBeenCalledWith('/openrouter/routing', {
      scope: 'thread',
      id: 't1',
      settings: { ...DEFAULT_ROUTING, avoid: ['Tiny'], max_tokens: 8192 },
    });
  });

  it('shows nothing for other providers', () => {
    const { container } = wrap(
      <ServedBy usage={{ ...usage, served: undefined }} threadId="t" messageId="m" />,
    );
    expect(container.textContent).toBe('');
  });

  it('a retry keeps the choice and grows the room', () => {
    expect(
      roomierRouting({ ...DEFAULT_ROUTING, preset: 'pinned', avoid: ['A'], max_tokens: 20_000 }, 'B', 6_000),
    ).toMatchObject({
      preset: 'pinned',
      avoid: ['A', 'B'],
      max_tokens: 20_000,
    });
  });
});

describe('cost calculator', () => {
  it('ranks by real cost and says where the hit rate came from', async () => {
    const est: CostEstimate = {
      model: 'qwen/qwen3-coder',
      cache_hit_rate: 0.8,
      cache_hit_from: 'history',
      rows: [
        { provider: 'Venice', per_turn: 0.002, per_day: 0.1, per_month: 3, list_per_turn: 0.004, fits: true },
      ],
      runpod: { usd_per_hour: 1, break_even_tokens_per_month: 900_000_000, hours_needed_per_month: 16.7 },
      claude_code: { used_percent: 40, note: "Claude Code's plan is 40% used in its busiest window." },
    };
    mocked.post.mockResolvedValue(est);
    wrap(<CostCalculator model="qwen/qwen3-coder" />);
    await waitFor(() => expect(screen.getByText(/80%, from your own use/)).toBeTruthy());
    expect(screen.getByText('Venice')).toBeTruthy();
    expect(screen.getByText(/pays for itself above 900 million tokens/)).toBeTruthy();
    expect(screen.getByText(/40% used/)).toBeTruthy();
  });
});

describe('model assistant', () => {
  it('asks Core and shows reasons and the preset', async () => {
    mocked.post.mockResolvedValue({
      kind: 'coding',
      explanation: null,
      options: [
        {
          where: 'openrouter',
          model_id: 'openrouter/qwen3-coder',
          name: 'Qwen3 Coder',
          score: 80,
          reasons: ['Can call tools.'],
          preset: 'recommended',
          cost_per_1k_turns: 9.4,
        },
      ],
    });
    wrap(<ModelAdvisor />);
    fireEvent.change(screen.getByLabelText('What is the job?'), { target: { value: 'fix bugs in my repo' } });
    fireEvent.click(screen.getByText('Suggest models'));
    await waitFor(() => expect(screen.getByText('Qwen3 Coder')).toBeTruthy());
    expect(screen.getByText('Can call tools.')).toBeTruthy();
    expect(screen.getByText('Routing: Recommended')).toBeTruthy();
    expect(mocked.post.mock.calls[0]?.[1]).toMatchObject({ describe: 'fix bugs in my repo', explain: false });
  });
});

describe('local precision', () => {
  it('estimates size and memory for each listed tag', () => {
    const opts = quantOptions({
      params_b: 8,
      context_window: 40960,
      quant_tags: { q4_K_M: 'qwen3:8b-q4_K_M', fp16: 'qwen3:8b-fp16' },
    } as LocalModelView);
    expect(opts.map((o) => o.quant)).toEqual(['q4_K_M', 'fp16']);
    expect(opts[0]?.size_gb).toBeCloseTo(4.9, 1);
    expect(opts[1]?.size_gb).toBe(16);
    expect((opts[1]?.memory_gb ?? 0) > (opts[0]?.memory_gb ?? 0)).toBe(true);
    expect(quantOptions({ context_window: 1 } as LocalModelView)).toEqual([]);
  });
});
