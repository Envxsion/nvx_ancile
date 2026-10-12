/**
 * Two windows sending into one thread (track G): the per-thread send lock
 * over the real thread routes, the turns route and the Claude Code send
 * route. The second window hears thread.busy with what to do; the first
 * window's own second send still hears "already answering"; the lock comes
 * free when the turn ends, and a send that failed leaves it free at once.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeRoutes } from '../../src/claudecode/routes';
import type { ClaudeCodeLive } from '../../src/claudecode/live';
import type { ClaudeCodeService } from '../../src/claudecode/service';
import type { Engines } from '../../src/engines';
import { engineRoutes } from '../../src/engines/routes';
import { MemoryEngineStore } from '../../src/engines/store';
import { errorHandler } from '../../src/obs/errors';
import { MemoryRunStore } from '../../src/runs/store';
import { MemoryThreadRepo } from '../../src/threads/repo';
import { MemorySendLocks } from '../../src/threads/send-lock';
import { type Harness, harness } from '../support/harness';

type Err = { error: { code: string; title: string; hint: string } };

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('two windows, one thread (thread routes)', () => {
  it('lets one window in; the other hears thread.busy and what to do', async () => {
    h = await harness();
    const t = await h.newThread();
    const body = { parent_id: null, parts: [{ type: 'text', text: '/slow one two three four five' }] };
    const [a, b] = await Promise.all([
      h.call<{ run_id?: string } & Partial<Err>>('POST', `/threads/${t}/messages`, body, 'window-aaaa-1'),
      h.call<{ run_id?: string } & Partial<Err>>('POST', `/threads/${t}/messages`, body, 'window-bbbb-2'),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const lost = (a.status === 409 ? a : b).body as Err;
    expect(lost.error).toMatchObject({
      code: 'thread.busy',
      title: 'Another window is sending in this thread',
      hint: 'Wait for it to finish, or send as a branch.',
    });
    // Nothing was written for the window that lost.
    expect(await h.repo.messages(t)).toHaveLength(2);

    // While the first window's turn runs, the other window is still told it is busy...
    const won = a.status === 202 ? a : b;
    const winner = a.status === 202 ? 'window-aaaa-1' : 'window-bbbb-2';
    const loser = a.status === 202 ? 'window-bbbb-2' : 'window-aaaa-1';
    const again = await h.call<Err>('POST', `/threads/${t}/messages`, body, loser);
    expect(again.body.error.code).toBe('thread.busy');
    // ...and the first window's own second send hears what it always did.
    const own = await h.call<Err>('POST', `/threads/${t}/messages`, body, winner);
    expect(own.body.error.code).toBe('run.already_running');

    // The turn ends: the other window can send, with nothing to clean up.
    await h.call('POST', `/runs/${won.body.run_id}/cancel`, undefined, winner);
    await h.settle(won.body.run_id as string);
    const next = await h.call<{ run_id: string }>(
      'POST',
      `/threads/${t}/messages`,
      { parent_id: null, parts: [{ type: 'text', text: '/say hello' }] },
      loser,
    );
    expect(next.status).toBe(202);
    await h.settle(next.body.run_id);
  });

  it('a send that fails lets go at once', async () => {
    h = await harness();
    const t = await h.newThread();
    const bad = await h.call<Err>(
      'POST',
      `/threads/${t}/messages`,
      { parent_id: 'msg_not_there', parts: [{ type: 'text', text: 'hi' }] },
      'window-aaaa-1',
    );
    expect(bad.status).toBe(404);
    const ok = await h.call<{ run_id: string }>(
      'POST',
      `/threads/${t}/messages`,
      { parent_id: null, parts: [{ type: 'text', text: '/say hi' }] },
      'window-bbbb-2',
    );
    expect(ok.status).toBe(202);
    await h.settle(ok.body.run_id);
  });
});

describe('two windows, one thread (turns and Claude Code send)', () => {
  const setup = async () => {
    const runs = new MemoryRunStore();
    const locks = new MemorySendLocks(runs);
    const threads = new MemoryThreadRepo();
    await threads.createThread({ id: 'thr_1', workspace_id: 'wsp_1' });
    let n = 0;
    // A slow send that starts a run, as a real engine does.
    const start = async (threadId: string) => {
      await new Promise((r) => setTimeout(r, 20));
      const id = `run_${++n}`;
      await runs.create({ id, kind: 'chat_turn', traceId: '1'.repeat(32), threadId, messageId: null, checkpoint: {} });
      return { run_id: id, user_message_id: `u${n}`, assistant_message_id: `a${n}` };
    };
    const engines = {
      send: async (t: { id: string }) => ({ ...(await start(t.id)), engine: 'gateway' }),
    } as unknown as Engines;
    const live = { send: async (id: string) => start(id) } as unknown as ClaudeCodeLive;
    const app = new Hono();
    app.onError(errorHandler);
    app.route(
      '/',
      engineRoutes({
        engines: () => engines,
        threads,
        store: new MemoryEngineStore(),
        workspaceId: 'wsp_1',
        sendLocks: locks,
      }) as unknown as Hono,
    );
    app.route(
      '/',
      claudeCodeRoutes({
        service: () => ({}) as ClaudeCodeService,
        live: () => live,
        sendLocks: locks,
      }) as unknown as Hono,
    );
    const post = async (path: string, client: string, body: unknown) => {
      const res = await app.request(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-ancile-client': client },
      });
      return { status: res.status, body: (await res.json()) as Partial<Err> & { run_id?: string } };
    };
    return { runs, post };
  };

  it('covers /threads/:id/turns and /claude-code/threads/:id/send alike', async () => {
    const { runs, post } = await setup();
    const [a, b] = await Promise.all([
      post('/threads/thr_1/turns', 'window-aaaa-1', { text: 'One', idempotency_key: 'key-aaaa-0001' }),
      post('/claude-code/threads/thr_1/send', 'window-bbbb-2', { text: 'Two', idempotency_key: 'key-bbbb-0001' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect((a.status === 409 ? a : b).body.error?.code).toBe('thread.busy');

    // A window that sends without saying which it is is a sender of its own.
    const res = await post('/threads/thr_1/turns', '', { text: 'Three', idempotency_key: 'key-cccc-0001' });
    expect(res.body.error?.code).toBe('thread.busy');

    // The run ends: free again.
    const won = (a.status === 202 ? a : b).body.run_id as string;
    const rec = await runs.get(won);
    if (rec) await runs.save({ ...rec, status: 'succeeded' }, { status: 'queued' });
    const later = await post('/claude-code/threads/thr_1/send', 'window-cccc-3', {
      text: 'Four',
      idempotency_key: 'key-cccc-0002',
    });
    expect(later.status).toBe(202);
  });
});
