/**
 * ------------------------------------------------------------------
 *  Title    |  The fit line before a switch (HO1)
 *  Ref      |  ROADMAP.md HO1 · src/models/fit.ts, FitNotice.tsx
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Picking a model asks Core whether the thread fits it.
 *           |  Nothing shows when it fits and the switch is immediate;
 *           |  when it does not, one line says so with two choices,
 *           |  and the switch waits for one of them.
 * ------------------------------------------------------------------
 */

import type { PathBudget } from '@nvx/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { chooseModel } from '../src/lib/models';
import { queryClient } from '../src/lib/query';
import type { ModelView } from '../src/lib/types';
import { FitNotice } from '../src/models/FitNotice';
import { fitLine, useFitAsk } from '../src/models/fit';
import { useUi } from '../src/state/ui';

const mocked = api as unknown as Record<'get' | 'post' | 'patch', ReturnType<typeof vi.fn>>;

const small: ModelView = {
  id: 'openai/small',
  name: 'Small 128k',
  provider: 'OpenAI',
  hue: 'azure',
  via: 'direct',
  contextWindow: 128_000,
  status: 'ready',
};

const budget = (fit: PathBudget['fit']): PathBudget =>
  ({ head_id: 'm', model_id: small.id, window: 128_000, fit }) as PathBudget;

beforeEach(() => {
  useUi.setState({ demo: false });
  useFitAsk.setState({ ask: null });
  for (const f of Object.values(mocked)) f.mockReset();
  mocked.patch.mockResolvedValue({});
  mocked.post.mockResolvedValue({
    summary_id: 's',
    upto_message_id: 'm',
    replaced_messages: 4,
    tokens_before: 340_000,
    tokens_after: 120_000,
    model_id: null,
    reused: false,
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('wording', () => {
  it('says what it takes, from how much to how much, and that the thread stays', () => {
    expect(fitLine({ model: small, before: 340_000, after: 120_000 })).toBe(
      'Needs summarising to fit (about 340k → 120k). The full thread stays.',
    );
    expect(fitLine({ model: small, before: 340_000, after: null })).toBe(
      'Too long for Small 128k, even summarised. The full thread stays.',
    );
  });
});

describe('picking a model', () => {
  it('switches at once and shows nothing when the thread fits', async () => {
    mocked.get.mockResolvedValue(
      budget({
        needs_summary: false,
        tokens_now: 90_000,
        tokens_after: null,
        level: 'full',
        summary_ready: false,
      }),
    );
    render(<FitNotice threadId="thr_1" />);
    await chooseModel(small, 'thr_1');
    expect(mocked.get).toHaveBeenCalledWith('/threads/thr_1/context-budget?model=openai%2Fsmall');
    expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { model: small.id });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('waits and shows one line with two choices when the thread will not fit', async () => {
    mocked.get.mockResolvedValue(
      budget({
        needs_summary: true,
        tokens_now: 340_000,
        tokens_after: 120_000,
        level: 'page',
        summary_ready: false,
      }),
    );
    render(<FitNotice threadId="thr_1" />);
    await chooseModel(small, 'thr_1');
    expect(mocked.patch).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Needs summarising to fit (about 340k → 120k). The full thread stays.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Switch and summarise' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pick another' })).toBeTruthy();
  });

  it('summarises for that model, then switches', async () => {
    mocked.get.mockResolvedValue(
      budget({
        needs_summary: true,
        tokens_now: 340_000,
        tokens_after: 120_000,
        level: 'page',
        summary_ready: false,
      }),
    );
    render(<FitNotice threadId="thr_1" />);
    await chooseModel(small, 'thr_1');
    fireEvent.click(await screen.findByRole('button', { name: 'Switch and summarise' }));
    await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { model: small.id }));
    expect(mocked.post).toHaveBeenCalledWith('/threads/thr_1/compact', { model: small.id });
    // It does not ask again after the person chose.
    expect(mocked.get).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not summarise again when a summary that fits already exists', async () => {
    mocked.get.mockResolvedValue(
      budget({
        needs_summary: true,
        tokens_now: 340_000,
        tokens_after: 120_000,
        level: 'page',
        summary_ready: true,
      }),
    );
    render(<FitNotice threadId="thr_1" />);
    await chooseModel(small, 'thr_1');
    fireEvent.click(await screen.findByRole('button', { name: 'Switch and summarise' }));
    await waitFor(() => expect(mocked.patch).toHaveBeenCalled());
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('stays where it is on Pick another', async () => {
    mocked.get.mockResolvedValue(
      budget({
        needs_summary: true,
        tokens_now: 340_000,
        tokens_after: 120_000,
        level: 'page',
        summary_ready: false,
      }),
    );
    render(<FitNotice threadId="thr_1" />);
    await chooseModel(small, 'thr_1');
    fireEvent.click(await screen.findByRole('button', { name: 'Pick another' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocked.patch).not.toHaveBeenCalled();
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('offers only Pick another when no summary can make it fit', async () => {
    mocked.get.mockResolvedValue(
      budget({
        needs_summary: true,
        tokens_now: 340_000,
        tokens_after: null,
        level: 'line',
        summary_ready: false,
      }),
    );
    render(<FitNotice threadId="thr_1" />);
    await chooseModel(small, 'thr_1');
    expect(
      await screen.findByText('Too long for Small 128k, even summarised. The full thread stays.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Switch and summarise' })).toBeNull();
  });

  it('switches when Core cannot say (no information is not a gate)', async () => {
    mocked.get.mockRejectedValue(new Error('offline'));
    await chooseModel(small, 'thr_1');
    expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { model: small.id });
  });

  it('asks nothing outside a thread', async () => {
    await chooseModel(small);
    expect(mocked.get).not.toHaveBeenCalled();
  });
});
