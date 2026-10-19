/**
 * LM1: "Loaded now" in Admin → Models lists the Ollama models in memory with
 * Unload and Keep loaded, and picking an Ollama model starts loading it with
 * a small dot, once for rapid switching and never on battery.
 */
import type { LoadedModelsView } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { LoadedNow, sizeWords, unloadWords } from '../src/models/LoadedNow';
import { DEBOUNCE_MS, onBattery, warmable, warmOnPick } from '../src/models/warming';
import { useWarming, WarmingDot } from '../src/models/warmStore';

const mocked = vi.mocked(api);
const GiB = 1024 ** 3;

const view = (over: Partial<LoadedModelsView> = {}): LoadedModelsView => ({
  state: 'ok',
  local: true,
  memory_bytes: 16 * GiB,
  crowded: false,
  items: [
    {
      name: 'qwen3:8b',
      model_id: 'ollama/qwen3-8b',
      display_name: 'Qwen3 8B',
      size_bytes: Math.round(5.2 * GiB),
      vram_bytes: Math.round(5.2 * GiB),
      expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
      keep_loaded: false,
      managed: true,
    },
    {
      name: 'mistral:7b',
      model_id: null,
      display_name: 'mistral:7b',
      size_bytes: 4 * GiB,
      vram_bytes: 0,
      expires_at: null,
      keep_loaded: true,
      managed: false,
    },
  ],
  ...over,
});

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.post.mockReset();
});

describe('Loaded now', () => {
  it('lists each model with its memory and when it unloads; others are shown without buttons', async () => {
    mocked.get.mockResolvedValue(view());
    wrap(<LoadedNow />);
    expect(await screen.findByRole('heading', { name: 'Loaded now' })).toBeInTheDocument();
    expect(screen.getByText('Qwen3 8B')).toBeInTheDocument();
    expect(screen.getByText(/5\.2 GB on the graphics card/)).toBeInTheDocument();
    expect(screen.getByText(/Unloads at/)).toBeInTheDocument();
    expect(screen.getByText(/9\.2 GB in memory of 16 GB/)).toBeInTheDocument();
    expect(screen.getByText('Loaded by something else')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Unload/ })).toHaveLength(1);
  });

  it('Unload posts the name and shows the list Core answers with', async () => {
    mocked.get.mockResolvedValue(view());
    mocked.post.mockResolvedValue(view({ items: [] }));
    wrap(<LoadedNow />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unload Qwen3 8B' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/local-models/loaded/unload', { name: 'qwen3:8b' }),
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Loaded now' })).toBeNull());
  });

  it('Keep loaded posts keep: true, and a kept model offers to let it unload', async () => {
    mocked.get.mockResolvedValue(view());
    const kept = view();
    kept.items[0] = { ...kept.items[0], keep_loaded: true, expires_at: null } as never;
    mocked.post.mockResolvedValue(kept);
    wrap(<LoadedNow />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep loaded' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/local-models/loaded/keep', { name: 'qwen3:8b', keep: true }),
    );
    expect(await screen.findByRole('button', { name: 'Let it unload' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('warns when the loaded models leave no room, says nothing when Ollama is silent or empty', async () => {
    mocked.get.mockResolvedValue(view({ crowded: true }));
    const a = wrap(<LoadedNow />);
    expect(await screen.findByRole('status')).toHaveTextContent(/use most of the memory/);
    a.unmount();
    queryClient.clear();
    mocked.get.mockResolvedValue(view({ state: 'unreachable', items: [] }));
    const b = wrap(<LoadedNow />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalled());
    expect(b.container).toBeEmptyDOMElement();
  });

  it('an Ollama too old to say gets one plain line', async () => {
    mocked.get.mockResolvedValue(view({ state: 'too_old', items: [] }));
    wrap(<LoadedNow />);
    expect(await screen.findByText(/Update Ollama to see them here/)).toBeInTheDocument();
  });

  it('words for sizes and times', () => {
    expect(sizeWords(Math.round(5.24 * GiB))).toBe('5.2 GB');
    expect(sizeWords(820 * 1024 ** 2)).toBe('820 MB');
    expect(unloadWords({ expires_at: null, keep_loaded: true })).toMatch(/Stays loaded/);
    expect(unloadWords({ expires_at: new Date(Date.now() + 20_000).toISOString(), keep_loaded: false })).toBe(
      'Unloads in under a minute',
    );
  });
});

describe('warm on pick', () => {
  const ollama = { id: 'ollama/qwen3-8b', via: 'direct', offline: false } as const;
  beforeEach(() => {
    vi.useFakeTimers();
    useWarming.setState({ loading: {} });
    (navigator as unknown as { getBattery?: unknown }).getBattery = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('only Ollama models on this setup are warmed', () => {
    expect(warmable(ollama)).toBe(true);
    expect(warmable({ id: 'anthropic/c', via: 'direct', offline: false })).toBe(false);
    expect(warmable({ id: 'ollama/x', via: 'controller', offline: false })).toBe(false);
    expect(warmable({ id: 'ollama/x', via: 'direct', offline: true })).toBe(false);
  });

  it('asks Core once for the last of several quick picks, then shows the dot until it is loaded', async () => {
    mocked.post.mockResolvedValue({ state: 'loading', note: null });
    mocked.get.mockResolvedValueOnce(view({ items: [] })).mockResolvedValue(view());
    wrap(<WarmingDot modelId="ollama/qwen3-8b" />);
    warmOnPick({ id: 'ollama/llama3.2', via: 'direct', offline: false });
    warmOnPick(ollama);
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10));
    expect(mocked.post).toHaveBeenCalledTimes(1);
    expect(mocked.post).toHaveBeenCalledWith('/local-models/warm', { model: 'ollama/qwen3-8b' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading into memory');
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not warm a cloud model, and does not warm on battery', async () => {
    warmOnPick({ id: 'anthropic/c', via: 'direct', offline: false });
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10));
    expect(mocked.post).not.toHaveBeenCalled();

    (navigator as unknown as { getBattery: () => Promise<{ charging: boolean }> }).getBattery = () =>
      Promise.resolve({ charging: false });
    expect(await onBattery()).toBe(true);
    warmOnPick(ollama);
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10));
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('a failed warm leaves no dot and no error', async () => {
    mocked.post.mockRejectedValue(new Error('down'));
    warmOnPick(ollama);
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10));
    expect(useWarming.getState().loading).toEqual({});
  });
});
