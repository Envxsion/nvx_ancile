/**
 * The start-up screen: when Core stopped before opening the database, the
 * Cockpit says why and offers only what fits; restoring asks once more.
 */
import type { system } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { StartupGate } from '../src/app/StartupScreen';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

const backup = (
  name: string,
  at: string,
  reason: system.BackupReason = 'before-migration',
): system.Backup => ({
  name,
  created_at: at,
  reason,
  bytes: 48 * 1024 * 1024,
  app_version: '0.2.0',
  core_schema: '0020_claude_code_fork_lookup.sql',
  knowledge_revision: '0002_ingest',
});

function stopped(code: string, actions: system.StartupAction[], extra: Partial<system.StartupStatus> = {}) {
  const s: system.StartupStatus = {
    state: 'stopped',
    version: '0.2.0',
    schema: { expected: '0020_claude_code_fork_lookup.sql', current: '0022_newer.sql' },
    error: {
      code,
      title: 'Your data was updated by NVX Ancile 0.3.0, which this version cannot read',
      hint: 'Restore the backup taken before that update, or install NVX Ancile 0.3.0 again. Nothing has been changed.',
      retryable: false,
      trace_id: '0'.repeat(32),
      attempts: [],
      context: {},
    },
    actions,
    backups: [backup('b2.dump', '2026-10-12T08:00:00Z'), backup('b1.dump', '2026-10-01T08:00:00Z')],
    suggested: 'b2.dump',
    folder: 'C:\\Users\\ana\\AppData\\Roaming\\NVX Ancile\\backups',
    ...extra,
  };
  mocked.get.mockResolvedValue(s);
}

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.post.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('start-up screen', () => {
  it('lets the app through when Core started', async () => {
    mocked.get.mockResolvedValue({ state: 'running' });
    wrap(
      <StartupGate>
        <p>the app</p>
      </StartupGate>,
    );
    expect(await screen.findByText('the app')).toBeInTheDocument();
    await waitFor(() => expect(mocked.get).toHaveBeenCalledWith('/system/startup'));
  });

  it('explains a newer database and restores the backup from before the update, after asking once more', async () => {
    stopped('system.database_newer', ['restore', 'reinstall']);
    mocked.post.mockResolvedValue({ restarting: false });
    wrap(
      <StartupGate>
        <p>the app</p>
      </StartupGate>,
    );
    expect(await screen.findByText('NVX Ancile stopped before opening your data')).toBeInTheDocument();
    expect(screen.queryByText('the app')).toBeNull();
    expect(screen.getByText(/which this version cannot read/)).toBeInTheDocument();
    expect(screen.getByText('Before the update')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Get the newer NVX Ancile/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update without a backup/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Restore this backup' }));
    expect(mocked.post).not.toHaveBeenCalled();
    expect(screen.getByText(/What is there now is kept as a backup first/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace my data with this backup' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/system/startup/restore', { backup: 'b2.dump' }),
    );
    expect(await screen.findByText(/Restart NVX Ancile to carry on/)).toBeInTheDocument();
  });

  it('offers to try again or go on without a backup when the backup failed', async () => {
    stopped('system.backup_failed', ['retry', 'continue_without_backup'], { suggested: null });
    mocked.post.mockResolvedValue({ restarting: true });
    wrap(
      <StartupGate>
        <p>the app</p>
      </StartupGate>,
    );
    expect(await screen.findByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore this backup' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update without a backup' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/system/startup/continue-without-backup', {}),
    );
    expect(await screen.findByText(/Updating without a backup/)).toBeInTheDocument();
  });
});
