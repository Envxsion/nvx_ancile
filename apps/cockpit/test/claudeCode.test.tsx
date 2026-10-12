/**
 * Works with Claude Code, the Cockpit half: the Settings card offers the one
 * step that comes next (and never talks about subscriptions), install
 * progress arrives by event, the sessions view is quiet when sessions come
 * in by themselves and sends exactly the import body when they do not,
 * threads from Claude Code say so and sync, imported compactions read as a
 * divider, and claude_code.changed makes the right things stale.
 */
import type { ClaudeCodeSession, ClaudeCodeStatus, Message } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import {
  CC_INVALIDATE_MS,
  CC_KEYS,
  excludeFolder,
  onClaudeCodeChanged,
  readSessionsDetail,
  signedInWords,
  syncThread,
  useImportProgress,
  useInstallProgress,
} from '../src/claudecode/api';
import { ClaudeCodeGroup, NEVER_SEES, SIGN_IN_NOTE, stageOf } from '../src/claudecode/ClaudeCodeGroup';
import { excludeCopy } from '../src/claudecode/ExcludeFolder';
import { groupSessions, SessionsBrowser } from '../src/claudecode/SessionsDialog';
import { ClaudeCodeMarker, CompactionDivider, markerText } from '../src/claudecode/ThreadMarker';
import { ARTICLES, articleById, ERROR_ARTICLES } from '../src/help/articles';
import { ApiCallError, api, localError } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { subagentsOf, toMessageViews } from '../src/lib/mappers';
import { queryClient } from '../src/lib/query';
import { useNotify } from '../src/state/notify';
import { ResultText, SubagentConversation } from '../src/thread/Parts';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

function status(p: Partial<ClaudeCodeStatus> = {}): ClaudeCodeStatus {
  return {
    installed: true,
    version: '2.1.286',
    path: '/usr/local/bin/claude',
    version_ok: true,
    min_version: '2.1.0',
    signed_in: true,
    auth_method: 'claude.ai',
    plan: 'max',
    projects_dir: null,
    config_dir: null,
    install: { state: 'installed', error: null },
    sdk: { ready: true, version: '0.2.0', error: null },
    verification: { state: 'verified', error: null },
    settings: {
      auto_install: true,
      auto_import: true,
      exclude_folders: ['~/.claude-mem'],
      claude_telemetry: true,
    },
    ...p,
  };
}

function session(p: Partial<ClaudeCodeSession> = {}): ClaudeCodeSession {
  return {
    session_id: 's1',
    title: 'Fix the login page',
    cwd: '/home/me/cyberfolio',
    project: 'cyberfolio',
    cwd_missing: false,
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    created_at: null,
    git_branch: 'main',
    size_bytes: 52_000,
    thread_id: null,
    behind: false,
    active_elsewhere: false,
    ...p,
  };
}

function message(p: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return {
    thread_id: 't1',
    parent_id: null,
    model_id: null,
    requested_model_id: null,
    status: 'complete',
    edit_of_id: null,
    provenance: {},
    usage: null,
    run_id: null,
    trace_id: 'x',
    created_at: new Date().toISOString(),
    ...p,
  } as Message;
}

const allText = () => document.body.textContent ?? '';

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  useNotify.setState({ toasts: [], history: [] });
  useInstallProgress.setState({ detail: null });
  useImportProgress.setState({ line: null });
});
afterEach(() => vi.restoreAllMocks());

/* ---- Settings → Claude Code ---------------------------------------------- */

