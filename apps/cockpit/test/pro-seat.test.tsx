/**
 * A Pro seat per person (src/pro/slot.tsx, src/pro/edition.tsx): in a team,
 * someone without a Pro seat sees the card that says how to get one, not
 * Pro's screen and not "turn on Pro"; they see the free edition; and Teams
 * itself stays theirs (the licence's details say what this person may use).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, params }: { children: ReactNode; params?: { section?: string } }) => (
    <a href={`#${params?.section ?? ''}`}>{children}</a>
  ),
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { ...real.api, get: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { LicenceScreen } from '../src/ops/LicenceScreen';
import { editionOf } from '../src/pro/edition';
import { ProSurfaceView, ProUpsell, seatMissing } from '../src/pro/slot';

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

/** Pro on here, with Beam and Teams; `seat` is this person's. */
const details = (seat: boolean | undefined) => ({
  build: 'pro' as const,
  status: { tier: 'pro' as const, features: ['beam', 'team'] },
  ...(seat !== undefined && { seat }),
  features: [
    { id: 'beam', unlocked: seat !== false },
    { id: 'team', unlocked: true },
    { id: 'fleet', unlocked: false },
  ],
});

afterEach(() => {
  queryClient.clear();
  vi.mocked(api.get).mockReset();
});

describe('a Pro seat per person', () => {
  it('is missing only when Pro is on here, includes the feature, and this person has no seat', () => {
    expect(seatMissing(details(false) as never, 'beam')).toBe(true);
    expect(seatMissing(details(true) as never, 'beam')).toBe(false);
    // An older Core says nothing about seats: everyone has one.
    expect(seatMissing(details(undefined) as never, 'beam')).toBe(false);
    // Not in the licence at all: that is "part of Pro", not a missing seat.
    expect(seatMissing(details(false) as never, 'fleet')).toBe(false);
    expect(seatMissing(undefined, 'beam')).toBe(false);
  });

  it('shows the free edition to someone without a seat', () => {
    expect(editionOf(details(true))).toBe('pro');
    expect(editionOf(details(undefined))).toBe('pro');
    expect(editionOf(details(false))).toBe('free');
  });

  it('asks for a seat on the card, instead of offering to turn Pro on', async () => {
    vi.mocked(api.get).mockResolvedValue(details(false));
    wrap(<ProUpsell feature="beam" build="pro" />);
    expect(await screen.findByText(/your account has no Pro seat/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See who has a seat' }).getAttribute('href')).toBe('#team');
    expect(screen.queryByText('Turn on Pro')).toBeNull();
  });

  it('still offers to turn Pro on when the licence lacks the feature', async () => {
    vi.mocked(api.get).mockResolvedValue(details(false));
    wrap(<ProUpsell feature="fleet" build="pro" />);
    expect(await screen.findByRole('link', { name: 'Turn on Pro' })).toBeTruthy();
    expect(screen.queryByText(/no Pro seat/)).toBeNull();
  });

  it('shows the card for a surface someone without a seat cannot use, its own locked preview aside', async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...details(false),
      status: { tier: 'pro', features: ['beam', 'team', 'context_packs'] },
      features: [{ id: 'context_packs', unlocked: false }],
    });
    wrap(<ProSurfaceView id="context-packs" />);
    expect(await screen.findByText(/your account has no Pro seat/)).toBeTruthy();
  });

  it('says on Admin → Licence that Pro is on here but this person has no seat', async () => {
    const full = (seat: boolean) => ({
      ...details(seat),
      status: {
        tier: 'pro',
        features: ['beam', 'team'],
        verified: true,
        offline_grace: false,
        expires_at: null,
        lapse: null,
      },
      device_id: 'dev-1',
      key_held: true,
      checked_at: null,
      problem: null,
      features: [{ id: 'beam', title: 'Beam', body: 'b', unlocked: seat }],
    });
    const serve = (seat: boolean) =>
      vi.mocked(api.get).mockImplementation(async (path: string) => {
        if (path === '/license/details') return full(seat);
        if (path === '/system/update-offer') return { offer: null };
        return { tables: [], total_rows: 0 };
      });
    serve(false);
    const { unmount } = wrap(<LicenceScreen />);
    expect(
      await screen.findByText(/your account has no Pro seat, so its features stay locked for you/),
    ).toBeTruthy();
    unmount();
    queryClient.clear();
    serve(true);
    wrap(<LicenceScreen />);
    await screen.findByText('NVX Ancile Pro');
    expect(screen.queryByText(/no Pro seat/)).toBeNull();
  });
});
