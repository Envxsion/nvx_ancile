/**
 * Claude Code live sessions, the Cockpit half: a send carries exactly the
 * body Core expects (a fresh idempotency key, the parent, model and
 * effort), Stop is Claude Code's interrupt, the "/" menu is Claude Code's
 * own list grouped by where it comes from with a second level for values,
 * commands NVX Ancile handles are done here and never sent, the status
 * line and context meter read Claude Code's own state, a busy session
 * offers "Continue as a branch", an approval can be changed before it is
 * allowed once, and a turn from an earlier message forks there.
 */
import type { ClaudeCodeCommand, ClaudeCodeLiveState } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({
    children,
    to: _to,
    params: _p,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
  }) => (
    <a href="#link" {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ApprovalDialog } from '../src/approvals/ApprovalDialog';
import { argsKind } from '../src/approvals/EditArgs';
import { CcLiveLine, CcNotices, CcPickers, UsageBody, useCcActions } from '../src/claudecode/LiveBar';
import { ccMenu, fuzzyScore, interruptClaudeCode, liveWords, sendClaudeCode } from '../src/claudecode/live';
import { CC_EMPTY, noteRunWarning, patchCc, useCcStore } from '../src/claudecode/store';
import { ApiCallError, api, localError } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import { editMessage, regenerate, stopMessage } from '../src/lib/turns';
import type { MessageView, PendingApproval, ThreadView } from '../src/lib/types';
import { useNotify } from '../src/state/notify';
import { useUi } from '../src/state/ui';
import { Composer } from '../src/thread/Composer';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

function cmd(p: Partial<ClaudeCodeCommand> & Pick<ClaudeCodeCommand, 'name'>): ClaudeCodeCommand {
  return {
    description: `${p.name} does a thing`,
    argument_hint: null,
    arguments: [],
    source: 'builtin',
    handled_by: 'claude',
    ancile_action: null,
    ...p,
  };
}

const COMMANDS: ClaudeCodeCommand[] = [
  cmd({ name: 'compact', description: 'Summarise the conversation so far', argument_hint: '[instructions]' }),
  cmd({ name: 'review', description: 'Review a pull request' }),
  cmd({
    name: 'effort',
    description: 'Set how hard Claude Code thinks',
    handled_by: 'ancile',
    ancile_action: 'set_effort',
    arguments: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'].map((value) => ({
      value,
      description: null,
    })),
  }),
  cmd({
    name: 'model',
    description: 'Change the model',
    handled_by: 'ancile',
    ancile_action: 'set_model',
    arguments: [
      { value: 'opus', description: 'Opus' },
      { value: 'sonnet', description: 'Sonnet' },
    ],
  }),
  cmd({ name: 'mcp', description: 'Manage MCP servers', handled_by: 'ancile', ancile_action: 'open_mcp' }),
  cmd({
    name: 'theme',
    description: 'Change the colour theme',
    handled_by: 'ancile',
    ancile_action: 'unsupported',
  }),
  cmd({ name: 'keys', description: 'A skill that shares a name with NVX Ancile', source: 'skill' }),
  cmd({ name: 'deploy-site', description: 'Deploy the site', source: 'skill' }),
  cmd({ name: 'lint-fix', description: 'From a plugin', source: 'plugin' }),
  cmd({ name: 'mcp__github__pr', description: 'An MCP prompt', source: 'mcp' }),
];

const LIVE: ClaudeCodeLiveState = {
  state: 'ready',
  locked_elsewhere: false,
  model: 'opus',
  effort: 'high',
  permission_mode: 'default',
  cwd: '/home/me/cyberfolio',
  context: { used_tokens: 84_000, max_tokens: 200_000, percent: 42 },
};

function msg(p: Partial<MessageView> & Pick<MessageView, 'id' | 'role'>): MessageView {
  return {
    parentId: null,
    blocks: [],
    parts: [{ type: 'text', text: `${p.id} text` }],
    modelId: null,
    createdAt: new Date().toISOString(),
    status: 'complete',
    ...p,
  };
}

