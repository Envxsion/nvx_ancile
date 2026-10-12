/**
 * One composer, any model (Phase 3 A), the Cockpit half: the picker groups
 * Claude Code, cloud and local models with an engine badge and says why an
 * entry is off; every plain turn goes through POST /threads/:id/turns; a
 * Claude Code thread can hand a turn to another model and back; the context
 * notice shows once per turn; the first message of a Claude Code session
 * can be edited; and a new Claude Code thread starts in a folder.
 */
import type { EffectiveScope, EngineInfo, ScopeValues } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: () => undefined,
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { sendClaudeCode } from '../src/claudecode/live';
import { NewClaudeCodeThread } from '../src/claudecode/NewThread';
import { useCcStore } from '../src/claudecode/store';
import { modelGroups } from '../src/engines/api';
import { ContextNotice } from '../src/engines/ContextNotice';
import { ModelMenu } from '../src/engines/ModelMenu';
import { showContextNotice, useContextNotices } from '../src/engines/notice';
import { api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { chooseInClaudeCodeThread } from '../src/lib/models';
import { queryClient } from '../src/lib/query';
import { attachRun, useRuns } from '../src/lib/run';
import { editMessage, sendMessage } from '../src/lib/turns';
import type { MessageView, ModelView, ThreadView } from '../src/lib/types';
import { DEFAULT_SCOPE } from '../src/scopes/api';
import { flowKeys } from '../src/thread/flowActions';

vi.mock('../src/lib/sse', () => ({ openStream: vi.fn(() => () => {}) }));

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

const model = (p: Partial<ModelView> & Pick<ModelView, 'id' | 'name'>): ModelView => ({
  provider: 'x',
  hue: 'azure',
  via: 'direct',
  contextWindow: 100_000,
  status: 'ready',
  ...p,
});

const MODELS: ModelView[] = [
  model({ id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', local: false }),
  model({ id: 'openai/gpt-5.5', name: 'GPT-5.5', local: false }),
  model({ id: 'ollama/qwen3:14b', name: 'Qwen3 14B', local: true }),
  model({ id: 'controller/qwen3-72b', name: 'Qwen3 72B', via: 'controller', local: true }),
  model({ id: 'claude-code/opus', name: 'Claude Code Opus' }),
  model({ id: 'voyage/embed', name: 'Embeddings', chat: false }),
];

const ENGINES: EngineInfo[] = [
  {
    id: 'gateway',
    kind: 'gateway',
    display_name: 'NVX Ancile',
    available: true,
    reason: null,
    capabilities: { streaming: true, tools: true, images: true, own_context: false, context_window: null },
    model_prefix: null,
  },
  {
    id: 'claude_code',
    kind: 'claude_code',
    display_name: 'Claude Code',
    available: true,
    reason: null,
    capabilities: { streaming: true, tools: true, images: false, own_context: true, context_window: null },
    model_prefix: 'claude-code/',
  },
];

function scope(p: Partial<ScopeValues> = {}, extra: Partial<EffectiveScope> = {}): EffectiveScope {
  return {
    notebook_id: 'nb_1',
    thread_id: 'thr_1',
    private: false,
    scope: { ...DEFAULT_SCOPE, ...p },
    provenance: {},
    clamped: [],
    ...extra,
  } as EffectiveScope;
}

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

function seed(claudeCode: boolean): void {
  queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), {
    id: 'thr_1',
    title: 'Fix the login page',
    notebookId: 'nb_1',
    messages: [msg({ id: 'm1', role: 'user' }), msg({ id: 'm2', role: 'assistant', parentId: 'm1' })],
    ...(claudeCode && {
      claudeCode: {
        session_id: 's1',
        cwd: '/home/me/app',
        last_uuid: null,
        synced_at: '2026-10-11T00:00:00Z',
      },
    }),
  });
}

const posted = (suffix: string) =>
  mocked.post.mock.calls.filter(([p]) => String(p).endsWith(suffix)) as [string, Record<string, unknown>][];

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  mocked.get.mockResolvedValue({ items: [] });
  mocked.post.mockResolvedValue({
    run_id: 'run_1',
    user_message_id: 'msg_u1',
    assistant_message_id: 'msg_a1',
    engine: 'gateway',
    model_id: null,
    context_notice: null,
  });
  useCcStore.setState({ byThread: {} });
  useContextNotices.setState({ byThread: {}, seen: {} });
  useRuns.setState({ turns: {} });
  navigate.mockReset();
});
afterEach(() => cleanup());