describe('the status card offers the step that comes next', () => {
  it('works out the stage from the status', () => {
    expect(
      stageOf(status({ installed: false, version: null, install: { state: 'idle', error: null } })),
    ).toBe('install');
    expect(
      stageOf(status({ installed: false, version: null, install: { state: 'installing', error: null } })),
    ).toBe('installing');
    expect(stageOf(status({ version_ok: false }))).toBe('update');
    expect(stageOf(status({ signed_in: false }))).toBe('sign-in');
    expect(stageOf(status())).toBe('signed-in');
  });

  it('not installed: Install Claude Code, and pressing it asks Core to install', async () => {
    const missing = { installed: false, version: null, path: null, signed_in: false };
    mocked.get
      .mockResolvedValueOnce(status({ ...missing, install: { state: 'idle', error: null } }))
      .mockResolvedValue(status({ ...missing, install: { state: 'installing', error: null } }));
    mocked.post.mockResolvedValue(undefined);
    wrap(<ClaudeCodeGroup />);
    expect(await screen.findByText('Not installed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install Claude Code' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/claude-code/install'));
    expect(await screen.findByRole('button', { name: /Installing Claude Code/ })).toBeDisabled();
  });

  it('installing: shows the progress Core sends by event', async () => {
    mocked.get.mockResolvedValue(
      status({
        installed: false,
        version: null,
        signed_in: false,
        install: { state: 'installing', error: null },
      }),
    );
    wrap(<ClaudeCodeGroup />);
    expect(await screen.findByText('Starting the installer.')).toBeInTheDocument();
    act(() =>
      onClaudeCodeChanged(
        {
          type: 'claude_code.changed',
          seq: 1,
          at: '',
          what: 'install',
          detail: 'Downloading Claude Code (40%)',
        },
        queryClient,
      ),
    );
    expect(await screen.findByText('Downloading Claude Code (40%)')).toBeInTheDocument();
  });

  it('a failed install says what happened', async () => {
    mocked.get.mockResolvedValue(
      status({
        installed: false,
        version: null,
        install: { state: 'failed', error: 'the download timed out' },
      }),
    );
    wrap(<ClaudeCodeGroup />);
    expect(await screen.findByText(/Installing did not finish: the download timed out/)).toBeInTheDocument();
  });

  it('too old: says to run claude update, and checks again', async () => {
    mocked.get.mockResolvedValue(status({ version: '1.0.3', version_ok: false }));
    wrap(<ClaudeCodeGroup />);
    expect(await screen.findByText('claude update')).toBeInTheDocument();
    expect(allText()).toContain('2.1.0 or later');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(mocked.get).toHaveBeenCalledTimes(2));
  });

  it("signed out: Sign in to Claude Code, opened by Claude Code's own window, never about subscriptions", async () => {
    mocked.get.mockResolvedValue(status({ signed_in: false, auth_method: null, plan: null }));
    mocked.post.mockResolvedValue(undefined);
    wrap(<ClaudeCodeGroup />);
    const button = await screen.findByRole('button', { name: 'Sign in to Claude Code' });
    expect(screen.getByText(SIGN_IN_NOTE)).toBeInTheDocument();
    expect(screen.getByText(NEVER_SEES)).toBeInTheDocument();
    expect(allText().toLowerCase()).not.toContain('subscription');
    fireEvent.click(button);
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/claude-code/sign-in'));
    expect(await screen.findByRole('button', { name: /Waiting for Claude Code/ })).toBeDisabled();
    expect(allText().toLowerCase()).not.toContain('subscription');
  });

  it('signed in: says how, in plain words, and offers no sign-in', async () => {
    mocked.get.mockResolvedValue(status());
    wrap(<ClaudeCodeGroup />);
    expect(await screen.findByText('Signed in with a Claude account, Max plan.')).toBeInTheDocument();
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in to Claude Code' })).toBeNull();
    expect(signedInWords({ auth_method: 'api_key', plan: null })).toBe(
      'Signed in with an Anthropic API key.',
    );
  });

  it('the switches patch exactly one setting, with the owner wording', async () => {
    mocked.get.mockResolvedValue(status());
    mocked.patch.mockResolvedValue(
      status({
        settings: {
          auto_install: true,
          auto_import: false,
          exclude_folders: ['~/.claude-mem'],
          claude_telemetry: true,
        },
      }),
    );
    wrap(<ClaudeCodeGroup />);
    const sw = await screen.findByRole('switch', { name: 'Bring Claude Code sessions in by themselves' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/claude-code/settings', { auto_import: false }),
    );
    expect(screen.getByRole('switch', { name: "Install Claude Code when it's missing" })).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Let Claude Code send usage data to Anthropic' }),
    ).toBeInTheDocument();
  });

  it('the SDK not being ready shows its reason', async () => {
    mocked.get.mockResolvedValue(
      status({ sdk: { ready: false, version: null, error: 'The Agent SDK could not be loaded.' } }),
    );
    wrap(<ClaudeCodeGroup />);
    expect(await screen.findByText(/The Agent SDK could not be loaded./)).toBeInTheDocument();
  });

  it('background import progress shows as a quiet line', async () => {
    mocked.get.mockResolvedValue(status());
    wrap(<ClaudeCodeGroup />);
    await screen.findByText('Signed in');
    act(() =>
      onClaudeCodeChanged(
        { type: 'claude_code.changed', seq: 2, at: '', what: 'sessions', detail: 'importing:3/12' },
        queryClient,
      ),
    );
    expect(await screen.findByText('Bringing in 3 of 12 sessions')).toBeInTheDocument();
  });
});

/* ---- Sessions ------------------------------------------------------------ */

const SESSIONS = [
  session({ session_id: 'a', title: 'Fix the login page' }),
  session({
    session_id: 'b',
    title: 'Write the README',
    thread_id: 't-b',
    behind: true,
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  }),
  session({
    session_id: 'c',
    title: 'Old experiment',
    cwd: '/home/me/gone',
    project: 'gone',
    cwd_missing: true,
    updated_at: new Date(Date.now() - 86_400_000 * 3).toISOString(),
  }),
  session({
    session_id: 'd',
    title: 'Running now',
    cwd: '/home/me/nvx_folio',
    project: 'nvx_folio',
    active_elsewhere: true,
    updated_at: new Date().toISOString(),
  }),
];

function serveSessions(items = SESSIONS, next: string | null = null) {
  mocked.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/claude-code/sessions')) {
      const cwd = new URLSearchParams(path.split('?')[1]).get('cwd');
      return { items: cwd ? items.filter((s) => s.cwd === cwd) : items, next_cursor: cwd ? null : next };
    }
    if (path === '/notebooks') return { items: [] };
    throw new Error(`unexpected ${path}`);
  });
}

