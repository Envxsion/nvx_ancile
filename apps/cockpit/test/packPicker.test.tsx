/**
 * CP1: context packs are reached from a thread's or notebook's own menu, not
 * only from Admin. In a free build the dialog says what packs are and that
 * links and merge are free; the real picker is Pro's (ProUi.parts.PackMenu).
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
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

import { EditorsHost } from '../src/editors/EditorsHost';
import { closeEditor, openEditor } from '../src/editors/store';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { PackPicker } from '../src/pro/PackPicker';

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
const free = { build: 'free', features: [{ id: 'context_packs', unlocked: false }] };

afterEach(() => {
  cleanup();
  closeEditor();
  queryClient.clear();
  vi.mocked(api.get).mockReset();
});

describe('the context pack picker', () => {
  it('explains packs in a free build, names the place, and points to what packs do', async () => {
    vi.mocked(api.get).mockResolvedValue(free);
    wrap(
      <PackPicker
        target={{ kind: 'thread', id: 't1', title: 'Pump trial' }}
        onOpenChange={() => undefined}
      />,
    );
    expect(await screen.findByText(/Context packs for Pump trial/)).toBeTruthy();
    expect(await screen.findByText(/part of NVX Ancile Pro, which this build does not include/)).toBeTruthy();
    expect(screen.getByText(/Context links and notebook merge are free/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See what packs do' }).getAttribute('href')).toBe(
      '#context-packs',
    );
  });

  it('asks for a seat when Pro is on here but this person has none', async () => {
    vi.mocked(api.get).mockResolvedValue({
      build: 'pro',
      seat: false,
      status: { features: ['context_packs'] },
      features: [{ id: 'context_packs', unlocked: false }],
    });
    wrap(
      <PackPicker target={{ kind: 'notebook', id: 'n1', title: 'Pumps' }} onOpenChange={() => undefined} />,
    );
    expect(await screen.findByText(/your account has no Pro seat/)).toBeTruthy();
  });

  it('opens from the editors store, for a thread or a notebook', async () => {
    vi.mocked(api.get).mockResolvedValue(free);
    wrap(<EditorsHost />);
    expect(screen.queryByText(/Context packs for/)).toBeNull();
    openEditor({ kind: 'packs', level: 'notebook', id: 'n1', title: 'Pumps' });
    expect(await screen.findByText(/Context packs for Pumps/)).toBeTruthy();
  });
});
