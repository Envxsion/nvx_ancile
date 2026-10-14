/**
 * C1: one key screen. Admin → Compute's Connect RunPod opens Settings → API
 * keys at the RunPod row, ready to type; saving it there says RunPod is
 * connected. A key set in the environment opens read-only, not as a field.
 */
import type { CredentialStatus } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.fn();
let search: Record<string, string> = {};
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => nav,
  useSearch: () => search,
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/state/notify', () => ({ notify: vi.fn() }));

import { ComputeScreen } from '../src/compute/ComputeScreen';
import { ApiKeysGroup } from '../src/credentials/ApiKeys';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { notify } from '../src/state/notify';

const mocked = api as unknown as Record<'get' | 'put', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

const runpod = (p: Partial<CredentialStatus> = {}): CredentialStatus => ({
  id: 'runpod',
  set: false,
  last4: null,
  source: null,
  env_var: 'RUNPOD_API_KEY',
  check: 'controller',
  available: true,
  unavailable_reason: null,
  ...p,
});

beforeEach(() => {
  queryClient.clear();
  nav.mockReset();
  search = {};
  mocked.get.mockReset();
  mocked.put.mockReset();
  vi.mocked(notify).mockReset();
});

describe('Connect RunPod in Admin → Compute', () => {
  it('opens the RunPod row of Settings → API keys, the one place keys go', async () => {
    mocked.get.mockImplementation(async (path: string) => {
      if (path === '/compute/status')
        return { configured: true, reachable: true, sample: false, provider: null };
      if (path === '/compute/provider')
        return { kind: 'none', connected: false, detail: '', key_saved: false };
      if (path === '/compute/nodes') return { items: [] };
      if (path.startsWith('/compute/costs')) return null;
      return { items: [] };
    });
    wrap(<ComputeScreen />);
    const buttons = await screen.findAllByRole('button', { name: 'Connect RunPod' });
    fireEvent.click(buttons[0] as HTMLElement);
    expect(nav).toHaveBeenCalledWith({
      to: '/settings/$group',
      params: { group: 'keys' },
      search: { key: 'runpod' },
    });
    // No key field of its own any more.
    expect(screen.queryByLabelText('RunPod API key')).toBeNull();
  });
});

describe('Settings → API keys, opened for RunPod', () => {
  it('opens the row ready to type, and says RunPod is connected once saved', async () => {
    search = { key: 'runpod' };
    mocked.get.mockResolvedValue({ items: [runpod()] });
    mocked.put.mockResolvedValue(runpod({ set: true, source: 'saved', last4: 'abcd' }));
    wrap(<ApiKeysGroup />);
    const field = await screen.findByLabelText('RunPod API key');
    expect(field).toHaveFocus();
    expect(document.getElementById('credential-runpod')).toHaveAttribute('data-focused');
    fireEvent.change(field, { target: { value: 'rpa_live_key_0000abcd' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/credentials/runpod', { value: 'rpa_live_key_0000abcd' }),
    );
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'RunPod connected' })),
    );
  });

  it('a key from the environment opens read-only, not as a field', async () => {
    search = { key: 'runpod' };
    mocked.get.mockResolvedValue({ items: [runpod({ set: true, source: 'environment', last4: '9876' })] });
    wrap(<ApiKeysGroup />);
    expect(await screen.findByText(/Read-only here/)).toBeInTheDocument();
    expect(screen.queryByLabelText('RunPod API key')).toBeNull();
  });

  it('without a key to open, every row stays as it is', async () => {
    mocked.get.mockResolvedValue({ items: [runpod()] });
    wrap(<ApiKeysGroup />);
    await screen.findByText('RunPod');
    expect(screen.queryByLabelText('RunPod API key')).toBeNull();
    expect(document.querySelector('[data-focused]')).toBeNull();
  });
});