const browser = (autoImport: boolean, onOpenThread = vi.fn()) =>
  wrap(
    <Dialog.Root open>
      <SessionsBrowser autoImport={autoImport} onClose={() => {}} onOpenThread={onOpenThread} />
    </Dialog.Root>,
  );

describe('grouping', () => {
  it('groups by folder, folders by their newest session, sessions newest first', () => {
    const g = groupSessions(SESSIONS);
    expect(g.map((x) => x.project)).toEqual(['nvx_folio', 'cyberfolio', 'gone']);
    expect(g[1]?.items.map((s) => s.session_id)).toEqual(['b', 'a']);
  });
});

describe('the sessions view when sessions come in by themselves', () => {
  it('is quiet: nothing to pick or import, and it says what is in and what is coming', async () => {
    serveSessions();
    const open = vi.fn();
    browser(true, open);
    expect(await screen.findByText('Fix the login page')).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull();
    expect(screen.getAllByText('Coming in').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /In NVX Ancile/ }));
    expect(open).toHaveBeenCalledWith('t-b');
  });

  it('shows the badges, and Sync brings a session that is behind up to date', async () => {
    serveSessions();
    mocked.post.mockResolvedValue({ added: 2 });
    browser(true);
    await screen.findByText('Write the README');
    expect(screen.getByText('New messages')).toBeInTheDocument();
    expect(screen.getByText('Folder missing')).toBeInTheDocument();
    expect(screen.getByText('Open in a terminal right now')).toBeInTheDocument();
    expect(allText()).toContain('waits until that terminal');
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/claude-code/threads/t-b/sync'));
    await waitFor(() => expect(useNotify.getState().toasts.at(-1)?.title).toBe('Added 2 messages'));
  });

  it('follows next_cursor with Show more', async () => {
    serveSessions(SESSIONS.slice(0, 1), 'page2');
    browser(true);
    const more = await screen.findByRole('button', { name: 'Show more' });
    serveSessions(SESSIONS.slice(1, 2), null);
    fireEvent.click(more);
    expect(await screen.findByText('Write the README')).toBeInTheDocument();
    expect(mocked.get).toHaveBeenCalledWith(expect.stringContaining('cursor=page2'));
  });

  it('renders a Core error with its title and hint', async () => {
    mocked.get.mockImplementation(async (path: string) => {
      if (path === '/notebooks') return { items: [] };
      throw new ApiCallError(
        409,
        localError(
          'claude_code.not_installed',
          'Claude Code is not installed',
          'Install it in Settings → Claude Code.',
          't',
        ),
      );
    });
    browser(true);
    expect(await screen.findByText('Claude Code is not installed')).toBeInTheDocument();
    expect(screen.getByText('Install it in Settings → Claude Code.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'How Claude Code works in NVX Ancile' })).toBeInTheDocument();
  });
});

