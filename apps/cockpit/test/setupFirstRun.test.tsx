/**
 * SU1: first run asks how you are starting (new, from another computer, or
 * bringing chats), lets you make it yours with a live preview, offers a first
 * notebook, keeps every step skippable, and leaves the statistics choice for
 * the last step.
 */
import type { ChatImport } from '@nvx/contracts';
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
vi.mock('../src/telemetry/ShareStats', () => ({
  ShareStatsCard: () => <p data-testid="stats-choice">Share anonymous statistics?</p>,
}));

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { SetupScreen } from '../src/routes/Setup';
import { progressWords } from '../src/setup/ChatImport';
import { usePrefs } from '../src/state/prefs';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;

const job = (over: Partial<ChatImport> = {}): ChatImport => ({
  id: 'cim_1',
  origin: 'chatgpt',
  file_name: 'export.zip',
  status: 'running',
  total: 480,
  done: 120,
  imported: 110,
  duplicates: 4,
  empty: 6,
  messages: 900,
  notebook_id: null,
  error: null,
  started_at: '2026-10-19T00:00:00Z',
  finished_at: null,
  ...over,
});

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.post.mockReset();
  mocked.get.mockImplementation(async (path: string) => {
    if (path === '/providers') return { items: [] };
    if (path === '/imports/chats') return { items: [] };
    if (path === '/system/backups') return { items: [], folder: 'C:/data/backups' };
    return { complete: false, preset: null, providers: [], offline_model: true };
  });
  mocked.post.mockResolvedValue({});
});

describe('the first step', () => {
  it('asks how you are starting, with New here chosen so one click goes on', async () => {
    wrap(<SetupScreen />);
    const group = await screen.findByRole('radiogroup', { name: 'How are you starting?' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'New here' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Moving from another computer' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Bring my chats' })).toBeInTheDocument();
    expect(screen.queryByText(/Choose the export/)).toBeNull();
  });

  it('Bring my chats shows where each export is found, and the picker', async () => {
    wrap(<SetupScreen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Bring my chats' }));
    expect(await screen.findByText(/Settings, Data controls, Export data/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose the export/ })).toBeInTheDocument();
  });

  it('shows a running import with its progress, found again after a reload', async () => {
    mocked.get.mockImplementation(async (path: string) =>
      path === '/imports/chats'
        ? { items: [job()] }
        : { complete: false, providers: [], offline_model: true },
    );
    wrap(<SetupScreen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Bring my chats' }));
    const bar = await screen.findByRole('progressbar', { name: /Bringing in ChatGPT chats/ });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(
      screen.getByText(/120 of 480 looked at, 110 brought in, 4 already here, 6 empty/),
    ).toBeInTheDocument();
    expect(screen.getByText(/runs in the background/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('says what went wrong with a bad file, in words, and what to do', async () => {
    const real = XMLHttpRequest;
    class Fake {
      upload: { onprogress: null | (() => void) } = { onprogress: null };
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      status = 422;
      responseText = JSON.stringify({
        error: { title: 'That file is not a chat export', hint: 'Pick conversations.json from your export.' },
      });
      open() {}
      setRequestHeader() {}
      send() {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', Fake as never);
    try {
      wrap(<SetupScreen />);
      fireEvent.click(await screen.findByRole('radio', { name: 'Bring my chats' }));
      const input = document.querySelector('input[type=file]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt')] } });
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'That file is not a chat export. Pick conversations.json from your export.',
      );
    } finally {
      vi.stubGlobal('XMLHttpRequest', real);
    }
  });

  it('Moving from another computer says how, and lists backups already in the folder', async () => {
    mocked.get.mockImplementation(async (path: string) =>
      path === '/system/backups'
        ? {
            items: [{ name: 'ancile-20261012-before-migration.dump', created_at: '2026-10-12T09:30:00Z' }],
            folder: 'C:/data/backups',
          }
        : { complete: false, providers: [], offline_model: true },
    );
    wrap(<SetupScreen />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Moving from another computer' }));
    expect(await screen.findByText(/ancile-20261012-before-migration\.dump/)).toBeInTheDocument();
    expect(screen.getByText('C:/data/backups')).toBeInTheDocument();
    expect(screen.getByText(/pnpm db:restore/)).toBeInTheDocument();
  });

  it('words the import counts plainly', () => {
    expect(progressWords(job())).toBe('120 of 480 looked at, 110 brought in, 4 already here, 6 empty');
    expect(progressWords(job({ duplicates: 0, empty: 0, imported: 0, done: 0 }))).toBe('0 of 480 looked at');
  });
});

describe('the steps after it', () => {
  const go = async (to: string) => {
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    await screen.findByRole('heading', { name: 'Connect your models' });
    // The test model stands in for a key, so Continue is open.
    for (const next of [
      'Make it yours',
      'What may the AI do without asking?',
      'Your first notebook',
      'Five keys worth knowing',
    ]) {
      if (to === 'Connect your models') return;
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await screen.findByRole('heading', { name: next });
      if (next === to) return;
    }
  };

  it('Make it yours changes the real preferences, which is the live preview', async () => {
    usePrefs.setState((s) => ({
      prefs: { ...s.prefs, appearance: { ...s.prefs.appearance, theme: 'system', accent: 'ultraviolet' } },
    }));
    wrap(<SetupScreen />);
    await go('Make it yours');
    fireEvent.click(screen.getByRole('radio', { name: 'Jade' }));
    expect(usePrefs.getState().prefs.appearance.accent).toBe('jade');
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(usePrefs.getState().prefs.appearance.theme).toBe('dark');
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(usePrefs.getState().prefs.layout.density).toBe('compact');
  });

  it('safety holds permissions and memory together, so first run stays short', async () => {
    wrap(<SetupScreen />);
    await go('What may the AI do without asking?');
    expect(screen.getByRole('radiogroup', { name: 'Permission preset' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Memory capture' })).toBeInTheDocument();
  });

  it('the first notebook is made only when asked, with its files handed to the upload queue', async () => {
    mocked.post.mockImplementation(async (path: string) =>
      path === '/notebooks' ? { id: 'nb_1', title: 'Thesis' } : {},
    );
    wrap(<SetupScreen />);
    await go('Your first notebook');
    expect(mocked.post).not.toHaveBeenCalledWith('/notebooks', expect.anything());
    fireEvent.change(screen.getByLabelText('What is it about?'), { target: { value: 'Thesis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the notebook' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/notebooks', { title: 'Thesis' }));
    expect(await screen.findByText(/Your notebook is made/)).toBeInTheDocument();
  });

  it('every step after the first can be skipped, and the statistics choice comes last', async () => {
    wrap(<SetupScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    await screen.findByRole('heading', { name: 'Connect your models' });
    const steps = [] as string[];
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Skip this step' }));
      await screen.findAllByRole('heading');
      steps.push(screen.getAllByRole('heading')[0]?.textContent ?? '');
      if (i < 3) expect(screen.queryByTestId('stats-choice')).toBeNull();
    }
    expect(steps).toEqual([
      'Make it yours',
      'What may the AI do without asking?',
      'Your first notebook',
      'Five keys worth knowing',
    ]);
    // On the last step: the statistics choice, and no Skip.
    expect(screen.getByTestId('stats-choice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip this step' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open NVX Ancile' })).toBeInTheDocument();
  });

  it('Skip setup finishes with the defaults', async () => {
    mocked.post.mockResolvedValue({});
    wrap(<SetupScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip setup and use the defaults' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/setup/complete', {
        preset: 'balanced',
        memory_capture: 'auto_confident',
      }),
    );
  });
});
