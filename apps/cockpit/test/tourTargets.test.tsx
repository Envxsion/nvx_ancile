/**
 * The 0.1.1 tours light real elements. tours.test.ts checks, from the source, that each
 * target is drawn by its screen; this renders the pieces and checks the attribute is on
 * the page, and that the "What is new" offer follows its rules.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...real, Link: ({ children }: { children?: React.ReactNode }) => <a href="/x">{children}</a> };
});

import { onPlace } from '../src/help/tourPlace';
import { TOURS } from '../src/help/tours';
import { NEWS_OFFER_ID, NEWS_TOUR, shouldOffer } from '../src/help/WhatsNewOffer';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { FitNotice } from '../src/models/FitNotice';
import { useFitAsk } from '../src/models/fit';
import { PrivateNotebooksGroup } from '../src/privacy/PrivateNotebooksGroup';
import { MemoryUsed } from '../src/receipt/Sections';
import { Block } from '../src/routes/settings/rows';

const mocked = api as unknown as Record<'get', ReturnType<typeof vi.fn>>;

beforeEach(() => {
  mocked.get.mockReset();
});
afterEach(() => {
  cleanup();
  useFitAsk.setState({ ask: null });
});

const lit = (name: string) => document.querySelector(`[data-tour="${name}"]`);

describe('the 0.1.1 tours light real elements', () => {
  it('a settings block carries the tour name it is given', () => {
    render(
      <Block title="Routes" tour="decisions-routes">
        <p>row</p>
      </Block>,
    );
    expect(lit('decisions-routes')).not.toBeNull();
  });

  it('Settings → Private notebooks lights its switches and its fixed rows', async () => {
    mocked.get.mockResolvedValue({
      rows: [
        {
          id: 'passive_memory',
          label: 'Learn from things said in passing',
          description: 'Off.',
          detail: 'Detail.',
          locked: false,
          allowed_in_private: false,
          local_available: false,
        },
        { id: 'cloud_models', label: 'Cloud models', description: '', detail: 'Fixed.', locked: true },
      ],
    });
    const { findByText } = render(
      <QueryClientProvider client={queryClient}>
        <PrivateNotebooksGroup />
      </QueryClientProvider>,
    );
    await findByText('Always off');
    expect(lit('private-switches')).not.toBeNull();
    expect(lit('private-fixed')).not.toBeNull();
  });

  it('the fit line lights itself when it shows', () => {
    useFitAsk.setState({
      ask: {
        threadId: 't1',
        model: { id: 'm', name: 'Small 128k' } as never,
        before: 340_000,
        after: 120_000,
        ready: false,
      },
    });
    render(<FitNotice threadId="t1" />);
    expect(lit('fit-line')).not.toBeNull();
  });

  it('the Used: line lights itself', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryUsed
          used={[{ path: 'USER.md', key: 'k1', text: 'Prefers metric units', commit: 'abcdef1234' } as never]}
        />
      </QueryClientProvider>,
    );
    expect(lit('memory-used')).not.toBeNull();
  });
});

describe('the place a tour step happens', () => {
  it('knows a settings group by its exact address', () => {
    const place = { route: '/settings/$group', exact: '/settings/decisions' };
    expect(onPlace(place, '/settings/decisions')).toBe(true);
    expect(onPlace(place, '/settings/decisions/')).toBe(true);
    expect(onPlace(place, '/settings/usage')).toBe(false);
    expect(onPlace({ route: '/flows' }, '/flows')).toBe(true);
  });

  it('every exact address is a real settings group or admin section', () => {
    const groups = ['decisions', 'private-notebooks', 'usage'];
    const sections = ['memory'];
    for (const t of Object.values(TOURS)) {
      const places = [t.start, ...t.steps.map((s) => s.at)];
      for (const p of places) {
        if (!p?.exact) continue;
        const [, area, name] = p.exact.split('/');
        expect(area === 'settings' ? groups : sections, `${t.id}: ${p.exact}`).toContain(name);
      }
    }
  });
});

describe('the What is new offer', () => {
  const base = { threads: 3, tours: {}, hintsSeen: [] as string[], touring: false, automated: false };

  it('is made once to a workspace that has threads', () => {
    expect(shouldOffer(base)).toBe(true);
    expect(shouldOffer({ ...base, hintsSeen: [NEWS_OFFER_ID] })).toBe(false);
  });

  it('is not made to a new install, while loading, during a tour or under automation', () => {
    expect(shouldOffer({ ...base, threads: 0 })).toBe(false);
    expect(shouldOffer({ ...base, threads: undefined })).toBe(false);
    expect(shouldOffer({ ...base, touring: true })).toBe(false);
    expect(shouldOffer({ ...base, automated: true })).toBe(false);
  });

  it('is not made once the tour was taken or skipped', () => {
    expect(shouldOffer({ ...base, tours: { [NEWS_TOUR]: 'done' } })).toBe(false);
    expect(shouldOffer({ ...base, tours: { [NEWS_TOUR]: 'skipped' } })).toBe(false);
    expect(TOURS[NEWS_TOUR]?.steps.length).toBeGreaterThanOrEqual(8);
  });
});
