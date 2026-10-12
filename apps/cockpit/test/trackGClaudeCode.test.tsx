/**
 * Track G, Claude Code and mixed models, the Cockpit half: every request
 * names its window; another window sending offers "Send as a branch" and
 * sends once that turn ends; the plan's limit says when it resets and
 * finishes on another model with the continuation; a limit past 90% is a
 * quiet line; Claude Code's own compaction is one folded terminal entry in
 * a mixed thread; a thread on a machine without Claude Code is read-only
 * for it with one line; and two folder notebooks that are one repository
 * get a one-line suggestion and sit together in the sidebar.
 */
import { CLIENT_ID_HEADER, CONTINUE_AFTER_LIMIT, type Message, type PlanWindow } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

vi.mock('../src/lib/run', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/run')>();
  return { ...real, attachRun: vi.fn() };
});

import {
  finishModels,
  LimitNotice,
  limitOf,
  limitTitle,
  nearLimit,
  nearLimitWords,
} from '../src/claudecode/LimitNotice';
import { sendClaudeCode } from '../src/claudecode/live';
import { groupTogether, SameRepoHint, sameRepoLine } from '../src/claudecode/SameRepo';
import { CcEventRow, TERMINAL_COMPACTION } from '../src/claudecode/ThreadMarker';
import { ClaudeCodeUnavailable, unavailableLine } from '../src/claudecode/Unavailable';
import { ApiCallError, api, localError, WINDOW_ID } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { isMixedThread, toMessageViews } from '../src/lib/mappers';
import { queryClient } from '../src/lib/query';
import { sendMessage } from '../src/lib/turns';
import type { MessageView, ModelView, ThreadView } from '../src/lib/types';
import { BusyNotice } from '../src/thread/BusyNotice';
import { markBusy, useBusyStore } from '../src/thread/busy-store';
import { Composer } from '../src/thread/Composer';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );
const busyError = () =>
  new ApiCallError(
    409,
    localError(
      'thread.busy',
      'Another window is sending in this thread',
      'Wait for it to finish, or send as a branch.',
      't',
    ),
  );

