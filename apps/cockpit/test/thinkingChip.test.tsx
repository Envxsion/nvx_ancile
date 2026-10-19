/**
 * The Thinking toggle: on or off for the thread, saved with PATCH /threads/:id { thinking }, and
 * the menu says once that changing it re-reads the conversation (a new prompt epoch).
 */

import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { ...real.api, get: vi.fn(), patch: vi.fn().mockResolvedValue({}) } };
});

import { api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { toModelView } from '../src/lib/mappers';
import { queryClient } from '../src/lib/query';
import type { ThreadView } from '../src/lib/types';
import { ThinkingChip } from '../src/thread/ThinkingChip';

const seed = (thinking?: boolean) =>
  queryClient.setQueryData<ThreadView>(keys.thread('t1'), {
    id: 't1',
    title: 'Pumps',
    notebookId: null,
    messages: [],
    ...(thinking !== undefined && { thinking }),
  } as unknown as ThreadView);
const wrap = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <ThinkingChip threadId="t1" />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.mocked(api.patch).mockClear();
});

describe('the Thinking toggle', () => {
  it('turns on, saves it on the thread, and warns once that the conversation is read again', async () => {
    seed(false);
    wrap();
    fireEvent.keyDown(await screen.findByRole('button', { name: /^Thinking: off/ }), { key: 'Enter' });
    expect(await screen.findByText('Changing this re-reads the conversation on the next turn')).toBeTruthy();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'On' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/threads/t1', { thinking: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Thinking: on/ })).toBeTruthy());
  });

  it('turns off again', async () => {
    seed(true);
    wrap();
    fireEvent.keyDown(await screen.findByRole('button', { name: /^Thinking: on/ }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Off' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/threads/t1', { thinking: false }));
  });
});

describe('which models get the toggle', () => {
  const info = (capabilities: string[]) =>
    toModelView({
      id: 'm',
      display_name: 'M',
      provider: 'anthropic',
      provider_model: 'm',
      family: 'claude',
      via: 'direct',
      context_window: 1000,
      max_output: 100,
      capabilities,
      price: { input_per_mtok: 1, output_per_mtok: 1 },
      status: 'ready',
      billing: { kind: 'key', payer: 'anthropic' },
      offline: false,
    } as never);

  it('reads the effective capabilities Core sends', () => {
    expect(info(['tools', 'reasoning']).reasoning).toBe(true);
    expect(info(['tools']).reasoning).toBeUndefined();
  });
});
