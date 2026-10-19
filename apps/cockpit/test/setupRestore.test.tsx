/**
 * SU1: restoring from the setup step without leaving it. Choosing only stages a
 * restore; the restart applies it; a failed one says why and can be tried again;
 * progress shows on the start-up screen; the Pro joins are gilt cards when locked.
 */
import type { system } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/state/notify', () => ({ notify: vi.fn() }));

import { StartupGate } from '../src/app/StartupScreen';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { MoveComputer } from '../src/setup/MoveComputer';
import { stepWords } from '../src/setup/restore';

const mocked = api as unknown as Record<'get' | 'post' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const backup = {
  name: 'ancile-20261012-manual.dump',
  created_at: '2026-10-12T09:30:00Z',
  reason: 'manual',
  bytes: 48 * 1024 * 1024,
  app_version: '0.1.1',
  core_schema: null,
  knowledge_revision: null,
};
const marker = (over: Partial<system.StagedRestore> = {}): system.StagedRestore => ({
  backup: backup.name,
  bytes: backup.bytes,
  staged_at: '2026-10-19T00:00:00Z',
  state: 'staged',
  step: 'waiting',
  attempts: 0,
  safety: null,
  error: null,
  ...over,
});

/** What Core says, by path; `restore` is the staged marker. */
function core(restore: system.StagedRestore | null) {
  mocked.get.mockImplementation(async (path: string) => {
    if (path === '/system/backups') return { items: [backup], folder: 'C:/data/backups' };
    if (path === '/system/restore') return { restore, managed: false };
    if (path === '/license/details') return { build: 'free', features: [] };
    return {};
  });
}

beforeEach(() => {
  queryClient.clear();
  for (const m of Object.values(mocked)) m.mockReset();
  mocked.post.mockResolvedValue({});
  mocked.del.mockResolvedValue({ ok: true });
});

describe('restoring from the setup step', () => {
  it('choosing a backup only stages it, and nothing is replaced until the restart is asked for', async () => {
    core(null);
    wrap(<MoveComputer />);
    fireEvent.click(await screen.findByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: 'Choose this backup' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/system/restore/stage', { backup: backup.name }),
    );
    expect(mocked.post).not.toHaveBeenCalledWith('/system/restore/apply', expect.anything());
    expect(screen.getByText(/Nothing changes until you restart/)).toBeInTheDocument();
  });

  it('a staged restore says what will happen, then asks for the restart; Choose another drops it', async () => {
    core(marker());
    mocked.post.mockResolvedValue({ restarting: false });
    wrap(<MoveComputer />);
    expect(await screen.findByText(/Ready to restore/)).toBeInTheDocument();
    expect(screen.getByText(/kept as a backup first/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart and restore' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/system/restore/apply', {}));
    expect(await screen.findByText(/Restart NVX Ancile now/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose another' }));
    await waitFor(() => expect(mocked.del).toHaveBeenCalledWith('/system/restore'));
  });

  it('a backup that could not be restored says why, names the safety copy and can be tried again', async () => {
    core(
      marker({
        state: 'failed',
        safety: 'ancile-20261019-before-restore.dump',
        error: {
          title: 'The backup could not be restored',
          hint: 'Choose another backup, or skip this step.',
        },
      }),
    );
    wrap(<MoveComputer />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The backup could not be restored.');
    expect(screen.getByText(/ancile-20261019-before-restore\.dump/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a finished restore says so, and one that carried on after a restart says that too', async () => {
    core(marker({ state: 'done', step: 'done', attempts: 2 }));
    wrap(<MoveComputer />);
    expect(await screen.findByText(/Restored from/)).toBeInTheDocument();
    expect(screen.getByText(/carried on after a restart/)).toBeInTheDocument();
  });

  it('the Pro joins are gilt cards when locked, never broken controls', async () => {
    core(null);
    wrap(<MoveComputer />);
    expect(await screen.findByText('Join my synced computers')).toBeInTheDocument();
    expect(await screen.findByText('Join my team')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pairing code')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/invite code/i)).not.toBeInTheDocument();
  });
});

describe('the start-up screen while a restore is applied', () => {
  const restoring = (m: system.StagedRestore): system.StartupStatus => ({
    state: 'stopped',
    version: '0.1.1',
    schema: { expected: '0020_x.sql', current: null },
    error: {
      code: 'system.restoring',
      title: 'Restoring your backup',
      hint: 'This can take a while for a large backup.',
      retryable: true,
      trace_id: '0'.repeat(32),
      attempts: [],
      context: {},
    },
    actions: m.state === 'failed' ? ['retry'] : [],
    backups: [],
    suggested: null,
    folder: 'C:/data/backups',
    restore: m,
  });

  it('shows the step, a progress bar and that it carries on if closed', async () => {
    mocked.get.mockResolvedValue(restoring(marker({ state: 'running', step: 'restoring', attempts: 2 })));
    wrap(
      <StartupGate>
        <p>the app</p>
      </StartupGate>,
    );
    expect(await screen.findByRole('heading', { name: 'Restoring your backup' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByText(/carries on the next time it starts/)).toBeInTheDocument();
    expect(screen.getByText(/carried on after a restart/)).toBeInTheDocument();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
  });

  it('a failed one keeps its reason and offers to start again', async () => {
    mocked.get.mockResolvedValue(
      restoring(
        marker({
          state: 'failed',
          error: { title: 'The backup could not be restored', hint: 'See the runbook.' },
        }),
      ),
    );
    wrap(<StartupGate>{null}</StartupGate>);
    expect(await screen.findByText(/The backup could not be restored\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start NVX Ancile again/ })).toBeInTheDocument();
  });

  it('words each step', () => {
    expect(stepWords(marker({ step: 'safety' })).words).toBe('Keeping a copy of what is here first');
    expect(stepWords(marker({ step: 'done' })).at).toBe(4);
  });
});