/* ---- The picker ----------------------------------------------------------- */

describe('the model picker', () => {
  it('groups Claude Code, cloud and local models, each with its engine badge', () => {
    const groups = modelGroups({
      models: MODELS,
      engines: ENGINES,
      scope: null,
      session: null,
      currentId: null,
    });
    expect(groups.map((g) => g.label)).toEqual(['Claude Code models', 'Cloud models', 'Local models']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['claude-code/opus']);
    expect(groups[1]?.items.map((i) => i.name)).toEqual(['Claude Sonnet 5.5', 'GPT-5.5']);
    expect(groups[2]?.items.map((i) => [i.name, i.badge])).toEqual([
      ['Qwen3 14B', 'Local'],
      ['Qwen3 72B', 'GPU node'],
    ]);
    // Embedding models never answer a chat.
    expect(groups.flatMap((g) => g.items).some((i) => i.id === 'voyage/embed')).toBe(false);
  });

  it('a private notebook keeps local models only, and says so on every other entry', () => {
    const groups = modelGroups({
      models: MODELS,
      engines: ENGINES,
      scope: scope({ data_leaves_machine: false, engines: ['gateway_local'] }, { private: true }),
      session: null,
      currentId: null,
    });
    const all = groups.flatMap((g) => g.items);
    for (const e of all.filter((i) => i.kind !== 'local'))
      expect(e.disabled).toBe('This notebook is private: local models only');
    expect(all.filter((i) => i.kind === 'local').every((i) => i.disabled === null)).toBe(true);
  });

  it('a thread that turned cloud models off, a blocked model and Claude Code not ready each explain why', () => {
    const groups = modelGroups({
      models: MODELS,
      engines: ENGINES.map((e) =>
        e.kind === 'claude_code' ? { ...e, available: false, reason: 'Claude Code is signed out' } : e,
      ),
      scope: scope(
        { engines: ['gateway_local', 'claude_code'], models_deny: ['ollama/**'] },
        { provenance: { engines: { level: 'thread', note: null } } as EffectiveScope['provenance'] },
      ),
      session: null,
      currentId: null,
    });
    const by = (id: string) => groups.flatMap((g) => g.items).find((i) => i.id === id);
    expect(by('openai/gpt-5.5')?.disabled).toBe('Cloud models are off for this thread');
    expect(by('ollama/qwen3:14b')?.disabled).toBe('Blocked for this notebook');
    expect(by('claude-code/opus')?.disabled).toBe('Claude Code is signed out');
    expect(by('controller/qwen3-72b')?.disabled).toBeNull();
  });

  it("in a Claude Code thread, the Claude Code group is the session's own models", () => {
    const groups = modelGroups({
      models: MODELS,
      engines: ENGINES,
      scope: null,
      session: {
        options: [
          { value: 'opus', description: 'Opus' },
          { value: 'sonnet', description: 'Sonnet' },
        ],
        current: 'sonnet',
      },
      currentId: 'claude-code/default',
    });
    expect(groups[0]?.items.map((i) => [i.id, i.current])).toEqual([
      ['claude-code/opus', false],
      ['claude-code/sonnet', true],
    ]);
  });

  it('shows disabled entries with their reason, and picks an allowed one', async () => {
    const onPick = vi.fn();
    const groups = modelGroups({
      models: MODELS,
      engines: ENGINES,
      scope: scope({ data_leaves_machine: false }),
      session: null,
      currentId: 'ollama/qwen3:14b',
    });
    wrap(
      <ModelMenu
        open
        groups={groups}
        onPick={onPick}
        threadId="thr_1"
        trigger={<button type="button">Model</button>}
      />,
    );
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Cloud models')).toBeInTheDocument();
    const gpt = within(menu).getByText('GPT-5.5').closest('[role="menuitem"]') as HTMLElement;
    expect(gpt).toHaveAttribute('data-disabled');
    expect(gpt).toHaveTextContent('Nothing leaves this computer in this notebook: local models only');
    expect(within(gpt).getByText('Cloud')).toBeInTheDocument();
    fireEvent.click(within(menu).getByText('Qwen3 72B'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'controller/qwen3-72b' }));
    // The scope hid something: the way to change it is one row away.
    expect(within(menu).getByText('See what this thread may use')).toBeInTheDocument();
  });
});

