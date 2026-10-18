/**
 * ------------------------------------------------------------------
 *  Title    |  Turn queue: one writer at a time
 *  Ref      |  docs/claude-code.md (One session, one place) · plan CC6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A message sent while the thread is answering, or while
 *           |  its session is open in a terminal, waits here and goes
 *           |  into the same session once it is free, so the session
 *           |  never forks because two places wrote to it at once.
 *  How      |  The queue is kept on the thread (settings.turn_queue, its
 *           |  own key: a session sync never writes over it), so it
 *           |  survives a restart. A tick every few seconds, and a nudge
 *           |  when a turn ends, sends the oldest message of each thread
 *           |  whose session is free: no run going, and no terminal
 *           |  holding it. A message is taken off the queue before it is
 *           |  sent, so a crash can never send it twice; if sending
 *           |  fails it goes back first in line with the reason, and is
 *           |  not tried again by itself.
 *  Note     |  Generic over coding CLIs: the queue only needs a sender
 *           |  and a "what is it waiting for" check from the engine.
 *           |  Only the computer that queued a message sends it, so a
 *           |  thread synced to another computer is never answered twice.
 * ------------------------------------------------------------------
 */

import { hostname } from 'node:os';
import {
  AncileError,
  type ClaudeCodeQueuedResult,
  QUEUE_LIMIT,
  type QueuedTurn,
  type SendClaudeCodeRequest,
  type SendClaudeCodeResult,
} from '@nvx/contracts';
import { logFor } from '../obs/logger';
import type { ThreadRecord, ThreadRepo } from '../threads/repo';

const log = logFor('turn-queue');

/** How often waiting threads are looked at. */
export const QUEUE_TICK_MS = 3_000;

export interface TurnQueueDeps {
  threads: Pick<ThreadRepo, 'getThread' | 'patchThread' | 'listThreads'>;
  workspaceId: string;
  /** What the thread waits for now, or null when its session is free. */
  busy(thread: ThreadRecord): Promise<QueuedTurn['waiting_for'] | null>;
  /** Start a turn now (never queues). */
  send(threadId: string, req: SendClaudeCodeRequest): Promise<SendClaudeCodeResult>;
  /** The thread changed (its queue): tell open windows. */
  changed?(threadId: string): void;
  host?: string;
  now?: () => number;
}

const queueFull = () =>
  new AncileError({
    code: 'claude_code.queue_full',
    title: `${QUEUE_LIMIT} messages are already waiting`,
    hint: 'Wait for one to go, or remove one, then send again.',
    status: 409,
    errorClass: 'permanent',
  });

const notQueued = () =>
  new AncileError({
    code: 'claude_code.queue_item_gone',
    title: 'That message is no longer waiting',
    hint: 'It was sent or removed already.',
    status: 404,
    errorClass: 'permanent',
  });

export class TurnQueue {
  private readonly waiting = new Set<string>();
  private readonly busyThreads = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  readonly host: string;
  private readonly now: () => number;

  constructor(private readonly deps: TurnQueueDeps) {
    this.host = deps.host ?? hostname();
    this.now = deps.now ?? Date.now;
  }

  /** The thread's waiting messages, oldest first. */
  static of(thread: ThreadRecord | undefined): QueuedTurn[] {
    return thread?.settings.turn_queue ?? [];
  }

