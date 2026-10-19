/**
 * CH7: in a model thread, sending while an answer streams queues the message
 * (visible, one at a time, removable) and never interrupts; it goes when the
 * turn ends, stays when the turn fails or you moved to another branch; Esc
 * takes it back; Ctrl+Enter stops the answer and sends it now.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...real,
    useParams: () => ({ threadId: 't1' }),
    useNavigate: () => vi.fn(),
    useRouterState: (o?: { select?: (s: unknown) => unknown }) =>
      o?.select ? o.select({ location: { hash: '', pathname: '/t/t1' } }) : undefined,
    useSearch: () => ({}),
    Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
  };
});
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/sse', () => ({ openStream: () => () => {} }));

import { api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import { useRuns } from '../src/lib/run';
import type { ThreadView as ThreadData } from '../src/lib/types';
import { useNotify } from '../src/state/notify';
import { usePrefs } from '../src/state/prefs';
import { useUi } from '../src/state/ui';
import { Composer } from '../src/thread/Composer';
import { ModelQueue } from '../src/thread/ModelQueue';
import { queueStep, useQueue } from '../src/thread/queue';
import { ThreadView } from '../src/thread/ThreadView';

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);

const wire = (i: number, role: 'user' | 'assistant', text: string, status = 'complete') => ({
  id: `m${i}`,
  thread_id: 't1',
  parent_id: i ? `m${i - 1}` : null,
  role,
  model_id: role === 'assistant' ? 'offline/echo' : null,
  requested_model_id: null,
  status,
  edit_of_id: null,
  provenance: {},
  usage: null,
  run_id: null,
  trace_id: '0'.repeat(32),
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  parts: text ? [{ type: 'text', text }] : [],
});

/** A question and the answer being written (or ended as `status`). */
const path = (status: string, last = 3) => {
  const messages = [
    wire(0, 'user', 'First question'),
    wire(1, 'assistant', 'First answer'),
    wire(2, 'user', 'And now?'),
  ];
  for (let i = 3; i <= last; i++)
    messages.push(
      wire(i, i % 2 ? 'assistant' : 'user', i === last ? '' : 'x', i === last ? status : 'complete'),
    );
  return {
    thread: {
      id: 't1',
      title: 'T',
      notebook_id: null,
      active_head_id: null,
      settings: {},
      pinned_at: null,
      archived_at: null,
      created_at: '',
      updated_at: '',
    },
    head_id: messages.at(-1)?.id ?? null,
    messages,
    active_run: null,
    total: messages.length,
    start: 0,
    has_more: false,
  };
};

