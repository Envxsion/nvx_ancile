/**
 * Admin → Licence: Pro arrives and leaves only by update. The free build
 * takes a key and says Pro is on its way; the update the desktop app
 * offers says when Pro is ready, or that Pro ended; a lapsed licence is
 * offered renewal; the Pro installer link is there for a reinstall.
 */
import type { license } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { LicenceScreen } from '../src/ops/LicenceScreen';
import { useNotify } from '../src/state/notify';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

function details(
  p: Partial<license.LicenseDetails> = {},
  lapse: license.LicenseLapse | null = null,
): license.LicenseDetails {
  return {
    status: { tier: 'free', features: [], verified: false, offline_grace: false, expires_at: null, lapse },
    build: 'free',
    device_id: 'dev-1',
    key_held: false,
    checked_at: null,
    problem: null,
    features: [],
    ...p,
  };
}

function serve(d: license.LicenseDetails, offer: license.UpdateOffer['offer'] = null) {
  mocked.get.mockImplementation(async (path: string) => {
    if (path === '/license/details') return d;
    if (path === '/system/update-offer') return { offer };
    throw new Error(`unexpected ${path}`);
  });
}

const offerOf = (kind: license.UpdateOfferKind, version = '0.4.0'): license.UpdateOffer['offer'] => ({
  version,
  edition: kind === 'downgrade' ? 'free' : 'pro',
  kind,
  found_at: '2026-10-11T09:00:00Z',
});

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.post.mockReset();
  useNotify.setState({ toasts: [], history: [] });
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
});
afterEach(() => vi.restoreAllMocks());

describe('licence screen', () => {
  it('the free build takes a key, and says Pro is on its way once it is turned on', async () => {
    serve(details());
    wrap(<LicenceScreen />);
    const input = await screen.findByLabelText(/Licence key/);
    expect(screen.queryByText(/built without Pro/)).toBeNull();
    fireEvent.change(input, { target: { value: 'nvxabcdefghjk23' } });
    mocked.post.mockResolvedValue(details({ key_held: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Pro' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/license/activate', { key: 'NVX-ABCD-EFGH-JK23' }),
    );
    expect(await screen.findByText(/Pro is on its way\. It arrives as an update/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Licence key/)).toBeNull();
    expect(useNotify.getState().toasts.some((t) => t.title === 'Pro is on its way')).toBe(true);
  });

  it('says Pro is ready when the tray offers it, and toasts once', async () => {
    serve(details({ key_held: true }), offerOf('pro', '0.4.2'));
    wrap(<LicenceScreen />);
    expect(await screen.findByText(/Pro is ready\. Install it from the tray menu/)).toBeInTheDocument();
    expect(screen.queryByText(/Pro is on its way/)).toBeNull();
    await waitFor(() =>
      expect(useNotify.getState().toasts.filter((t) => t.title === 'Pro is ready')).toHaveLength(1),
    );
  });

  it('offers renewal when the Pro licence lapsed', async () => {
    serve(details({ build: 'pro', key_held: true }, 'expired'));
    wrap(<LicenceScreen />);
    expect(await screen.findByText(/Pro licence lapsed: renew to keep updates/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Renew' })).toHaveAttribute('href', 'https://ancile.nvx.sh');
  });

  it('says Pro ended and the free edition is coming, with no second choice', async () => {
    serve(details({ build: 'pro', key_held: true }, 'expired'), offerOf('downgrade', '0.5.0'));
    wrap(<LicenceScreen />);
    expect(
      await screen.findByText(/Pro ended 90 days ago; switching to the free edition\. Your data stays\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/anyway/)).toBeNull();
    expect(screen.queryByText(/renew to keep updates/)).toBeNull();
  });

  it('links to the Pro installer for a reinstall, in both builds', async () => {
    for (const build of ['free', 'pro'] as const) {
      queryClient.clear();
      serve(details({ build }));
      const { unmount } = wrap(<LicenceScreen />);
      const link = await screen.findByRole('link', {
        name: 'Reinstalling on a new computer? Get the Pro installer',
      });
      expect(link).toHaveAttribute('href', 'https://ancile.nvx.sh/pro/download');
      unmount();
    }
  });
});