  /** Find every thread with messages waiting (after a restart), then look every few seconds. */
  async start(): Promise<void> {
    for (const archived of [false, true]) {
      const threads = await this.deps.threads.listThreads(this.deps.workspaceId, { limit: 5_000, archived });
      for (const t of threads) if (TurnQueue.of(t).length) this.waiting.add(t.id);
    }
    if (this.waiting.size) log.info({ threads: this.waiting.size }, 'messages are waiting to be sent');
    this.timer = setInterval(() => void this.tick(), QUEUE_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async enqueue(
    thread: ThreadRecord,
    req: SendClaudeCodeRequest,
    waitingFor: QueuedTurn['waiting_for'],
  ): Promise<ClaudeCodeQueuedResult> {
    const fresh = (await this.deps.threads.getThread(thread.id)) ?? thread;
    const queue = TurnQueue.of(fresh);
    // The same send again (a retry of the request): the message already waiting.
    const same = queue.find((q) => q.id === `q_${req.idempotency_key}`);
    if (same) return { queued: same, position: queue.indexOf(same) + 1 };
    if (queue.length >= QUEUE_LIMIT) throw queueFull();
    const item: QueuedTurn = {
      id: `q_${req.idempotency_key}`,
      text: req.text,
      ...(req.source_ids?.length && { source_ids: req.source_ids }),
      ...(req.model !== undefined && { model: req.model }),
      ...(req.effort !== undefined && { effort: req.effort }),
      ...(req.image_ids?.length && { image_ids: req.image_ids }),
      queued_at: new Date(this.now()).toISOString(),
      waiting_for: waitingFor,
      host: this.host,
      error: null,
    };
    await this.write(thread.id, [...queue, item]);
    this.waiting.add(thread.id);
    return { queued: item, position: queue.length + 1 };
  }

  async remove(threadId: string, id: string): Promise<QueuedTurn[]> {
    const queue = TurnQueue.of(await this.deps.threads.getThread(threadId));
    if (!queue.some((q) => q.id === id)) throw notQueued();
    const next = queue.filter((q) => q.id !== id);
    await this.write(threadId, next);
    return next;
  }

  /** Send one waiting message now, as a branch of the session (so nothing open elsewhere is written to). */
  async branchNow(threadId: string, id: string): Promise<SendClaudeCodeResult> {
    const queue = TurnQueue.of(await this.deps.threads.getThread(threadId));
    const item = queue.find((q) => q.id === id);
    if (!item) throw notQueued();
    await this.write(
      threadId,
      queue.filter((q) => q.id !== id),
    );
    try {
      return await this.deps.send(threadId, { ...this.requestOf(item), as_branch: true });
    } catch (err) {
      await this.putBack(threadId, item, err);
      throw err;
    }
  }

  /** A turn ended, or a terminal closed: look at this thread soon. */
  nudge(threadId: string, afterMs = 1_000): void {
    if (!this.waiting.has(threadId)) return;
    setTimeout(() => void this.dispatch(threadId), afterMs).unref?.();
  }

  async tick(): Promise<void> {
    await Promise.all([...this.waiting].map((id) => this.dispatch(id)));
  }

  /** Send the oldest waiting message when the session is free. */
  async dispatch(threadId: string): Promise<'sent' | 'waiting' | 'idle'> {
    if (this.busyThreads.has(threadId)) return 'waiting';
    this.busyThreads.add(threadId);
    try {
      const thread = await this.deps.threads.getThread(threadId);
      const queue = TurnQueue.of(thread);
      if (!thread || !queue.length) {
        this.waiting.delete(threadId);
        return 'idle';
      }
      const next = queue[0] as QueuedTurn;
      // Another computer's message, a failed one (waits for you), or a busy session: not now.
      if (next.host !== this.host || next.error) return 'waiting';
      const reason = await this.deps.busy(thread);
      if (reason) {
        if (reason !== next.waiting_for)
          await this.write(threadId, [{ ...next, waiting_for: reason }, ...queue.slice(1)]);
        return 'waiting';
      }
      // Off the queue first: a crash after this can lose the turn's start, never send it twice.
      await this.write(threadId, queue.slice(1));
      try {
        await this.deps.send(threadId, this.requestOf(next));
        log.info(
          { thread_id: threadId, queued_ms: this.now() - Date.parse(next.queued_at) },
          'a waiting message was sent',
        );
        return 'sent';
      } catch (err) {
        await this.putBack(threadId, next, err);
        return 'waiting';
      }
    } catch (err) {
      log.warn({ thread_id: threadId, err: (err as Error).message }, 'the turn queue could not be read');
      return 'waiting';
    } finally {
      this.busyThreads.delete(threadId);
    }
  }

  private requestOf(q: QueuedTurn): SendClaudeCodeRequest {
    return {
      text: q.text,
      ...(q.source_ids?.length && { source_ids: q.source_ids }),
      ...(q.model !== undefined && { model: q.model }),
      ...(q.effort !== undefined && { effort: q.effort }),
      ...(q.image_ids?.length && { image_ids: q.image_ids }),
      idempotency_key: q.id,
    };
  }

  /** Back first in line, with why it failed; it waits for you to send, branch or remove it. */
  private async putBack(threadId: string, item: QueuedTurn, err: unknown): Promise<void> {
    const e = err instanceof AncileError ? err : null;
    // Still busy after all (a race with a terminal or another window): it just goes on waiting.
    const stillBusy = e?.code === 'claude_code.session_busy' || e?.code === 'run.already_running';
    const failed: QueuedTurn = stillBusy
      ? item
      : {
          ...item,
          error: {
            title: e?.title ?? 'The message could not be sent',
            hint: e?.hint ?? 'Send it again, send it as a branch, or remove it.',
          },
        };
    const queue = TurnQueue.of(await this.deps.threads.getThread(threadId));
    await this.write(threadId, [failed, ...queue.filter((q) => q.id !== item.id)]);
    if (!stillBusy)
      log.warn({ thread_id: threadId, code: e?.code ?? 'unknown' }, 'a waiting message failed to send');
  }

  private async write(threadId: string, queue: QueuedTurn[]): Promise<void> {
    await this.deps.threads.patchThread(threadId, { settings: { turn_queue: queue } });
    if (queue.length) this.waiting.add(threadId);
    else this.waiting.delete(threadId);
    this.deps.changed?.(threadId);
  }

  /** Send a failed message again: its error is cleared and it goes when the session is free. */
  async retry(threadId: string, id: string): Promise<QueuedTurn[]> {
    const queue = TurnQueue.of(await this.deps.threads.getThread(threadId));
    if (!queue.some((q) => q.id === id)) throw notQueued();
    const next = queue.map((q) => (q.id === id ? { ...q, error: null, host: this.host } : q));
    await this.write(threadId, next);
    this.nudge(threadId, 0);
    return next;
  }

  /** Is anything waiting in this thread? */
  has(threadId: string): boolean {
    return this.waiting.has(threadId);
  }
}
