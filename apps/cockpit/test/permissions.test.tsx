/**
 * G1: Admin → Permissions marks a saved permission that has expired, with
 * a word and an icon, filters by All, Active and Expired, says when the
 * rest end (a future expiry used to read "just now"), and the area has one
 * name everywhere: Permissions (an old /admin/grants link still lands).
 */
import type { Grant } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  Navigate: ({ params }: { params: { section: string } }) => <p>Redirected to {params.section}</p>,
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { expiryWords, filterGrants, isExpired } from '../src/approvals/grantState';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { LiveGrants } from '../src/routes/admin/live';
import { ADMIN_SECTIONS } from '../src/routes/admin/sections';

const mocked = api as unknown as Record<'get', ReturnType<typeof vi.fn>>;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const H = 3_600_000;

const grant = (p: Partial<Grant> & Pick<Grant, 'id'>): Grant =>
  ({
    principal: 'agent',
    action_pattern: 'fs.write',
    resource_pattern: 'fs:/workspace/notes/**',
    effect: 'allow',
    scope: 'always',
    scope_ref: null,
    expires_at: null,
    uses: 3,
    last_used_at: null,
    created_at: at(-48 * H),
    revoked_at: null,
    ...p,
  }) as Grant;

const live = grant({ id: 'g1', expires_at: at(3 * H) });
const forever = grant({ id: 'g2', action_pattern: 'web.*', resource_pattern: 'web:example.com' });
const gone = grant({
  id: 'g3',
  action_pattern: 'shell.run',
  resource_pattern: 'shell:git status*',
  expires_at: at(-5 * H),
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

describe('when a saved permission ends', () => {
  it('says so in words, for the future and the past', () => {
    expect(expiryWords({ expires_at: null }, NOW)).toBe('Never');
    expect(expiryWords({ expires_at: at(40 * 60_000) }, NOW)).toBe('In 40 min');
    expect(expiryWords({ expires_at: at(3 * H) }, NOW)).toBe('In 3 h');
    expect(expiryWords({ expires_at: at(24 * H) }, NOW)).toBe('In 1 day');
    expect(expiryWords({ expires_at: at(50 * H) }, NOW)).toBe('In 2 days');
    expect(expiryWords({ expires_at: at(10_000) }, NOW)).toBe('In a moment');
    expect(expiryWords({ expires_at: at(-5 * H) }, NOW)).toBe('Expired 5 h ago');
    expect(expiryWords({ expires_at: at(-1_000) }, NOW)).toBe('Expired just now');
  });

  it('counts as expired from the moment it ends, and never without an expiry', () => {
    expect(isExpired({ expires_at: at(0) }, NOW)).toBe(true);
    expect(isExpired({ expires_at: at(1) }, NOW)).toBe(false);
    expect(isExpired({ expires_at: null }, NOW)).toBe(false);
    expect(filterGrants([live, forever, gone], 'expired', NOW).map((g) => g.id)).toEqual(['g3']);
    expect(filterGrants([live, forever, gone], 'active', NOW).map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(filterGrants([live, forever, gone], 'all', NOW)).toHaveLength(3);
  });
});

describe('Admin → Permissions', () => {
  it('marks the expired one, with a word, and filters by state with counts', async () => {
    mocked.get.mockImplementation(async (path: string) =>
      path === '/grants' ? { items: [live, forever, gone] } : { preset: 'balanced' },
    );
    wrap(<LiveGrants />);
    const row = (await screen.findByText('shell.run')).closest('tr') as HTMLElement;
    expect(row).toHaveAttribute('data-expired');
    expect(within(row).getByText('Expired')).toBeInTheDocument();
    expect(within(row).getByText('Expired 5 h ago')).toBeInTheDocument();
    const liveRow = screen.getByText('fs.write').closest('tr') as HTMLElement;
    expect(within(liveRow).getByText('In 3 h')).toBeInTheDocument();
    expect(liveRow).not.toHaveAttribute('data-expired');

    fireEvent.click(screen.getByRole('radio', { name: 'Expired 1' }));
    expect(screen.queryByText('fs.write')).toBeNull();
    expect(screen.getByText('shell.run')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Active 2' }));
    expect(screen.queryByText('shell.run')).toBeNull();
    expect(screen.getByText('web.*')).toBeInTheDocument();
  });

  it('says when a filter has nothing in it', async () => {
    mocked.get.mockImplementation(async (path: string) => (path === '/grants' ? { items: [forever] } : {}));
    wrap(<LiveGrants />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Expired 0' }));
    expect(screen.getByText('Nothing has expired.')).toBeInTheDocument();
  });

  it('is called Permissions, and an old Grants link still lands there', async () => {
    const section = ADMIN_SECTIONS.find((s) => s.id === 'permissions');
    expect(section?.label).toBe('Permissions');
    expect(ADMIN_SECTIONS.some((s) => s.id === 'grants' || /grant/i.test(s.label))).toBe(false);
    vi.resetModules();
    vi.doMock('@tanstack/react-router', () => ({
      useParams: () => ({ section: 'grants' }),
      Navigate: ({ params }: { params: { section: string } }) => <p>Redirected to {params.section}</p>,
      Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
      Outlet: () => null,
      useNavigate: () => vi.fn(),
      useSearch: () => ({}),
    }));
    const { AdminSectionScreen } = await import('../src/routes/admin/Admin');
    render(<AdminSectionScreen />);
    expect(screen.getByText('Redirected to permissions')).toBeInTheDocument();
  });
});
