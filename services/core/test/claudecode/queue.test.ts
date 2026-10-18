/**
 * CC6: one writer at a time. A message sent while a thread answers, or while
 * its session is open in a terminal, waits on the thread and goes into the
 * same session once it is free: taken off before it is sent (never twice),
 * put back with the reason when sending fails (never retried by itself),
 * and only ever sent by the computer that queued it.
 */
import { AncileError, QUEUE_LIMIT, type SendClaudeCodeRequest } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { TurnQueue } from '../../src/claudecode/queue';
import type { ThreadRecord } from '../../src/threads/repo';

function setup(opts: { busy?: () => 'turn' | 'terminal' | null; fail?: AncileError } = {}) {
  const thread = { id: 'thr_1', workspace_id: 'w', settings: {} } as unknown as ThreadRecord;
  const sent: SendClaudeCodeRequest[] = [];
  const queueAtSend: number[] = [];
  let busy = opts.busy ?? (() => null);
  const threads = {
    getThread: async () => thread,
    patchThread: async (_id: string, p: { settings?: Record<string, unknown> }) => {
      thread.settings = { ...thread.settings, ...(p.settings ?? {}) } as ThreadRecord['settings'];
      return thread;
    },
    listThreads: async () => [thread],
  };
  const q = new TurnQueue({
    threads: threads as never,
    workspaceId: 'w',
    host: 'this-pc',
    busy: async () => busy(),
    send: async (_id, req) => {
      queueAtSend.push(TurnQueue.of(thread).length);
      if (opts.fail) throw opts.fail;
      sent.push(req);
      return { run_id: 'run_1', user_message_id: 'm1', assistant_message_id: 'm2' };
    },
  });
  return { q, thread, sent, queueAtSend, setBusy: (b: () => 'turn' | 'terminal' | null) => (busy = b) };
}

const req = (text: string, key = `key-${text}-0000`): SendClaudeCodeRequest => ({
  text,
  idempotency_key: key,
});

describe('the turn queue', () => {
  it('waits while a terminal holds the session, then sends in order, off the queue first', async () => {
    const s = setup({ busy: () => 'terminal' });
    await s.q.enqueue(s.thread, req('one'), 'terminal');
    const second = await s.q.enqueue(s.thread, req('two'), 'turn');
    expect(second.position).toBe(2);

    expect(await s.q.dispatch('thr_1')).toBe('waiting');
    expect(s.sent).toEqual([]);

    s.setBusy(() => null);
    expect(await s.q.dispatch('thr_1')).toBe('sent');
    expect(s.sent.map((r) => r.text)).toEqual(['one']);
    // Taken off before it was sent: a crash mid-send can never send it twice.
    expect(s.queueAtSend[0]).toBe(1);
    expect(await s.q.dispatch('thr_1')).toBe('sent');
    expect(await s.q.dispatch('thr_1')).toBe('idle');
    expect(s.sent.map((r) => r.text)).toEqual(['one', 'two']);
  });

  it('puts a failed message back first with the reason, and does not try it again by itself', async () => {
    const s = setup({
      fail: new AncileError({
        code: 'claude_code.folder_missing',
        title: "The session's folder is gone",
        hint: 'Point the thread at its new folder.',
        status: 409,
        errorClass: 'permanent',
      }),
    });
    await s.q.enqueue(s.thread, req('one'), 'turn');
    expect(await s.q.dispatch('thr_1')).toBe('waiting');
    const [item] = TurnQueue.of(s.thread);
    expect(item?.error?.title).toBe("The session's folder is gone");
    expect(await s.q.dispatch('thr_1')).toBe('waiting');
    expect(s.queueAtSend).toHaveLength(1);
  });

  it('keeps waiting, without an error, when the session turned busy at the last moment', async () => {
    const s = setup({
      fail: new AncileError({
        code: 'claude_code.session_busy',
        title: 'busy',
        hint: 'wait',
        status: 409,
        errorClass: 'transient',
      }),
    });
    await s.q.enqueue(s.thread, req('one'), 'terminal');
    await s.q.dispatch('thr_1');
    expect(TurnQueue.of(s.thread)[0]?.error ?? null).toBeNull();
  });

  it("never sends another computer's message", async () => {
    const s = setup();
    await s.q.enqueue(s.thread, req('one'), 'turn');
    s.thread.settings = {
      turn_queue: TurnQueue.of(s.thread).map((x) => ({ ...x, host: 'laptop' })),
    } as ThreadRecord['settings'];
    expect(await s.q.dispatch('thr_1')).toBe('waiting');
    expect(s.sent).toEqual([]);
  });

  it('takes the same send once, and refuses more than the limit', async () => {
    const s = setup();
    const a = await s.q.enqueue(s.thread, req('one'), 'turn');
    const again = await s.q.enqueue(s.thread, req('one'), 'turn');
    expect(again.queued.id).toBe(a.queued.id);
    for (let i = 1; i < QUEUE_LIMIT; i++) await s.q.enqueue(s.thread, req(`m${i}`), 'turn');
    await expect(s.q.enqueue(s.thread, req('too many'), 'turn')).rejects.toMatchObject({
      code: 'claude_code.queue_full',
    });
  });

  it('sends one now as a branch, and removes one', async () => {
    const s = setup({ busy: () => 'terminal' });
    const a = await s.q.enqueue(s.thread, req('one'), 'terminal');
    const b = await s.q.enqueue(s.thread, req('two'), 'terminal');
    await s.q.branchNow('thr_1', a.queued.id);
    expect(s.sent[0]).toMatchObject({ text: 'one', as_branch: true });
    expect(await s.q.remove('thr_1', b.queued.id)).toEqual([]);
    await expect(s.q.remove('thr_1', b.queued.id)).rejects.toMatchObject({
      code: 'claude_code.queue_item_gone',
    });
  });

  it('finds waiting threads again after a restart', async () => {
    const s = setup({ busy: () => null });
    await s.q.enqueue(s.thread, req('one'), 'turn');
    const after = new TurnQueue({
      threads: {
        getThread: async () => s.thread,
        patchThread: async (_id: string, p: { settings?: Record<string, unknown> }) => {
          s.thread.settings = { ...s.thread.settings, ...(p.settings ?? {}) } as ThreadRecord['settings'];
          return s.thread;
        },
        listThreads: async () => [s.thread],
      } as never,
      workspaceId: 'w',
      host: 'this-pc',
      busy: async () => null,
      send: async (_id, r) => {
        s.sent.push(r);
        return { run_id: 'r', user_message_id: 'u', assistant_message_id: 'a' };
      },
    });
    await after.start();
    await after.tick();
    after.stop();
    expect(s.sent.map((r) => r.text)).toEqual(['one']);
  });
});