beforeEach(() => {
  mocked.get.mockReset();
  mocked.post.mockReset();
  mocked.get.mockResolvedValue([]);
  useBusyStore.setState({ byThread: {} });
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('every request names its window', () => {
  it('sends the window id header Core uses for the send lock', async () => {
    const real = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
    const fetchSpy = vi.fn(
      async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await real.api.get('/engines');
    const headers = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers[CLIENT_ID_HEADER]).toBe(WINDOW_ID);
    expect(WINDOW_ID).toMatch(/^w[0-9a-f]{24}$/);
    vi.unstubAllGlobals();
  });
});

describe('another window is sending', () => {
  it('keeps your text, offers Send as a branch, and sends once the other turn ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), {
      id: 'thr_1',
      title: 't',
      notebookId: null,
      model: null,
      messages: [],
      activeRun: { id: 'run_other', messageId: 'm' },
      claudeCode: null,
      headId: null,
      total: 0,
      cursor: null,
      hasMore: false,
    });
    mocked.post.mockRejectedValueOnce(busyError());
    expect(await sendMessage({ threadId: 'thr_1', parentId: 'msg_a', text: 'Mine' })).toBe(false);
    expect(useBusyStore.getState().byThread.thr_1?.state).toBe('refused');

    const sent = vi.fn();
    wrap(<BusyNotice threadId="thr_1" onSent={sent} />);
    expect(screen.getByText(/Another window is sending in this thread/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send as a branch' }));
    expect(screen.getByText(/sends as a branch when the other window's turn ends/)).toBeTruthy();

    // Still running: nothing is sent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(mocked.post).toHaveBeenCalledTimes(1);

    // The other turn ended: the same message goes, from the same parent (a branch).
    queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), (t) => (t ? { ...t, activeRun: null } : t));
    mocked.post.mockResolvedValueOnce({ run_id: 'run_2', user_message_id: 'u2', assistant_message_id: 'a2' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await waitFor(() => expect(sent).toHaveBeenCalled());
    const [, body] = mocked.post.mock.calls[1] as [string, { parent_id: string; text: string }];
    expect(body).toMatchObject({ parent_id: 'msg_a', text: 'Mine' });
    expect(useBusyStore.getState().byThread.thr_1).toBeUndefined();
  });

  it('a Claude Code send refused the same way goes again as a fork of the session', async () => {
    mocked.post.mockRejectedValueOnce(busyError());
    expect(await sendClaudeCode({ threadId: 'thr_cc', parentId: 'msg_a', text: 'Go on' })).toBe(false);
    mocked.post.mockResolvedValueOnce({
      run_id: 'r',
      user_message_id: 'u',
      assistant_message_id: 'a',
      engine: 'claude_code',
    });
    await useBusyStore.getState().byThread.thr_cc?.again();
    expect(mocked.post.mock.calls[1]?.[1]).toMatchObject({ as_branch: true, parent_id: 'msg_a' });
  });

  it('a message already waiting keeps waiting when refused again', () => {
    const again = async () => true;
    useBusyStore.getState().set('thr_1', { state: 'waiting', again, since: 1 });
    markBusy('thr_1', again);
    expect(useBusyStore.getState().byThread.thr_1?.state).toBe('waiting');
  });
});

const model = (id: string, extra: Partial<ModelView> = {}): ModelView =>
  ({
    id,
    name: id.split('/')[1],
    provider: id.split('/')[0],
    via: 'direct',
    status: 'ready',
    ...extra,
  }) as ModelView;

describe("Claude Code's plan limit", () => {
  const now = new Date(2026, 9, 12, 13, 20).getTime();
  it('says when it resets in local time', () => {
    expect(limitTitle(new Date(2026, 9, 12, 14, 0).toISOString(), now)).toBe(
      'Claude Code limit reached, resets at 14:00',
    );
    expect(limitTitle(new Date(2026, 9, 19, 9, 5).toISOString(), now)).toBe(
      'Claude Code limit reached, resets Mon 09:05',
    );
    expect(limitTitle(null, now)).toBe('Claude Code limit reached');
  });

  it('offers your default model that is not Claude Code first, and sends the continuation to the one you choose', async () => {
    const models = [
      model('claude-code/opus'),
      model('openai/gpt-5'),
      model('ollama/llama3'),
      model('x/emb', { chat: false }),
    ];
    expect(finishModels(models, 'openai/gpt-5').map((m) => m.id)).toEqual(['openai/gpt-5', 'ollama/llama3']);
    expect(finishModels(models, 'claude-code/opus')[0]?.id).toBe('openai/gpt-5');

    const head: MessageView = {
      id: 'msg_a2',
      parentId: 'msg_u2',
      role: 'assistant',
      blocks: [],
      modelId: null,
      createdAt: '',
      status: 'error',
      provenance: {
        error: {
          code: 'claude_code.plan_limit',
          title: 'x',
          hint: 'y',
          resets_at: new Date(2026, 9, 12, 14, 0).toISOString(),
        },
      } as MessageView['provenance'],
    };
    expect(limitOf(head)?.resetsAt).toBeTruthy();
    expect(limitOf({ ...head, provenance: {} as MessageView['provenance'] })).toBeUndefined();

    mocked.get.mockImplementation(async (path: string) => (path === '/models' ? models : []));
    queryClient.setQueryData(keys.models, models);
    mocked.post.mockResolvedValueOnce({
      run_id: 'r',
      user_message_id: 'u',
      assistant_message_id: 'a',
      engine: 'gateway',
    });
    wrap(<LimitNotice threadId="thr_cc" head={head} />);
    expect(screen.getByText(/Claude Code limit reached, resets/)).toBeTruthy();
    const trigger = screen.getByRole('button', { name: /Finish on another model/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /gpt-5/ }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalled());
    expect(mocked.post.mock.calls[0]?.[1]).toMatchObject({
      text: CONTINUE_AFTER_LIMIT,
      model: 'openai/gpt-5',
      parent_id: 'msg_a2',
    });
  });

  it('warns quietly before a turn when a limit is past 90%', () => {
    const w = (percent: number, kind: PlanWindow['kind'] = 'session'): PlanWindow => ({
      id: kind,
      kind,
      label: null,
      percent,
      resets_at: new Date(now + 3_600_000).toISOString(),
      status: null,
      updated_at: null as unknown as string,
    });
    expect(nearLimit([w(42), w(85, 'week')], now)).toBeNull();
    const near = nearLimit([w(42), w(93, 'week')], now);
    expect(near?.kind).toBe('week');
    expect(nearLimitWords(near as PlanWindow)).toMatch(
      /^Claude Code's weekly limit is 93% used, resets at \d\d:\d\d$/,
    );
  });
});

const msg = (
  id: string,
  role: Message['role'],
  text: string,
  cc?: Record<string, unknown>,
  model?: string,
): Message =>
  ({
    id,
    thread_id: 'thr_1',
    parent_id: null,
    role,
    parts: [{ type: 'text', text }],
    status: 'complete',
    model_id: model ?? null,
    provenance: cc ? { claude_code: { session_id: 'S', uuid: id, ...cc } } : {},
    created_at: '',
  }) as unknown as Message;

describe("Claude Code's compaction in a mixed thread", () => {
  const thread = [
    msg('u1', 'user', 'Fix it', {}),
    msg('a1', 'assistant', 'Fixed.', {}),
    msg('cb', 'system', '', { kind: 'compact_boundary', uuid: '' }),
    msg('cs', 'system', 'TERMINAL SUMMARY', { kind: 'compact_summary' }),
  ];

  it('is one folded terminal entry when other models answer too', () => {
    expect(isMixedThread(thread)).toBe(false);
    const pure = toMessageViews(thread);
    expect(pure.find((v) => v.id === 'cs')?.cc).toMatchObject({ kind: 'compact_summary' });
    expect(
      (pure.find((v) => v.id === 'cs')?.cc as { terminal?: boolean } | undefined)?.terminal,
    ).toBeUndefined();

    const mixed = [
      ...thread,
      msg('u2', 'user', 'Explain'),
      msg('a2', 'assistant', 'Sure', undefined, 'openai/gpt-5'),
    ];
    expect(isMixedThread(mixed)).toBe(true);
    const views = toMessageViews(mixed);
    const boundary = views.find((v) => v.id === 'cb')?.cc;
    const summary = views.find((v) => v.id === 'cs')?.cc;
    if (!boundary || !summary) throw new Error('missing rows');
    const { container } = render(
      <>
        <CcEventRow e={boundary} />
        <CcEventRow e={summary} />
      </>,
    );
    expect(screen.getAllByText(TERMINAL_COMPACTION)).toHaveLength(1);
    expect(screen.queryByText('Conversation compacted here')).toBeNull();
    const details = container.querySelector('details[data-kind="terminal-compaction"]') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('TERMINAL SUMMARY');
  });
});

describe('Claude Code not on this machine', () => {
  it('one line and the action, and the composer is read-only for Claude Code', () => {
    expect(unavailableLine(undefined)).toBeNull();
    expect(unavailableLine({ availability: 'ready' } as never)).toBeNull();
    expect(unavailableLine({ availability: 'signed_out' } as never)).toBe(
      'Sign in to Claude Code to continue',
    );
    wrap(<ClaudeCodeUnavailable threadId="thr_cc" live={{ availability: 'not_installed' } as never} />);
    expect(screen.getByText('Install Claude Code to continue')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install Claude Code' })).toBeTruthy();
    cleanup();

    const onSend = vi.fn();
    wrap(
      <Composer
        threadId="thr_cc"
        parentId={null}
        onSend={onSend}
        claudeCode={{
          commands: [],
          act: () => undefined,
          bar: null,
          working: false,
          onStop: () => undefined,
          readOnly: 'Install Claude Code to continue',
        }}
      />,
    );
    const box = screen.getByPlaceholderText('Install Claude Code to continue') as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('one repository in two folders', () => {
  it('suggests in one line; Show together and Keep apart say so to Core', async () => {
    expect(sameRepoLine({ title: 'app', reason: 'worktree' })).toBe('Same repository as app (a worktree)');
    mocked.get.mockResolvedValue({
      items: [
        {
          notebook_id: 'nbk_app',
          title: 'app',
          reason: 'worktree',
          cwd: '/w/app-x',
          other_cwd: '/w/app',
          together: false,
        },
      ],
      can_merge: false,
    });
    mocked.post.mockResolvedValue({ items: [], can_merge: false });
    wrap(<SameRepoHint notebookId="nbk_feature" />);
    expect(await screen.findByText('Same repository as app (a worktree)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep apart' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/claude-code/notebooks/nbk_feature/same-repo', {
        other_notebook_id: 'nbk_app',
        choice: 'keep_apart',
      }),
    );
    await waitFor(() => expect(screen.queryByText(/Same repository as/)).toBeNull());
  });

  it('keeps notebooks shown together side by side in the sidebar', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const out = groupTogether(items, [['a', 'd']]);
    expect(out.items.map((x) => x.id)).toEqual(['a', 'd', 'b', 'c']);
    expect([...out.joined]).toEqual(['d']);
  });
});