/** A thread from Claude Code in the cache: m1 → m2 → m3 → m4. */
function seedThread(): ThreadView {
  const t: ThreadView = {
    id: 'thr_1',
    title: 'Fix the login page',
    notebookId: 'nb_1',
    messages: [
      msg({ id: 'm1', role: 'user' }),
      msg({ id: 'm2', role: 'assistant', parentId: 'm1' }),
      msg({ id: 'm3', role: 'user', parentId: 'm2' }),
      msg({ id: 'm4', role: 'assistant', parentId: 'm3' }),
    ],
    claudeCode: {
      session_id: 's1',
      cwd: '/home/me/cyberfolio',
      last_uuid: null,
      synced_at: '2026-10-11T00:00:00Z',
    },
  };
  queryClient.setQueryData(keys.thread('thr_1'), t);
  return t;
}

// Every turn goes through the one front door (docs/engines.md).
const sent = () => mocked.post.mock.calls.filter(([path]) => String(path).endsWith('/turns'));
const apiErr = (status: number, code: string, title: string, hint: string) =>
  new ApiCallError(status, localError(code, title, hint, 'trace-1'));

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  mocked.get.mockImplementation((path: string) => {
    if (path.startsWith('/drafts')) return Promise.resolve({ text: '' });
    if (path.startsWith('/threads')) return Promise.resolve({ items: [], next: null });
    if (path.startsWith('/permissions/preset')) return Promise.resolve({ preset: 'balanced' });
    return Promise.resolve([]);
  });
  mocked.put.mockResolvedValue(undefined);
  mocked.post.mockResolvedValue({ run_id: 'run_1', user_message_id: 'msg_u1' });
  useCcStore.setState({ byThread: {} });
  useNotify.setState({ toasts: [], history: [] });
  navigate.mockReset();
  localStorage.clear();
});
// Unmount first: the composer saves its draft as it goes.
afterEach(() => cleanup());

/* ---- Send and stop -------------------------------------------------------- */

describe('sending a turn', () => {
  it('posts the text, parent, model and effort with a fresh idempotency key each time', async () => {
    seedThread();
    expect(
      await sendClaudeCode({
        threadId: 'thr_1',
        parentId: 'm4',
        text: 'Fix it',
        model: 'opus',
        effort: 'high',
      }),
    ).toBe(true);
    await sendClaudeCode({ threadId: 'thr_1', parentId: 'm4', text: 'Again', effort: 'auto' });
    const calls = sent() as [string, Record<string, unknown>][];
    const [path, first] = calls[0] ?? [];
    const second = calls[1]?.[1];
    expect(path).toBe('/threads/thr_1/turns');
    expect(first).toMatchObject({
      text: 'Fix it',
      parent_id: 'm4',
      model: 'claude-code/opus',
      effort: 'high',
    });
    // No model chosen: Claude Code carries the session on with its own default.
    expect(second).toMatchObject({ model: 'claude-code/default' });
    expect(typeof first?.idempotency_key).toBe('string');
    expect(String(first?.idempotency_key).length).toBeGreaterThanOrEqual(8);
    expect(second?.idempotency_key).not.toBe(first?.idempotency_key);
    // "auto" leaves the choice to Claude Code: nothing is sent for it.
    expect(second).not.toHaveProperty('effort');
    expect(first).not.toHaveProperty('as_branch');
  });

  it('puts your message on the thread at once, after the message it answers', async () => {
    seedThread();
    await sendClaudeCode({ threadId: 'thr_1', parentId: 'm2', text: 'Try another way' });
    const t = queryClient.getQueryData<ThreadView>(keys.thread('thr_1'));
    expect(t?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'msg_u1', 'cc-pending-run_1']);
    expect(t?.messages[2]?.parentId).toBe('m2');
  });

  it('Stop is Claude Code’s own interrupt, also from the message’s Stop button', async () => {
    seedThread();
    mocked.post.mockResolvedValue({ interrupted: true });
    await interruptClaudeCode('thr_1');
    await stopMessage('m4', 'thr_1');
    const paths = mocked.post.mock.calls.map(([p]) => p);
    expect(paths).toEqual(['/claude-code/threads/thr_1/interrupt', '/claude-code/threads/thr_1/interrupt']);
  });

  it('a turn from an earlier message passes that message as the parent (Claude Code forks there)', async () => {
    seedThread();
    // Edit your second message: the new turn hangs off m2, the answer before it.
    await editMessage('thr_1', msg({ id: 'm3', role: 'user', parentId: 'm2' }), 'Do it differently');
    // Try the last answer again: the same prompt, again from m2.
    seedThread();
    await regenerate('thr_1', msg({ id: 'm4', role: 'assistant', parentId: 'm3' }));
    const bodies = sent().map(([, b]) => b as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ text: 'Do it differently', parent_id: 'm2' });
    expect(bodies[1]).toMatchObject({ text: 'm3 text', parent_id: 'm2' });
    expect(mocked.post.mock.calls.some(([p]) => String(p).startsWith('/messages/'))).toBe(false);
  });

  it('the model and effort chosen in the composer ride on the next send', async () => {
    seedThread();
    const { result } = renderHook(() =>
      useCcActions({ threadId: 'thr_1', notebookId: 'nb_1', headId: 'm4' }),
    );
    act(() => result.current(COMMANDS[2] as ClaudeCodeCommand, 'max'));
    act(() => result.current(COMMANDS[3] as ClaudeCodeCommand, 'sonnet'));
    expect(mocked.post).not.toHaveBeenCalled();
    await editMessage('thr_1', msg({ id: 'm3', role: 'user', parentId: 'm2' }), 'Go');
    expect(sent()[0]?.[1]).toMatchObject({ model: 'claude-code/sonnet', effort: 'max' });
  });
});