/* ---- Sending ----------------------------------------------------------- */

describe('sending a turn', () => {
  it('a plain message goes through POST /threads/:id/turns, with your default when no flow answers', async () => {
    seed(false);
    queryClient.setQueryData(flowKeys.resolve('thr_1'), { flow: null, from: 'none', paused: null });
    const ok = await sendMessage({
      threadId: 'thr_1',
      parentId: 'm2',
      text: 'Next step?',
      defaultModel: 'openai/gpt-5.5',
      mentions: [{ kind: 'source', id: 'src_1' }],
    });
    expect(ok).toBe(true);
    const [path, body] = posted('/turns')[0] ?? [];
    expect(path).toBe('/threads/thr_1/turns');
    expect(body).toMatchObject({
      text: 'Next step?',
      parent_id: 'm2',
      model: 'openai/gpt-5.5',
      source_ids: ['src_1'],
    });
    expect(String(body?.idempotency_key).length).toBeGreaterThanOrEqual(8);
    const t = queryClient.getQueryData<ThreadView>(keys.thread('thr_1'));
    expect(t?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'msg_u1', 'msg_a1']);
  });

  it('when a flow answers, the turn carries no model so the flow keeps it', async () => {
    seed(false);
    queryClient.setQueryData(flowKeys.resolve('thr_1'), {
      flow: { id: 'f1' },
      from: 'notebook',
      paused: null,
    });
    await sendMessage({ threadId: 'thr_1', parentId: 'm2', text: 'Go', defaultModel: 'openai/gpt-5.5' });
    expect(posted('/turns')[0]?.[1]).not.toHaveProperty('model');
  });

  it('a @flow or @notebook message still uses the older route that understands them', async () => {
    seed(false);
    queryClient.setQueryData(flowKeys.resolve('thr_1'), { flow: null, from: 'none', paused: null });
    await sendMessage({ threadId: 'thr_1', parentId: 'm2', text: 'Go', flowId: 'flow_1' });
    expect(posted('/turns')).toHaveLength(0);
    expect(posted('/threads/thr_1/messages')).toHaveLength(1);
  });

  it('a Claude Code thread can hand the next turn to another model and back, keeping its session', async () => {
    seed(true);
    chooseInClaudeCodeThread('thr_1', { id: 'openai/gpt-5.5', name: 'GPT-5.5' });
    const st = useCcStore.getState().byThread.thr_1;
    expect(st?.other).toEqual({ id: 'openai/gpt-5.5', name: 'GPT-5.5' });
    await sendClaudeCode({
      threadId: 'thr_1',
      parentId: 'm2',
      text: 'Your view?',
      effort: 'high',
      other: st?.other,
    });
    expect(posted('/turns')[0]?.[1]).toMatchObject({ model: 'openai/gpt-5.5' });
    // Effort and branching are Claude Code's; they never ride on another model's turn.
    expect(posted('/turns')[0]?.[1]).not.toHaveProperty('effort');
    chooseInClaudeCodeThread('thr_1', { id: 'claude-code/sonnet', name: 'sonnet' });
    expect(useCcStore.getState().byThread.thr_1).toMatchObject({ other: null, model: 'sonnet' });
    const after = useCcStore.getState().byThread.thr_1;
    await sendClaudeCode({ threadId: 'thr_1', parentId: 'm2', text: 'Back to you', model: after?.model });
    expect(posted('/turns')[1]?.[1]).toMatchObject({ model: 'claude-code/sonnet' });
  });

  it('editing the first message of a Claude Code session sends from the start (parent null)', async () => {
    seed(true);
    const ok = await editMessage('thr_1', msg({ id: 'm1', role: 'user', parentId: null }), 'Start again');
    expect(ok).toBe(true);
    expect(posted('/turns')[0]?.[1]).toMatchObject({ text: 'Start again', parent_id: null });
    // The new first message is a root of its own: nothing of the old path is kept above it.
    const t = queryClient.getQueryData<ThreadView>(keys.thread('thr_1'));
    expect(t?.messages.map((m) => m.id)).toEqual(['msg_u1', 'msg_a1']);
  });
});