describe('importing by hand (sessions do not come in by themselves)', () => {
  it('sends exactly the picked ids, with no notebook (the folder decides), and reports the result', async () => {
    serveSessions();
    mocked.post.mockResolvedValue({
      imported: [{ session_id: 'a', thread_id: 't-a', added: 14, notebook_id: 'nb1' }],
      failed: [
        { session_id: 'c', title: 'That folder is gone', hint: 'Import it into a notebook you choose.' },
      ],
    });
    const open = vi.fn();
    browser(false, open);
    await screen.findByText('Fix the login page');
    expect(screen.getByRole('button', { name: 'Import sessions' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fix the login page' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Old experiment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 sessions' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/claude-code/sessions/import', { session_ids: ['a', 'c'] }),
    );
    expect(await screen.findByText('Imported 1 session')).toBeInTheDocument();
    expect(screen.getByText('1 could not be imported')).toBeInTheDocument();
    expect(screen.getByText(/That folder is gone/)).toBeInTheDocument();
    expect(screen.getByText('Import it into a notebook you choose.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fix the login page' }));
    expect(open).toHaveBeenCalledWith('t-a');
  });

  it('Import all from this folder asks for every session in it and imports the ones not yet in', async () => {
    serveSessions();
    mocked.post.mockResolvedValue({ imported: [], failed: [] });
    browser(false);
    await screen.findByText('Fix the login page');
    const group = screen.getByRole('region', { name: 'cyberfolio' });
    fireEvent.click(within(group).getByRole('button', { name: 'Import all from this folder' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/claude-code/sessions/import', { session_ids: ['a'] }),
    );
    expect(mocked.get).toHaveBeenCalledWith(expect.stringContaining('cwd=%2Fhome%2Fme%2Fcyberfolio'));
  });
});

/* ---- Threads from Claude Code -------------------------------------------- */

describe('a thread from Claude Code', () => {
  it('says so quietly, with the folder and the session id', () => {
    wrap(
      <ClaudeCodeMarker
        threadId="t1"
        binding={{ session_id: 'abc-123', cwd: '/home/me/cyberfolio', last_uuid: null, synced_at: '' }}
      />,
    );
    const marker = screen.getByRole('button', { name: /From Claude Code in cyberfolio/ });
    expect(marker).toHaveAttribute('title', expect.stringContaining('abc-123'));
    expect(markerText(null)).toBe('From Claude Code');
    expect(markerText('C:\\work\\nvx_folio')).toBe('From Claude Code in nvx_folio');
  });

  it('Sync says how many messages came, or that it was up to date', async () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    mocked.post.mockResolvedValueOnce({ added: 3 }).mockResolvedValueOnce({ added: 0 });
    await syncThread('t1');
    expect(mocked.post).toHaveBeenCalledWith('/claude-code/threads/t1/sync');
    expect(useNotify.getState().toasts.at(-1)?.title).toBe('Added 3 messages');
    expect(spy).toHaveBeenCalledWith({ queryKey: keys.thread('t1') });
    await syncThread('t1');
    expect(useNotify.getState().toasts.at(-1)?.title).toBe('Already up to date');
  });

  it('an imported compaction becomes a divider, not a bubble', () => {
    const views = toMessageViews([
      message({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }),
      message({
        id: 'm2',
        role: 'user',
        parts: [{ type: 'text', text: 'Summary of earlier work' }],
        provenance: { claude_code: { session_id: 's', uuid: 'u', kind: 'compact_boundary' } },
      }),
    ]);
    expect(views[1]?.compactBoundary).toBe(true);
    expect(views[0]?.compactBoundary).toBeUndefined();
    render(<CompactionDivider />);
    expect(screen.getByRole('separator', { name: 'Conversation compacted here' })).toBeInTheDocument();
  });

  it('tool results in the next turn join the answer that called the tool; subagents ride along', () => {
    const views = toMessageViews([
      message({
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'tool_call', call_id: 'c1', tool: 'Task', args: { description: 'Look around' } }],
      }),
      message({
        id: 'u2',
        role: 'user',
        parts: [{ type: 'tool_result', call_id: 'c1', ok: true, result: 'done' }],
        provenance: {
          claude_code: {
            subagent: {
              call_id: 'c1',
              description: 'Explore the repo',
              messages: [
                { role: 'user', text: 'Find the router' },
                { role: 'assistant', parts: [{ type: 'text', text: 'It is in src/router.tsx' }] },
              ],
            },
          },
        },
      }),
    ]);
    expect(views).toHaveLength(2);
    expect(views[0]?.parts?.map((p) => p.type)).toEqual(['tool_call', 'tool_result']);
    expect(views[0]?.subagents?.[0]).toMatchObject({ callId: 'c1', title: 'Explore the repo' });
    expect(views[0]?.subagents?.[0]?.turns).toHaveLength(2);
    expect(views[1]?.folded).toBe(true);
    expect(subagentsOf(undefined)).toEqual([]);
    expect(subagentsOf('nonsense')).toEqual([]);
  });

  it('a subagent conversation starts folded away', () => {
    render(
      <SubagentConversation
        s={{ callId: null, title: 'Explore', turns: [{ role: 'assistant', text: 'Found it' }] }}
      />,
    );
    const details = screen.getByText('Subagent conversation').closest('details');
    expect(details).not.toHaveAttribute('open');
  });

  it('a long tool result starts short, with the rest one click away', () => {
    const text = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n');
    render(<ResultText text={text} />);
    expect(allText()).not.toContain('line 80');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 80 lines' }));
    expect(allText()).toContain('line 80');
  });
});

