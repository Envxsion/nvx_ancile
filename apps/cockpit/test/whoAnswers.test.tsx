/**
 * FX1: one chip says who answers. It shows a model or a flow; with a flow
 * answering, its menu says where the choice comes from, switches a model
 * step for this thread only, marks a step whose model cannot answer, and
 * offers "Use one model instead". The palette lists the flows beside the
 * models. The old separate flow chip is gone.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ navigate: vi.fn(), path: '/t/thr_1' }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => nav.navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: nav.path } }),
  Link: ({ children }: { children: ReactNode }) => <a href="#x">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...real,
    api: {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      del: vi.fn().mockResolvedValue({}),
    },
  };
});

import { api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { chooseModel } from '../src/lib/models';
import { queryClient } from '../src/lib/query';
import type { ModelView, ThreadView } from '../src/lib/types';
import { Palette } from '../src/palette/Palette';
import { useUi } from '../src/state/ui';
import { flowKeys } from '../src/thread/flowActions';
import { stepLine, WhoAnswers } from '../src/thread/WhoAnswers';

const mocked = api as unknown as Record<'get' | 'patch', ReturnType<typeof vi.fn>>;

const model = (id: string, name: string, p: Partial<ModelView> = {}): ModelView => ({
  id,
  name,
  provider: 'Anthropic',
  hue: 'coral',
  via: 'direct',
  contextWindow: 200_000,
  status: 'ready',
  ...p,
});
const sonnet = model('anthropic/sonnet', 'Sonnet');
const opus = model('anthropic/opus', 'Opus');
const gone = model('anthropic/gone', 'Gone model', { status: 'needs_key' });

const flow = (fallbacks: string[] = []) => ({
  id: 'flw_1',
  name: 'Flow 1',
  nodes: [
    {
      id: 'n1',
      kind: 'model',
      label: 'Writer',
      params: { model: gone.id, role: '', tools: [], fallbacks, speaks: true },
    },
  ],
  edges: [],
});
const summary = (id: string, name: string, scope: string, scope_ref: string | null = null) => ({
  id,
  name,
  description: '',
  scope,
  scope_ref,
  version: 1,
  active: true,
  updated_at: '',
  nodes: 1,
  models: [],
});

function seed(opts: { flow?: boolean; from?: string; fallbacks?: string[]; paused?: boolean } = {}) {
  queryClient.setQueryData(keys.models, [sonnet, opus, gone]);
  queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), {
    id: 'thr_1',
    title: 'Pumps',
    notebookId: 'nb_1',
    model: sonnet.id,
    messages: [],
  } as unknown as ThreadView);
  queryClient.setQueryData(flowKeys.list, [
    summary('flw_1', 'Flow 1', 'notebook', 'nb_1'),
    summary('flw_2', 'Flow 2', 'workspace'),
    summary('flw_3', 'Elsewhere', 'notebook', 'nb_other'),
  ]);
  queryClient.setQueryData(
    flowKeys.resolve('thr_1'),
    opts.flow
      ? { flow: flow(opts.fallbacks), from: opts.from ?? 'notebook' }
      : {
          flow: null,
          from: 'none',
          paused: opts.paused ? { id: 'flw_1', name: 'Flow 1', from: 'notebook' } : null,
        },
  );
}

const chip = (props: Partial<Parameters<typeof WhoAnswers>[0]> = {}) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <WhoAnswers threadId="thr_1" notebookId="nb_1" synced model={sonnet} {...props} />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );

const open = async (name: RegExp) => {
  fireEvent.keyDown(await screen.findByRole('button', { name }), { key: 'Enter' });
  await screen.findAllByRole('menuitem');
};

beforeEach(() => {
  queryClient.clear();
  nav.navigate.mockReset();
  nav.path = '/t/thr_1';
  useUi.setState({ demo: false, paletteOpen: false });
  mocked.get.mockReset();
  mocked.get.mockImplementation(async (path: string) => {
    if (path === '/threads/thr_1') return { settings: {} };
    throw new Error('offline');
  });
  mocked.patch.mockReset();
  mocked.patch.mockResolvedValue({});
});
afterEach(() => useUi.setState({ paletteOpen: false }));

describe('the Who answers chip', () => {
  it('shows the model when no flow answers', async () => {
    seed();
    chip();
    expect(await screen.findByRole('button', { name: 'Sonnet. Change who answers' })).toBeInTheDocument();
  });

  it('shows the flow’s name, and only that, when a flow answers', async () => {
    seed({ flow: true });
    chip();
    const c = await screen.findByRole('button', { name: 'Flow 1, a flow. Change who answers' });
    expect(c).toHaveTextContent('Flow 1');
    expect(c).not.toHaveTextContent('Sonnet');
  });

  it('says where the choice comes from in the menu, not on the chip', async () => {
    seed({ flow: true, from: 'notebook' });
    chip();
    await open(/Flow 1, a flow/);
    expect(screen.getByText('From this notebook')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Flow 1, a flow/ })).not.toHaveTextContent('notebook');
  });

  it('says the same of the workspace’s choice', async () => {
    seed({ flow: true, from: 'workspace' });
    chip();
    await open(/Flow 1, a flow/);
    expect(screen.getByText('From the workspace')).toBeInTheDocument();
  });

  it('switches a step for this thread only, leaving the flow untouched', async () => {
    seed({ flow: true });
    chip();
    await open(/Flow 1, a flow/);
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /^Writer: / }), { key: 'ArrowRight' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Opus' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', {
        flow_overrides: { n1: { model: opus.id } },
        flow_overrides_flow: 'flw_1',
      }),
    );
    // Only the thread is written, never the flow.
    expect(mocked.patch.mock.calls.every(([path]) => String(path).startsWith('/threads/'))).toBe(true);
  });

  it('marks a step whose model cannot answer, with what steps in', async () => {
    seed({ flow: true, fallbacks: [opus.id] });
    chip();
    await open(/Flow 1, a flow/);
    expect(
      screen.getByRole('menuitem', { name: 'Writer: Gone model (unavailable; Opus steps in)' }),
    ).toBeInTheDocument();
  });

  it('says plainly when no fallback is ready, and when a step is switched here', () => {
    expect(stepLine({ label: 'Writer', kind: 'model' }, gone.id, false, [sonnet, gone], [])).toBe(
      'Writer: Gone model (unavailable; no fallback is ready)',
    );
    expect(stepLine({ kind: 'router' }, sonnet.id, true, [sonnet], [])).toBe(
      'router: Sonnet (this thread only)',
    );
  });

  it('"Use one model instead" opens the models, and choosing one pauses the flow here only', async () => {
    seed({ flow: true });
    chip();
    await open(/Flow 1, a flow/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use one model instead' }));
    expect(useUi.getState().paletteOpen).toBe(true);
    expect(useUi.getState().paletteScope).toBe('models');
    await chooseModel(opus, 'thr_1');
    expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { model: opus.id, flow_id: 'off' });
  });

  it('turns the flow off in this thread, asking nothing', async () => {
    seed({ flow: true });
    chip();
    await open(/Flow 1, a flow/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn the flow off in this thread' }));
    await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { flow_id: 'off' }));
  });

  it('offers another flow with where it lives, but not another notebook’s', async () => {
    seed({ flow: true });
    chip();
    await open(/Flow 1, a flow/);
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Use another flow' }), { key: 'ArrowRight' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Flow 2 · Workspace' }));
    await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { flow_id: 'flw_2' }));
    expect(screen.queryByRole('menuitem', { name: /Elsewhere/ })).toBeNull();
  });

  it('keeps an @model for one message on the chip', async () => {
    seed({ flow: true });
    chip({ pick: { label: 'Opus', hue: 'coral' } });
    expect(
      await screen.findByRole('button', { name: 'Opus for this message. Change who answers' }),
    ).toBeInTheDocument();
  });
});

describe('the palette', () => {
  const palette = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <Palette />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  });

  it('lists the flows you can pick, with where each comes from', async () => {
    seed();
    useUi.setState({ paletteOpen: true, paletteScope: 'models', paletteQuery: '' });
    palette();
    const row = await screen.findByRole('option', { name: /Answer with Flow 1/ });
    expect(row).toHaveTextContent('This notebook');
    expect(screen.getByRole('option', { name: /Answer with Flow 2/ })).toHaveTextContent('Workspace');
    expect(screen.queryByRole('option', { name: /Elsewhere/ })).toBeNull();
  });

  it('"Answer with Flow 2" sets the thread’s flow', async () => {
    seed();
    useUi.setState({ paletteOpen: true, paletteScope: 'all', paletteQuery: '' });
    palette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Answer with Flow 2' } });
    await act(() => new Promise((r) => setTimeout(r, 30)));
    fireEvent.click(await screen.findByRole('option', { name: /Answer with Flow 2/ }));
    await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { flow_id: 'flw_2' }));
  });

  it('turns a paused flow back on by following it again', async () => {
    seed({ paused: true });
    useUi.setState({ paletteOpen: true, paletteScope: 'models', paletteQuery: '' });
    palette();
    const row = await screen.findByRole('option', { name: /Answer with Flow 1/ });
    expect(row).toHaveTextContent('paused here');
    fireEvent.click(row);
    await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { flow_id: null }));
  });
});

describe('the old flow chip', () => {
  it('is gone', () => {
    const here = (p: string) => resolve(__dirname, '../src', p);
    expect(existsSync(here('thread/FlowChip.tsx'))).toBe(false);
    expect(existsSync(here('thread/ModelChoice.tsx'))).toBe(false);
  });
});