/* ---- The context notice ------------------------------------------------- */

describe('the context notice', () => {
  it('shows once per turn, from the send or the run event, and can be dismissed', async () => {
    seed(true);
    mocked.post.mockResolvedValueOnce({
      run_id: 'run_2',
      user_message_id: 'msg_u2',
      assistant_message_id: 'msg_a2',
      engine: 'claude_code',
      model_id: 'claude-code/default',
      context_notice: "This thread's context will be sent to Claude Code",
    });
    await sendClaudeCode({ threadId: 'thr_1', parentId: 'm2', text: 'Carry on' });
    wrap(<ContextNotice threadId="thr_1" />);
    expect(screen.getByRole('status')).toHaveTextContent("This thread's context will be sent to Claude Code");
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this notice' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    // The run's context.shared event for the same answer does not bring it back.
    act(() => showContextNotice('thr_1', "This thread's context will be sent to Claude Code", 'msg_a2'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // The next turn that shares context says it again.
    act(() => showContextNotice('thr_1', "This thread's context will be sent to Claude Code", 'msg_a3'));
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('a context.shared run event shows it too', async () => {
    const { openStream } = await import('../src/lib/sse');
    attachRun({ runId: 'run_9', threadId: 'thr_1', messageId: 'msg_a9' });
    const opts = vi.mocked(openStream).mock.calls.at(-1)?.[0] as unknown as {
      onEvent: (e: unknown) => void;
    };
    act(() =>
      opts.onEvent({
        type: 'context.shared',
        seq: 1,
        at: '2026-10-12T00:00:00Z',
        message_id: 'msg_a9',
        engine: 'claude_code',
        notice: "This thread's context will be sent to Claude Code",
        turns: 2,
        tokens: 800,
        seeded_from_summary: false,
      }),
    );
    expect(useContextNotices.getState().byThread.thr_1?.messageId).toBe('msg_a9');
  });
});

/* ---- A new Claude Code thread ------------------------------------------- */

describe('a new Claude Code thread in a folder', () => {
  it('lists the folders Claude Code knows, starts in the one chosen and opens the thread', async () => {
    mocked.get.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/claude-code/projects'
          ? { items: [{ cwd: '/home/me/app', notebook_id: 'nb_1' }] }
          : { items: [] },
      ),
    );
    mocked.post.mockResolvedValueOnce({
      thread_id: 'thr_new',
      notebook_id: 'nb_1',
      cwd: '/home/me/app',
      title: 'app',
    });
    const onClose = vi.fn();
    wrap(<NewClaudeCodeThread notebookId="nb_1" cwd={null} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('radio', { name: /app/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start in this folder' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/claude-code/threads', {
        cwd: '/home/me/app',
        notebook_id: 'nb_1',
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/t/$threadId', params: { threadId: 'thr_new' } }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('a typed folder Core refuses says why, inline, and stays open', async () => {
    const { ApiCallError, localError } = await import('../src/lib/api');
    mocked.post.mockRejectedValueOnce(
      new ApiCallError(
        422,
        localError(
          'claude_code.not_a_folder',
          'That is not a folder',
          'Type the full path to a folder.',
          't',
        ),
      ),
    );
    const onClose = vi.fn();
    wrap(<NewClaudeCodeThread notebookId={null} cwd={null} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/^Folder/), { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start in this folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That is not a folder');
    expect(onClose).not.toHaveBeenCalled();
  });
});