/* ---- Live ---------------------------------------------------------------- */

describe('claude_code.changed', () => {
  const ev = (
    what: 'install' | 'auth' | 'sessions' | 'thread',
    extra: { thread_id?: string; detail?: string } = {},
  ) => ({
    type: 'claude_code.changed' as const,
    seq: 9,
    at: '',
    what,
    ...extra,
  });

  it('install and auth refresh the status; sessions the list; thread that thread', () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(queryClient, 'invalidateQueries');
      onClaudeCodeChanged(ev('install', { detail: 'Verifying' }), queryClient);
      expect(spy).toHaveBeenLastCalledWith({ queryKey: CC_KEYS.status });
      expect(useInstallProgress.getState().detail).toBe('Verifying');
      onClaudeCodeChanged(ev('auth'), queryClient);
      expect(spy).toHaveBeenLastCalledWith({ queryKey: CC_KEYS.status });
      spy.mockClear();
      onClaudeCodeChanged(ev('sessions'), queryClient);
      vi.advanceTimersByTime(CC_INVALIDATE_MS);
      expect(spy).toHaveBeenLastCalledWith({ queryKey: CC_KEYS.sessions });
      spy.mockClear();
      onClaudeCodeChanged(ev('thread', { thread_id: 't7' }), queryClient);
      expect(spy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CC_INVALIDATE_MS);
      expect(spy).toHaveBeenCalledWith({ queryKey: keys.thread('t7') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a burst of events during an import refetches each query once, after a second', () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(queryClient, 'invalidateQueries');
      spy.mockClear();
      for (let i = 0; i < 30; i++) {
        onClaudeCodeChanged(ev('thread', { thread_id: `t${i % 3}` }), queryClient);
        onClaudeCodeChanged(ev('sessions', { detail: `importing:${i}/30` }), queryClient);
      }
      expect(spy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CC_INVALIDATE_MS);
      const asked = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
      expect(asked.sort()).toEqual(
        [CC_KEYS.sessions, ['usage', 'report'], keys.thread('t0'), keys.thread('t1'), keys.thread('t2')]
          .map((k) => JSON.stringify(k))
          .sort(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('the end of a background import is one toast, and clears the progress line', () => {
    useImportProgress.setState({ line: 'Bringing in 4 of 4 sessions' });
    onClaudeCodeChanged(ev('sessions', { detail: 'imported:4' }), queryClient);
    onClaudeCodeChanged(ev('sessions', { detail: 'imported:4' }), queryClient);
    const toasts = useNotify.getState().toasts.filter((t) => t.title.includes('Claude Code sessions'));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe('Brought in 4 Claude Code sessions');
    expect(useImportProgress.getState().line).toBeNull();
    expect(readSessionsDetail('Reading sessions')).toEqual({ kind: 'progress', line: 'Reading sessions' });
    expect(readSessionsDetail(undefined)).toBeNull();
  });
});

/* ---- Folders that never come in ----------------------------------------- */

describe("Don't bring in this folder", () => {
  it('the confirm says what happens to what is already in', () => {
    const c = excludeCopy('C:\\work\\nvx_folio');
    expect(c.action).toBe("Don't bring in this folder");
    expect(c.body).toBe(
      "Sessions from nvx_folio stop coming in. Threads already brought in from it are archived, not deleted, unless you've written in them.",
    );
  });

  it('posts the folder and takes the settings Core answers with', async () => {
    queryClient.setQueryData(CC_KEYS.status, status());
    mocked.post.mockResolvedValueOnce({
      auto_install: true,
      auto_import: true,
      exclude_folders: ['~/.claude-mem', '/home/me/site'],
      claude_telemetry: true,
    });
    expect(await excludeFolder('/home/me/site')).toBe(true);
    expect(mocked.post).toHaveBeenCalledWith('/claude-code/projects/exclude', { cwd: '/home/me/site' });
    expect(queryClient.getQueryData<ClaudeCodeStatus>(CC_KEYS.status)?.settings.exclude_folders).toContain(
      '/home/me/site',
    );
    expect(useNotify.getState().toasts.at(-1)?.title).toBe('Sessions from site no longer come in');
  });

  it('Settings lists the excluded folders, and removing one patches the rest', async () => {
    mocked.get.mockResolvedValue(
      status({
        settings: {
          auto_install: true,
          auto_import: true,
          exclude_folders: ['~/.claude-mem', '/home/me/old'],
          claude_telemetry: true,
        },
      }),
    );
    mocked.patch.mockResolvedValue({});
    wrap(<ClaudeCodeGroup />);
    const list = await screen.findByRole('list', { name: 'Excluded folders' });
    expect(within(list).getByText('~/.claude-mem')).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Bring in /home/me/old again' }));
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/claude-code/settings', {
        exclude_folders: ['~/.claude-mem'],
      }),
    );
  });
});

/* ---- Help ---------------------------------------------------------------- */

describe('the guide', () => {
  it('has the article, and every claude_code error points at it', () => {
    const a = articleById('claude-code')?.article;
    expect(a?.title).toBe('Using Claude Code in NVX Ancile');
    for (const code of [
      'not_installed',
      'signed_out',
      'version_old',
      'sdk_unavailable',
      'install_failed',
      'folder_excluded',
    ])
      expect(ERROR_ARTICLES[`claude_code.${code}`]).toBe('claude-code');
    expect(a?.body).toContain('never sees your Claude sign-in');
    expect(ARTICLES.some((x) => x.body.toLowerCase().includes('claude subscription'))).toBe(false);
    expect(a?.body).not.toContain('—');
  });
});
