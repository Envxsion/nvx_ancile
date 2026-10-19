/**
 * KP1, EN1 and LM1 (Pro seams): in a build without Pro, each Pro piece shows a gilt card that
 * says what it is and what unlocks it, never a broken control. The effort chip keeps per-thread
 * effort free; commands of your own, a notebook's effort default and local model presets are Pro.
 */

import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { ...real.api, get: vi.fn(), patch: vi.fn().mockResolvedValue({}) } };
});

import { api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import type { ThreadView } from '../src/lib/types';
import { LocalPresets } from '../src/models/LocalPresets';
import { NotebookEffortDialog } from '../src/pro/NotebookEffort';
import { openCommandsDialog, UserCommandsHost, useCommandsDialog } from '../src/pro/UserCommands';
import { EffortChip } from '../src/thread/EffortChip';

const free = {
  build: 'free',
  features: [
    { id: 'flow_lab', unlocked: false },
    { id: 'fleet', unlocked: false },
  ],
};
const get = vi.mocked(api.get);
const answer = (routes: Record<string, unknown>) =>
  get.mockImplementation(async (path: string) => {
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) throw new Error(`unmocked ${path}`);
    return hit[1] as never;
  });
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  act(() => useCommandsDialog.getState().hide());
  queryClient.clear();
  get.mockReset();
});

describe('the effort chip in a notebook, without Pro', () => {
  const seed = (notebookId: string | null) =>
    queryClient.setQueryData<ThreadView>(keys.thread('t1'), {
      id: 't1',
      title: 'Pumps',
      notebookId,
      messages: [],
      effort: null,
    } as unknown as ThreadView);

  it('keeps the thread’s levels free and marks Auto and the notebook default as Pro', async () => {
    answer({ '/license/details': free });
    seed('nb1');
    wrap(<EffortChip threadId="t1" levels={['low', 'medium', 'high']} />);
    fireEvent.keyDown(await screen.findByRole('button', { name: /^Thinking effort/ }), { key: 'Enter' });
    await screen.findByRole('menuitem', { name: 'Auto (Pro)' });
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Model default',
      'Low',
      'Medium',
      'High',
      'Auto (Pro)',
      'Notebook default (Pro)',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Auto (Pro)' }));
    expect(await screen.findByText('Effort for the whole notebook')).toBeTruthy();
    expect(await screen.findByText(/part of NVX Ancile Pro, which this build does not include/)).toBeTruthy();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('offers no Pro rows in a thread outside a notebook, where there is nothing to hold a default', async () => {
    answer({ '/license/details': free });
    seed(null);
    wrap(<EffortChip threadId="t1" levels={['low', 'high']} />);
    fireEvent.keyDown(await screen.findByRole('button', { name: /^Thinking effort/ }), { key: 'Enter' });
    await screen.findByRole('menuitem', { name: 'High' });
    expect(screen.queryByRole('menuitem', { name: /Pro\)$/ })).toBeNull();
  });

  it('explains the notebook’s own effort dialog, and says per-thread effort is free', async () => {
    answer({ '/license/details': free });
    wrap(<NotebookEffortDialog notebookId="nb1" title="Pump trial" onClose={() => undefined} />);
    expect(await screen.findByText('Thinking effort for Pump trial')).toBeTruthy();
    expect(await screen.findByText(/Thinking effort for a single thread is free/)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('your commands, without Pro', () => {
  it('opens a card that says what they are and what unlocks them', async () => {
    answer({ '/license/details': free });
    wrap(<UserCommandsHost actions={[]} flows={[]} notebooks={[]} notebookId={null} />);
    expect(screen.queryByText('Your commands')).toBeNull();
    act(() => openCommandsDialog());
    expect(await screen.findByText('Your commands')).toBeTruthy();
    expect(await screen.findByText(/Name a chain of palette actions/)).toBeTruthy();
    expect(await screen.findByText(/part of NVX Ancile Pro, which this build does not include/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New command' })).toBeNull();
  });
});

describe('local model presets, without Pro', () => {
  const local = (installed: boolean) => ({
    hardware: {},
    ollama: { status: 'running' },
    items: [
      {
        id: 'qwen',
        name: 'Qwen',
        kind: 'chat',
        via: 'ollama',
        installed,
        model_id: installed ? 'ollama/qwen' : null,
      },
    ],
  });

  it('shows the card under the local models you have', async () => {
    answer({
      '/license/details': free,
      '/local-models/loaded': { state: 'ok', local: true, items: [], memory_bytes: null, crowded: false },
      '/local-models': local(true),
      '/notebooks': [],
    });
    wrap(<LocalPresets />);
    expect(await screen.findByText('Local model presets', { selector: 'h2' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/Keep a model in memory for as long as you want/)).toBeTruthy(),
    );
    expect(screen.getByText(/part of NVX Ancile Pro, which this build does not include/)).toBeTruthy();
  });

  it('shows nothing when no local chat model is installed', async () => {
    answer({
      '/license/details': free,
      '/local-models/loaded': { state: 'ok', local: true, items: [], memory_bytes: null, crowded: false },
      '/local-models': local(false),
      '/notebooks': [],
    });
    wrap(<LocalPresets />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/local-models'));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Local model presets', { selector: 'h2' })).toBeNull();
  });
});