function mount(status = 'streaming') {
  const p = path(status);
  get.mockImplementation(async (url: string) =>
    url.startsWith('/threads/t1/path') ? p : { items: [], next_cursor: null },
  );
  post.mockImplementation(async (url: string) =>
    url.endsWith('/turns')
      ? {
          run_id: 'r2',
          user_message_id: 'm90',
          assistant_message_id: 'm91',
          engine: 'gateway',
          model_id: null,
          context_notice: null,
        }
      : {},
  );
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <ThreadView threadId="t1" />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

/** The thread as Core has it once the answer ended as `status`, on this branch or another. */
function endTurn(status: string, last = 3) {
  const p = path(status, last);
  act(() => {
    queryClient.setQueryData<ThreadData>(keys.thread('t1'), (t) =>
      t
        ? {
            ...t,
            headId: p.head_id,
            messages: t.messages.slice(0, 3).concat(
              p.messages.slice(3).map(
                (m) =>
                  ({
                    ...(t.messages.at(-1) as object),
                    id: m.id,
                    parentId: m.parent_id,
                    role: m.role,
                    status: m.status as 'complete',
                  }) as ThreadData['messages'][number],
              ),
            ),
          }
        : t,
    );
  });
}

const input = () => screen.getByLabelText('Message') as HTMLTextAreaElement;
const say = (text: string) => fireEvent.change(input(), { target: { value: text } });
const enter = (init: Record<string, unknown> = {}) => fireEvent.keyDown(input(), { key: 'Enter', ...init });
const sentTurns = () => post.mock.calls.filter(([u]) => String(u).endsWith('/turns'));
const stops = () => post.mock.calls.filter(([u]) => String(u).endsWith('/stop'));
const lastToast = () => useNotify.getState().toasts.at(-1);

beforeEach(() => {
  useUi.setState({ demo: false });
  useNotify.setState({ toasts: [], history: [] });
  useQueue.setState({ byThread: {} });
  usePrefs.getState().set('composer', { send: 'enter', menus: true });
  get.mockReset();
  post.mockReset();
  for (const f of [api.put, api.patch, api.del]) vi.mocked(f).mockResolvedValue({});
});
afterEach(() => {
  queryClient.clear();
  useRuns.setState({ turns: {} });
});

describe('writing ahead while an answer streams', () => {
  it('queues the message above the composer, in order, without stopping the answer', async () => {
    mount();
    await screen.findByRole('list', { name: 'Conversation' });
    say('A follow-up');
    enter();
    const when = await screen.findByText('Sends when this turn ends');
    expect(when.closest('.cc-queued')).toHaveTextContent('Queued A follow-up');
    expect(input().value).toBe('');
    expect(sentTurns()).toHaveLength(0);
    expect(stops()).toHaveLength(0);
  });

  it('keeps one message in the queue and says so when a second is sent', async () => {
    mount();
    await screen.findByRole('list', { name: 'Conversation' });
    say('first');
    enter();
    await screen.findByText('first');
    say('second');
    expect(screen.getByRole('button', { name: 'A message is already queued' })).toBeDisabled();
    enter();
    expect(lastToast()?.title).toBe('A message is already queued');
    expect(input().value).toBe('second');
  });

  it('sends it as a reply to the answer when the turn ends, and the line goes', async () => {
    mount();
    await screen.findByRole('list', { name: 'Conversation' });
    say('A follow-up');
    enter();
    await screen.findByText('A follow-up');
    endTurn('complete');
    await waitFor(() => expect(sentTurns()).toHaveLength(1));
    expect(sentTurns()[0]?.[1]).toMatchObject({ text: 'A follow-up', parent_id: 'm3' });
    await waitFor(() => expect(screen.queryByText('Sends when this turn ends')).toBeNull());
  });

  it('Esc takes the queued message back into the composer', async () => {
    mount();
    await screen.findByRole('list', { name: 'Conversation' });
    say('A follow-up');
    enter();
    await screen.findByText('A follow-up');
    fireEvent.keyDown(input(), { key: 'Escape' });
    await waitFor(() => expect(input().value).toBe('A follow-up'));
    expect(screen.queryByText('Sends when this turn ends')).toBeNull();
    endTurn('complete');
    await act(async () => {});
    expect(sentTurns()).toHaveLength(0);
  });

  it('the remove button does the same, and joins what was written meanwhile', async () => {
    mount();
    await screen.findByRole('list', { name: 'Conversation' });
    say('queued words');
    enter();
    await screen.findByText('queued words');
    say('new draft');
    fireEvent.click(screen.getByRole('button', { name: 'Remove the queued message' }));
    await waitFor(() => expect(input().value).toBe('new draft\n\nqueued words'));
  });

  it('Ctrl+Enter stops the answer and sends the message now', async () => {
    mount();
    await screen.findByRole('list', { name: 'Conversation' });
    say('Stop and answer this');
    enter({ ctrlKey: true });
    await waitFor(() => expect(stops()).toHaveLength(1));
    expect(stops()[0]?.[0]).toBe('/messages/m3/stop');
    // The answer ends as stopped; the same queue sends it.
    endTurn('stopped');
    await waitFor(() => expect(sentTurns()).toHaveLength(1));
    expect(sentTurns()[0]?.[1]).toMatchObject({ text: 'Stop and answer this', parent_id: 'm3' });
  });

  it('with Ctrl+Enter as the send key, Ctrl+Shift+Enter stops and sends and Ctrl+Enter queues', async () => {
    usePrefs.getState().set('composer', { send: 'mod-enter' });
    mount();
    await screen.findByRole('list', { name: 'Conversation' });
    say('queue me');
    enter({ ctrlKey: true });
    await screen.findByText('queue me');
    expect(stops()).toHaveLength(0);
    fireEvent.keyDown(input(), { key: 'Escape' });
    await waitFor(() => expect(input().value).toBe('queue me'));
    enter({ ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(stops()).toHaveLength(1));
  });
});

describe('when the turn does not end well', () => {
  it('keeps the message after an error and says so, until you send it or remove it', async () => {
    mount();
    await screen.findByRole('list', { name: 'Conversation' });
    say('A follow-up');
    enter();
    await screen.findByText('A follow-up');
    endTurn('error');
    await screen.findByText('The answer stopped with an error. Your message is still here.');
    expect(sentTurns()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(sentTurns()).toHaveLength(1));
  });

  it('keeps it when you moved to another branch, and sends it here only when told', async () => {
    mount();
    await screen.findByRole('list', { name: 'Conversation' });
    say('A follow-up');
    enter();
    await screen.findByText('A follow-up');
    endTurn('complete', 5);
    await screen.findByText('You moved to another branch. Your message is still here.');
    expect(sentTurns()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Send here' }));
    await waitFor(() => expect(sentTurns()).toHaveLength(1));
    expect(sentTurns()[0]?.[1]).toMatchObject({ parent_id: 'm5' });
  });
});

describe('the decision', () => {
  const q = (state: 'waiting' | 'held' = 'waiting', after: string | null = 'a1') => ({ state, after });
  const at = (p: Partial<Parameters<typeof queueStep>[1]> = {}) => ({
    busy: false,
    lastId: 'a1',
    lastStatus: 'complete',
    ...p,
  });

  it('waits while the answer is written, sends when it ends, holds on an error or another branch', () => {
    expect(queueStep(q(), at({ busy: true }))).toBe('wait');
    expect(queueStep(q(), at({ lastStatus: 'streaming' }))).toBe('wait');
    expect(queueStep(q(), at())).toBe('send');
    expect(queueStep(q(), at({ lastStatus: 'stopped' }))).toBe('send');
    expect(queueStep(q(), at({ lastStatus: 'error' }))).toBe('hold-error');
    expect(queueStep(q(), at({ lastId: 'other' }))).toBe('hold-branch');
    expect(queueStep(q('waiting', 'pending-run_1'), at({ lastId: 'real' }))).toBe('send');
  });

  it('never acts on a message that is held or absent', () => {
    expect(queueStep(q('held'), at())).toBe('wait');
    expect(queueStep(undefined, at())).toBe('wait');
  });
});

describe('the composer', () => {
  const draw = (props: Record<string, unknown>) => {
    get.mockResolvedValue([]);
    render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <Composer threadId="thr_1" parentId="m1" onSend={vi.fn().mockResolvedValue(true)} {...props} />
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
    return screen.getByLabelText('Message');
  };

  it('offers to queue while an answer streams, and Esc only takes back what is queued', () => {
    const remove = vi.fn();
    const box = draw({ busy: true, queue: { queued: false, remove } });
    expect(screen.getByRole('button', { name: 'Queue for after this answer' })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('takes the queued message back on Esc, and Esc does not leave the composer', () => {
    const remove = vi.fn();
    const box = draw({ busy: true, queue: { queued: true, remove } });
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(box);
  });

  it('with no queue, a busy thread still says to wait', () => {
    draw({ busy: true });
    expect(screen.getByRole('button', { name: 'Wait for the answer to finish' })).toBeDisabled();
  });
});

describe('the queued line', () => {
  it('names what it waits for and offers to stop and send now only while an answer runs', () => {
    useQueue.setState({
      byThread: {
        t1: {
          text: 'Later',
          extras: { mentions: [], model: null, flowId: null },
          after: 'a1',
          state: 'waiting',
        },
      },
    });
    const { rerender } = render(<ModelQueue threadId="t1" busy onSendNow={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Queued Later');
    expect(screen.getByRole('button', { name: 'Stop and send now' })).toBeInTheDocument();
    rerender(<ModelQueue threadId="t1" busy={false} onSendNow={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Stop and send now' })).toBeNull();
  });
});
