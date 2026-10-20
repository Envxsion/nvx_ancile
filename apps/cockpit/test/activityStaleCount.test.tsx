/**
 * ------------------------------------------------------------------
 *  Title    |  "1 running" corrects itself
 *  Ref      |  apps/cockpit/src/activity/api.ts
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  The count on the status bar comes from events. One that
 *           |  never arrived (a reconnect) left "1 running" there while
 *           |  Core said nothing ran. While anything is counted, the
 *           |  list is asked for again, panel open or not.
 * ------------------------------------------------------------------
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { LIVE_POLL_MS, useActivity, useActivityPanel } from '../src/activity/api';
import { api } from '../src/lib/api';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useActivityPanel.setState({ running: 0, open: false });
});

describe('the running count on the status bar', () => {
  it('is asked for again while it says something runs, even with the panel shut, and clears when Core says 0', async () => {
    vi.useFakeTimers();
    // Core said 1 when the run began; the event that said it ended never came.
    vi.mocked(api.get).mockResolvedValueOnce({ running: 1, items: [] });
    vi.mocked(api.get).mockResolvedValue({ running: 0, items: [] });
    useActivityPanel.setState({ running: 0, open: false });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    renderHook(() => useActivity(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(useActivityPanel.getState().running).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 50);
    });
    expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(1);
    expect(useActivityPanel.getState().running).toBe(0);
  });
});
