/**
 * A1 and A2 in Admin → Automations: event-driven built-ins have a switch
 * and a settings form (no schedule), each setting a field of its type;
 * Back up memory says Set up until it has a remote, takes one with Test
 * push, and turns on when it is saved; Save drafts is read by the composer.
 */
import type { AutomationView } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { AutomationDialog, optionBlocker } from '../src/ops/AutomationDialog';
import { AutomationsScreen, settingsLine } from '../src/ops/AutomationsScreen';
import { draftAutosave } from '../src/ops/builtins';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

const view = (p: Partial<AutomationView> & Pick<AutomationView, 'id'>): AutomationView => ({
  title: p.id,
  description: '',
  origin: 'builtin',
  kind: p.id,
  trigger: 'event',
  cron: null,
  schedule_words: null,
  default_cron: null,
  customised: false,
  config: {},
  options: [],
  setup: null,
  enabled: true,
  last_run_at: null,
  last_status: null,
  last_error: null,
  last_detail: null,
  last_href: null,
  last_duration_ms: null,
  next_run_at: null,
  runs: 0,
  ...p,
});

const tags = view({
  id: 'auto_tag_sources',
  title: 'Tag sources',
  config: { max_tags: 5 },
  options: [
    { key: 'max_tags', label: 'Tags per source, at most', hint: null, type: 'integer', min: 1, max: 20, unit: null, default: 5 },
  ],
});
const capture = view({
  id: 'memory_capture',
  title: 'Learn from corrections',
  config: { mode: 'auto_confident' },
  options: [
    {
      key: 'mode',
      label: 'What it keeps',
      hint: null,
      type: 'choice',
      min: null,
      max: null,
      unit: null,
      default: 'auto_confident',
      choices: [
        { value: 'auto_confident', label: 'What it is sure of, asking about the rest' },
        { value: 'propose_all', label: 'Nothing until you say yes' },
      ],
    },
  ],
});
const backup = view({
  id: 'memory_backup',
  title: 'Back up memory',
  trigger: 'schedule',
  cron: '0 * * * *',
  schedule_words: 'Every hour',
  default_cron: '0 * * * *',
  enabled: false,
  setup: { title: 'Not set up', hint: 'Set its git remote in Edit.' },
});

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
});