/* ---- Busy and other refusals ---------------------------------------------- */

describe('when Claude Code refuses', () => {
  it('busy elsewhere: the notice offers Continue as a branch, which resends with as_branch', async () => {
    seedThread();
    mocked.post.mockRejectedValueOnce(
      apiErr(409, 'claude_code.session_busy', 'This session is open somewhere else', 'Close it there.'),
    );
    expect(await sendClaudeCode({ threadId: 'thr_1', parentId: 'm4', text: 'Carry on' })).toBe(false);
    expect(useNotify.getState().toasts).toHaveLength(0);
    wrap(<CcNotices threadId="thr_1" />);
    expect(screen.getByText(/open in Claude Code somewhere else/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue as a branch' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]?.[1]).toMatchObject({ text: 'Carry on', parent_id: 'm4', as_branch: true });
    await waitFor(() => expect(useCcStore.getState().byThread.thr_1?.notice).toBeNull());
  });

  it('signed out: the notice says so and offers to sign in', async () => {
    seedThread();
    mocked.post.mockRejectedValueOnce(
      apiErr(401, 'claude_code.signed_out', 'Claude Code is signed out', 'Sign in, then send again.'),
    );
    await sendClaudeCode({ threadId: 'thr_1', parentId: 'm4', text: 'Hello' });
    wrap(<CcNotices threadId="thr_1" />);
    expect(screen.getByText('Claude Code is signed out')).toBeInTheDocument();
    mocked.post.mockResolvedValueOnce({ started: true });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude Code' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/claude-code/sign-in'));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/settings/$group', params: { group: 'claude-code' } }),
    );
  });

  it('folder gone: Continue without files is kept on the thread, then your message goes', async () => {
    seedThread();
    mocked.post.mockRejectedValueOnce(
      apiErr(409, 'claude_code.folder_missing', "This session's folder has moved or been deleted", 'Point.'),
    );
    expect(await sendClaudeCode({ threadId: 'thr_1', parentId: 'm4', text: 'Carry on' })).toBe(false);
    wrap(<CcNotices threadId="thr_1" />);
    expect(screen.getByText(/folder has moved or been deleted/)).toBeInTheDocument();
    expect(screen.getByText('/home/me/cyberfolio')).toBeInTheDocument();
    mocked.post.mockImplementation(async (path: string) =>
      path.endsWith('/folder')
        ? { cwd: '/home/me/cyberfolio', no_files: true }
        : { run_id: 'run_2', user_message_id: 'msg_u2' },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue without files' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/claude-code/threads/thr_1/folder', { without_files: true }),
    );
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]?.[1]).toMatchObject({ text: 'Carry on', parent_id: 'm4' });
    expect(useNotify.getState().toasts.some((t) => t.title === 'Carrying on without files')).toBe(true);
  });

  it('folder gone: Point to new folder sends the path, and shows why Core refused one', async () => {
    seedThread();
    mocked.get.mockImplementation((path: string) =>
      path.endsWith('/live')
        ? Promise.resolve({ ...LIVE, cwd: '/home/me/old', folder_missing: true })
        : Promise.resolve([]),
    );
    wrap(<CcNotices threadId="thr_1" />);
    // Asked before you send: the live state already knows.
    fireEvent.click(await screen.findByRole('button', { name: 'Point to new folder' }));
    // The field takes focus, so you can type the path at once.
    await waitFor(() => expect(screen.getByLabelText(/^New folder/)).toHaveFocus());
    fireEvent.change(screen.getByLabelText(/^New folder/), { target: { value: '/elsewhere' } });
    mocked.post.mockRejectedValueOnce(
      apiErr(
        403,
        'claude_code.folder_out_of_scope',
        'That folder is outside what this notebook allows',
        'Choose.',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(await screen.findByText(/outside what this notebook allows/)).toBeInTheDocument();
    mocked.post.mockResolvedValueOnce({ cwd: '/home/me/new', no_files: false });
    fireEvent.change(screen.getByLabelText(/^New folder/), { target: { value: '/home/me/new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenLastCalledWith('/claude-code/threads/thr_1/folder', {
        cwd: '/home/me/new',
      }),
    );
    await waitFor(() => expect(useNotify.getState().toasts.at(-1)?.title).toBe('Folder updated'));
    // Nothing was waiting to be sent.
    expect(sent()).toHaveLength(0);
  });

  it('a restart during a turn leaves a quiet notice', () => {
    noteRunWarning('thr_1', 'claude_code.recovered');
    wrap(<CcNotices threadId="thr_1" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'NVX Ancile restarted during this turn; what Claude Code wrote has been brought in.',
    );
  });
});