describe('event-driven built-ins', () => {
  it('each has a switch, its settings in a line, and Edit', async () => {
    mocked.get.mockResolvedValue({ items: [tags, view({ id: 'auto_title', title: 'Name new threads' })] });
    mocked.patch.mockResolvedValue({ ...tags, enabled: false });
    wrap(<AutomationsScreen />);
    const row = (await screen.findByText('Tag sources')).closest('li') as HTMLElement;
    expect(within(row).getByText('Tags per source, at most 5')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('switch', { name: 'Tag sources on' }));
    await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith('/automations/auto_tag_sources', { enabled: false }));
    // A job with nothing to set has a switch and no Edit.
    const title = (await screen.findByText('Name new threads')).closest('li') as HTMLElement;
    expect(within(title).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(title).getByRole('switch')).toBeInTheDocument();
  });

  it('the settings form has no schedule, and sends only what changed', async () => {
    mocked.patch.mockResolvedValue(tags);
    wrap(<AutomationDialog open automation={tags} onOpenChange={() => {}} />);
    expect(screen.queryByText('How often')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: /schedule/i })).toBeNull();
    const field = screen.getByLabelText('Tags per source, at most');
    fireEvent.change(field, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/automations/auto_tag_sources', { config: { max_tags: 3 } }),
    );
  });

  it('a whole number out of range is caught before it is sent', () => {
    wrap(<AutomationDialog open automation={tags} onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tags per source, at most'), { target: { value: '40' } });
    expect(screen.getByText('Tags per source, at most: 1 to 20.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('a choice is a list of its words', async () => {
    mocked.patch.mockResolvedValue(capture);
    wrap(<AutomationDialog open automation={capture} onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText('What it keeps'), { target: { value: 'propose_all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/automations/memory_capture', { config: { mode: 'propose_all' } }),
    );
    expect(settingsLine(capture)).toBe('What it is sure of, asking about the rest');
  });

  it('the warning has to come before compacting', () => {
    const opts = [
      { key: 'warn_at_percent', label: 'Warn', hint: null, type: 'integer' as const, min: 50, max: 98, unit: '%', default: 80 },
      { key: 'compact_at_percent', label: 'Compact', hint: null, type: 'integer' as const, min: 60, max: 99, unit: '%', default: 95 },
    ];
    expect(optionBlocker(opts, { warn_at_percent: 80, compact_at_percent: 95 })).toBeNull();
    expect(optionBlocker(opts, { warn_at_percent: 95, compact_at_percent: 90 })).toMatch(/before compacting/);
    expect(optionBlocker(opts, { warn_at_percent: 70.5, compact_at_percent: 90 })).toMatch(/whole number/);
  });
});

describe('Back up memory', () => {
  it('says Set up, not a switch, until it has a remote', async () => {
    mocked.get.mockResolvedValue({ items: [backup] });
    wrap(<AutomationsScreen />);
    const card = (await screen.findByText('Back up memory')).closest('li') as HTMLElement;
    expect(within(card).queryByRole('switch')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Set up' }));
    expect(await screen.findByLabelText('Git remote')).toBeInTheDocument();
  });

  it('Test push tries the typed remote and says what happened', async () => {
    mocked.post.mockResolvedValue({ ok: false, detail: 'fatal: Repository not found.' });
    wrap(<AutomationDialog open automation={backup} onOpenChange={() => {}} />);
    const test = screen.getByRole('button', { name: 'Test push' });
    expect(test).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Git remote'), { target: { value: ' git@github.com:me/memory.git ' } });
    fireEvent.click(test);
    expect(await screen.findByText('fatal: Repository not found.')).toBeInTheDocument();
    expect(mocked.post).toHaveBeenCalledWith('/automations/memory_backup/test', { remote: 'git@github.com:me/memory.git' });
  });

  it('saving a remote keeps it with the keys, then turns the backup on', async () => {
    mocked.put.mockResolvedValue({});
    mocked.patch.mockResolvedValue({ ...backup, enabled: true, setup: null });
    const done = vi.fn();
    wrap(<AutomationDialog open automation={backup} onOpenChange={done} />);
    const save = screen.getByRole('button', { name: 'Save and turn on' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Git remote'), { target: { value: 'git@github.com:me/memory.git' } });
    fireEvent.click(save);
    await waitFor(() => expect(done).toHaveBeenCalledWith(false));
    expect(mocked.put).toHaveBeenCalledWith('/credentials/memory_remote', { value: 'git@github.com:me/memory.git' });
    expect(mocked.patch).toHaveBeenCalledWith('/automations/memory_backup', { enabled: true });
    // The key first, so Core has a remote by the time it is switched on.
    expect(mocked.put.mock.invocationCallOrder[0]).toBeLessThan(mocked.patch.mock.invocationCallOrder[0] ?? 0);
  });

  it('once set up, Test push tries the remote in use', async () => {
    mocked.post.mockResolvedValue({ ok: true, detail: 'The remote took a test push. Nothing was changed there.' });
    wrap(<AutomationDialog open automation={{ ...backup, setup: null, enabled: true }} onOpenChange={() => {}} />);
    expect(screen.queryByLabelText('Git remote')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Test push' }));
    expect(await screen.findByText(/took a test push/)).toBeInTheDocument();
    expect(mocked.post).toHaveBeenCalledWith('/automations/memory_backup/test', {});
  });
});

describe('Save drafts, in the composer', () => {
  it('keeps a copy in Core after the pause it is set to, or not at all', () => {
    expect(draftAutosave(undefined)).toEqual({ on: true, afterMs: 3_000 });
    const d = view({ id: 'draft_autosave', config: { server_every_s: 10 } });
    expect(draftAutosave([d])).toEqual({ on: true, afterMs: 10_000 });
    expect(draftAutosave([{ ...d, enabled: false }]).on).toBe(false);
    expect(draftAutosave([{ ...d, config: { server_every_s: 0 } }]).afterMs).toBe(3_000);
  });
});