/* ---- The "/" menu ----------------------------------------------------------- */

describe('the command menu', () => {
  it('groups Claude Code’s commands by where they come from; Claude Code wins a name clash', () => {
    const menu = ccMenu('/', COMMANDS, [
      { name: 'keys', description: 'Show keyboard shortcuts', run: 'shortcuts' },
      { name: 'sources', description: "Open this notebook's sources", run: 'sources' },
    ]);
    expect(menu?.level).toBe(1);
    const groups = [...new Set(menu?.items.map((i) => i.group))];
    expect(groups).toEqual(['Built-in', 'Your skills', 'Plugins', 'MCP prompts', 'NVX Ancile']);
    // /keys is the user's skill, so NVX Ancile's /keys is not offered twice.
    expect(menu?.items.filter((i) => i.label === '/keys')).toHaveLength(1);
    expect(menu?.items.find((i) => i.label === '/keys')?.group).toBe('Your skills');
    expect(menu?.items.find((i) => i.label === '/sources')?.group).toBe('NVX Ancile');
    expect(menu?.items.find((i) => i.label === '/theme')?.tag).toBe('Terminal only');
  });

  it('filters fuzzily, best match first', () => {
    expect(ccMenu('/eff', COMMANDS)?.items[0]?.label).toBe('/effort');
    expect(ccMenu('/dps', COMMANDS)?.items[0]?.label).toBe('/deploy-site');
    expect(fuzzyScore('zzz', 'compact')).toBeNull();
  });

  it('offers a command’s values as a second level', () => {
    const second = ccMenu('/effort ', COMMANDS);
    expect(second?.level).toBe(2);
    expect(second?.items.map((i) => i.label)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
    expect(ccMenu('/effort hi', COMMANDS)?.items[0]?.label).toBe('high');
    expect(ccMenu('/compact ', COMMANDS)).toBeNull();
  });

  function ccComposer(
    over: Partial<{ act: ReturnType<typeof vi.fn>; onSend: ReturnType<typeof vi.fn> }> = {},
  ) {
    const actFn = over.act ?? vi.fn();
    const onSend = over.onSend ?? vi.fn().mockResolvedValue(true);
    wrap(
      <Composer
        threadId="thr_1"
        parentId="m4"
        onSend={onSend}
        notebookId="nb_1"
        claudeCode={{ commands: COMMANDS, act: actFn, bar: <span />, working: false, onStop: vi.fn() }}
      />,
    );
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    return { input, act: actFn, onSend };
  }

  it('shows the groups with descriptions and argument hints', async () => {
    const { input } = ccComposer();
    fireEvent.change(input, { target: { value: '/' } });
    const list = await screen.findByRole('listbox', { name: 'Claude Code commands' });
    expect(within(list).getByText('Built-in')).toBeInTheDocument();
    expect(within(list).getByText('Your skills')).toBeInTheDocument();
    expect(within(list).getByText('[instructions]')).toBeInTheDocument();
    expect(within(list).getByText('Summarise the conversation so far')).toBeInTheDocument();
  });

  it('picking a value of a command NVX Ancile handles does it here and sends nothing', async () => {
    const { input, act: actFn, onSend } = ccComposer();
    fireEvent.change(input, { target: { value: '/eff' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('/effort ');
    const values = await screen.findByRole('listbox', { name: 'Values' });
    expect(
      within(values)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('xhigh');
    fireEvent.change(input, { target: { value: '/effort hi' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'effort' }), 'high');
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('a typed command NVX Ancile handles is never sent; one for Claude Code is sent as typed', async () => {
    const { input, act: actFn, onSend } = ccComposer();
    fireEvent.change(input, { target: { value: '/mcp' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(actFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'mcp' }), null));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '/compact keep the plan' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('/compact keep the plan', expect.anything()));
  });

  it('an unsupported command shows its description inline instead of being sent', () => {
    const { result } = renderHook(() =>
      useCcActions({ threadId: 'thr_1', notebookId: 'nb_1', headId: 'm4' }),
    );
    act(() => result.current(COMMANDS[5] as ClaudeCodeCommand, null));
    wrap(<CcNotices threadId="thr_1" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('/theme works in the Claude Code terminal only.');
    expect(alert).toHaveTextContent('Change the colour theme');
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('commands that open part of NVX Ancile go there', () => {
    const { result } = renderHook(() =>
      useCcActions({ threadId: 'thr_1', notebookId: 'nb_1', headId: 'm4' }),
    );
    act(() => result.current(COMMANDS[4] as ClaudeCodeCommand, null));
    expect(navigate).toHaveBeenCalledWith({ to: '/admin/$section', params: { section: 'plugins' } });
    act(() => result.current(cmd({ name: 'cost', handled_by: 'ancile', ancile_action: 'open_usage' }), null));
    expect(useCcStore.getState().byThread.thr_1?.usageOpen).toBe(true);
  });
});

/* ---- Live state ----------------------------------------------------------- */

describe('the status line', () => {
  const binding = { session_id: 's1', cwd: '/home/me/cyberfolio', last_uuid: null, synced_at: '' };

  it('says what the session is doing in plain words', () => {
    expect(liveWords(LIVE, 'cyberfolio')).toBe('Claude Code ready in cyberfolio');
    expect(liveWords({ ...LIVE, state: 'starting' }, 'cyberfolio')).toBe('Starting Claude Code…');
    expect(liveWords({ ...LIVE, state: 'working' }, 'cyberfolio')).toBe('Working…');
    expect(liveWords({ ...LIVE, locked_elsewhere: true, open_in_terminal: true }, 'cyberfolio')).toBe(
      'Open in a terminal: messages wait here until it closes',
    );
    expect(liveWords({ ...LIVE, folder_missing: true }, 'cyberfolio')).toBe(
      "This session's folder has moved or been deleted",
    );
    expect(liveWords({ ...LIVE, folder_missing: true, no_files: true }, 'cyberfolio')).toBe(
      'Claude Code ready without files',
    );
  });

  it('a session open in a terminal is sent as a branch, and says so once', async () => {
    seedThread();
    mocked.post.mockResolvedValue({
      run_id: 'run_1',
      user_message_id: 'msg_u1',
      engine: 'claude_code',
      model_id: null,
      context_notice: null,
      branched: 'open_in_terminal',
    });
    expect(await sendClaudeCode({ threadId: 'thr_1', parentId: 'm4', text: 'Go on' })).toBe(true);
    expect(useNotify.getState().toasts.at(-1)?.title).toBe('Sent as a branch');
  });

  it('shows the model, effort and Claude Code’s own context meter', () => {
    const { container } = wrap(
      <CcLiveLine threadId="thr_1" binding={binding} live={LIVE} last={undefined} />,
    );
    expect(screen.getByText('Claude Code ready in cyberfolio')).toBeInTheDocument();
    expect(screen.getByText('opus · high effort')).toBeInTheDocument();
    // The same meter as every thread's context, with Claude Code's own numbers.
    const meter = screen.getByRole('meter', { name: '42% of context' });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    expect(container.querySelector('.u-meter')).toHaveAttribute('data-tone', 'calm');
    expect(container.querySelector('.cc-live')).toHaveAttribute('data-state', 'ready');
  });

  it('working: the live dot', () => {
    const { container } = wrap(
      <CcLiveLine threadId="thr_1" binding={binding} live={{ ...LIVE, state: 'working' }} last={undefined} />,
    );
    expect(container.querySelector('.cc-live')).toHaveAttribute('data-state', 'working');
    expect(screen.getByText('Working…')).toBeInTheDocument();
  });

  it('the usage popover: context, last turn, plan limits, and a cost the Claude plan covers', async () => {
    const limits = {
      available: true,
      plan: 'max',
      windows: [
        {
          id: 'five_hour',
          kind: 'session',
          label: null,
          percent: 42,
          resets_at: null,
          status: null,
          updated_at: new Date().toISOString(),
        },
      ],
      updated_at: new Date().toISOString(),
      source: 'usage',
      can_refresh: true,
    };
    mocked.get.mockImplementation(async (path: string) =>
      path === '/claude-code/status'
        ? { installed: true, signed_in: true, auth_method: 'claude.ai', install: { state: 'idle' } }
        : limits,
    );
    const last = msg({ id: 'm4', role: 'assistant', usage: { tokens: 12_400, costUsd: 0.42 } });
    wrap(
      <UsageBody
        live={{
          ...LIVE,
          context: { used_tokens: 84_000, max_tokens: 200_000, percent: 42, compacts_at: 92 },
        }}
        last={last}
      />,
    );
    expect(screen.getByText('84k of 200k tokens')).toBeInTheDocument();
    expect(screen.getByText('42% of context: compacts at 92%')).toBeInTheDocument();
    expect(await screen.findByText('Current session (5 hours)')).toBeInTheDocument();
    expect(mocked.get).toHaveBeenCalledWith('/claude-code/plan-limits');
    expect(screen.getByRole('link', { name: 'All usage' })).toBeInTheDocument();
    expect(screen.getByText('12,400 tokens')).toBeInTheDocument();
    // Claude Code's estimate is not the bill: the plan covers it, and the estimate says what it is.
    expect(screen.getByText('Included in your Claude plan')).toBeInTheDocument();
    expect(screen.getByText('About $0.42 at API list prices, not a bill')).toBeInTheDocument();
  });

  it('the effort picker sets the effort for the next message', async () => {
    patchCc('thr_1', { picker: 'effort' });
    wrap(<CcPickers threadId="thr_1" live={LIVE} commands={COMMANDS} />);
    fireEvent.click(await screen.findByRole('menuitem', { name: /xhigh/ }));
    expect(useCcStore.getState().byThread.thr_1?.effort).toBe('xhigh');
    expect(screen.getByRole('button', { name: /Effort: xhigh/ })).toBeInTheDocument();
  });

  it("the setup chip turns on loading only this project's Claude Code settings", async () => {
    // An imported thread (no started_in): the whole setup until lean is turned on.
    seedThread();
    mocked.patch.mockResolvedValue({});
    wrap(<CcPickers threadId="thr_1" live={LIVE} commands={COMMANDS} />);
    const chip = await screen.findByRole('button', { name: /Claude Code settings: your whole setup/ });
    fireEvent.keyDown(chip, { key: 'Enter' });
    const item = await screen.findByRole('menuitemcheckbox', {
      name: /Load only this project's Claude Code settings/,
    });
    expect(item).toHaveAttribute('aria-checked', 'false');
    expect(item).toHaveTextContent(/user plugins, MCP servers and user CLAUDE\.md/);
    fireEvent.click(item);
    await waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { claude_code_lean: true }),
    );
    expect(queryClient.getQueryData<ThreadView>(keys.thread('thr_1'))?.claudeCode?.lean).toBe(true);
    expect(
      await screen.findByRole('button', { name: /Claude Code settings: this project's only/ }),
    ).toBeInTheDocument();
  });

  it('a thread started in NVX Ancile is lean until turned off', async () => {
    const t = seedThread();
    queryClient.setQueryData(keys.thread('thr_1'), {
      ...t,
      claudeCode: {
        ...(t.claudeCode as NonNullable<ThreadView['claudeCode']>),
        started_in: 'ancile' as const,
      },
    });
    wrap(<CcPickers threadId="thr_1" live={LIVE} commands={COMMANDS} />);
    expect(await screen.findByRole('button', { name: /this project's only/ })).toBeInTheDocument();
  });
});

/* ---- Approvals with edited arguments ------------------------------------- */

function approval(p: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'apr_1',
    runId: 'run_1',
    threadId: null,
    tool: 'Bash',
    action: 'shell.exec',
    resource: 'shell:npm test',
    tier: 'gated',
    argsPreview: 'command: npm test',
    args: { command: 'npm test', description: 'Run the tests' },
    argsEditable: true,
    suggestions: ['shell:npm test'],
    reason: 'The agent wants to run npm test.',
    ...p,
  };
}

describe('edit before allowing', () => {
  beforeEach(() => useUi.setState({ approvalOpen: true, demo: false }));

  it('picks an editor by tool', () => {
    expect(argsKind('Bash', { command: 'ls' })).toBe('shell');
    expect(argsKind('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' })).toBe('edit');
    expect(argsKind('MultiEdit', { file_path: 'a', edits: [{ old_string: 'x', new_string: 'y' }] })).toBe(
      'multiedit',
    );
    expect(argsKind('Write', { file_path: 'a', content: '' })).toBe('write');
    expect(argsKind('WebFetch', { url: 'https://x', prompt: 'p' })).toBe('fetch');
    expect(argsKind('mcp__github__create_issue', { title: 't' })).toBe('json');
  });

  it('Bash: change the command, remembering is off, and it is allowed once with the changes', async () => {
    mocked.post.mockResolvedValue(undefined);
    wrap(<ApprovalDialog approval={approval()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit before allowing' }));
    expect(screen.getByText(/Changes apply to this call only/)).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByText('Run the tests')).toBeInTheDocument();
    const allow = screen.getByRole('button', { name: 'Allow once with changes' });
    expect(allow).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npm test -- --run' } });
    fireEvent.click(allow);
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/approvals/apr_1', {
        decision: 'approve',
        scope: 'once',
        updated_args: { command: 'npm test -- --run', description: 'Run the tests' },
      }),
    );
  });

  it('Edit: old and new text with a live diff; a refused change is shown and the dialog stays open', async () => {
    mocked.post.mockRejectedValueOnce(
      apiErr(
        422,
        'permission.edited_args_denied',
        'The changed call is not allowed',
        'Writing outside the session folder is blocked.',
      ),
    );
    wrap(
      <ApprovalDialog
        approval={approval({
          tool: 'Edit',
          action: 'fs.write',
          resource: 'fs:/home/me/app/a.ts',
          args: { file_path: '/home/me/app/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit before allowing' }));
    expect(screen.getByText('/home/me/app/a.ts')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('With this'), { target: { value: 'const a = 3;' } });
    expect(screen.getByRole('group', { name: 'What the edit will do' })).toHaveTextContent('const a = 3;');
    fireEvent.click(screen.getByRole('button', { name: 'Allow once with changes' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The changed call is not allowed'),
    );
    expect(mocked.post.mock.calls[0]?.[1]).toMatchObject({
      decision: 'approve',
      scope: 'once',
      updated_args: {
        file_path: '/home/me/app/a.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 3;',
      },
    });
    expect(useUi.getState().approvalOpen).toBe(true);
    expect(useNotify.getState().toasts).toHaveLength(0);
  });

  it('an approval that cannot be changed has no edit mode', () => {
    wrap(<ApprovalDialog approval={approval({ argsEditable: undefined, args: undefined })} />);
    expect(screen.queryByRole('button', { name: 'Edit before allowing' })).toBeNull();
  });
});

describe('the store', () => {
  it('starts empty for a thread', () => {
    expect(useCcStore.getState().byThread.nope ?? CC_EMPTY).toEqual(CC_EMPTY);
  });
});
