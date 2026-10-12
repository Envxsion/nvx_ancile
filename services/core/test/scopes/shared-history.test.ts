/**
 * Track G: a notebook made private (or a notebook or thread made local only)
 * after content went to cloud models. What had already left the machine is
 * recorded at the change and shown with the scope: engines and providers
 * (a closed set, never content or model ids), how many answers, and the
 * date range. Local answers are not counted.
 */

import type { StoredScope } from '@nvx/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/obs/errors';
import { MemoryScopeStore } from '../../src/scopes';
import {
  classifier,
  MemorySharedHistoryStore,
  PgSharedHistoryStore,
  SharedHistory,
  summarise,
} from '../../src/scopes/history';
import { scopeRoutes } from '../../src/scopes/routes';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { eachBackend, uid } from '../support/stores';

const classify = classifier((id) =>
  id === 'my-box/llama'
    ? { provider: 'openai', local: true }
    : id === 'gpt'
      ? { provider: 'openai', local: false }
      : undefined,
);

describe('classifying where an answer was made', () => {
  it('maps providers to a closed set and leaves local models out', () => {
    expect(classify('anthropic/claude-sonnet-4', false)).toBe('anthropic');
    expect(classify('claude-code/opus', false)).toBe('claude_code');
    expect(classify(null, true)).toBe('claude_code');
    expect(classify('gpt', false)).toBe('openai');
    expect(classify('ollama/llama3', false)).toBeNull();
    expect(classify('fake/echo', false)).toBeNull();
    expect(classify('my-box/llama', false)).toBeNull();
    expect(classify('somecloud/model', false)).toBe('other_cloud');
    expect(classify(null, false)).toBeNull();
  });

  it('sums turns per destination and keeps the date range', () => {
    const s = summarise(
      [
        {
          model_id: 'openai/gpt-5',
          claude_code: false,
          turns: 3,
          first_at: '2026-10-02T00:00:00.000Z',
          last_at: '2026-10-05T00:00:00.000Z',
        },
        {
          model_id: 'openai/gpt-4o',
          claude_code: false,
          turns: 1,
          first_at: '2026-10-01T00:00:00.000Z',
          last_at: '2026-10-01T00:00:00.000Z',
        },
        {
          model_id: 'claude-code/opus',
          claude_code: true,
          turns: 2,
          first_at: '2026-10-06T00:00:00.000Z',
          last_at: '2026-10-07T00:00:00.000Z',
        },
        {
          model_id: 'ollama/llama3',
          claude_code: false,
          turns: 9,
          first_at: '2026-09-01T00:00:00.000Z',
          last_at: '2026-10-11T00:00:00.000Z',
        },
      ],
      classify,
      { level: 'notebook', refId: 'nb1', change: 'private', at: '2026-10-12T00:00:00.000Z' },
    );
    expect(s).toMatchObject({
      turns: 6,
      first_at: '2026-10-01T00:00:00.000Z',
      last_at: '2026-10-07T00:00:00.000Z',
      destinations: [
        { destination: 'openai', turns: 4 },
        { destination: 'claude_code', turns: 2 },
      ],
    });
    expect(JSON.stringify(s)).not.toContain('gpt-5');
  });
});

describe('scope routes record what had left the machine', () => {
  let store: MemoryScopeStore;
  let hist: MemorySharedHistoryStore;
  let app: Hono;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    });
    return { status: res.status, body: (await res.json()) as StoredScope };
  };

  beforeEach(() => {
    store = new MemoryScopeStore();
    store.notebooks.add('nb1');
    store.threads.set('th1', 'nb1');
    store.threads.set('th2', 'nb1');
    hist = new MemorySharedHistoryStore();
    const answer = (thread: string, model: string | null, at: string, cc = false) =>
      hist.answersList.push({
        thread_id: thread,
        notebook_id: 'nb1',
        model_id: model,
        claude_code: cc,
        created_at: at,
      });
    answer('th1', 'anthropic/claude-sonnet-4', '2026-10-01T09:00:00.000Z');
    answer('th1', 'anthropic/claude-sonnet-4', '2026-10-03T09:00:00.000Z');
    answer('th2', 'claude-code/opus', '2026-10-04T09:00:00.000Z', true);
    answer('th2', 'ollama/llama3', '2026-10-09T09:00:00.000Z');
    app = new Hono();
    app.onError(errorHandler);
    app.route(
      '/',
      scopeRoutes({
        store,
        history: new SharedHistory({ store: hist, classify, now: () => new Date('2026-10-12T08:00:00Z') }),
      }) as unknown as Hono,
    );
  });

  it('when a notebook becomes private: engines, turns and dates, shown with the scope', async () => {
    const r = await call('PATCH', '/notebooks/nb1/scope', { private: true });
    expect(r.status).toBe(200);
    expect(r.body.shared_before_local).toEqual([
      expect.objectContaining({
        level: 'notebook',
        ref_id: 'nb1',
        change: 'private',
        changed_at: '2026-10-12T08:00:00.000Z',
        turns: 3,
        first_at: '2026-10-01T09:00:00.000Z',
        last_at: '2026-10-04T09:00:00.000Z',
        destinations: [
          { destination: 'anthropic', turns: 2 },
          { destination: 'claude_code', turns: 1 },
        ],
      }),
    ]);
    // A thread in it shows its notebook's record too.
    expect((await call('GET', '/threads/th1/scope')).body.shared_before_local).toHaveLength(1);
    // Already private: nothing new is recorded.
    await call('PATCH', '/notebooks/nb1/scope', { private: true, network: false });
    expect(hist.records).toHaveLength(1);
  });

  it('when data leaving the machine is switched off, for a notebook or one thread', async () => {
    await call('PATCH', '/threads/th1/scope', { data_leaves_machine: false });
    expect(hist.records).toEqual([
      expect.objectContaining({ level: 'thread', ref_id: 'th1', change: 'local_only', turns: 2 }),
    ]);
    // Narrowing something else records nothing.
    await call('PATCH', '/threads/th2/scope', { network: false });
    expect(hist.records).toHaveLength(1);
    const nb = await call('PATCH', '/notebooks/nb1/scope', { data_leaves_machine: false });
    expect(nb.body.shared_before_local?.[0]).toMatchObject({ change: 'local_only', turns: 3 });
  });
});

eachBackend('shared history store', (backend) => {
  let repo: ThreadRepo;
  let store: MemorySharedHistoryStore | PgSharedHistoryStore;
  let ws: string;
  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    if (b.sql) {
      repo = new PgThreadRepo(b.sql);
      store = new PgSharedHistoryStore(b.sql);
    } else {
      repo = new MemoryThreadRepo();
      store = new MemorySharedHistoryStore();
    }
  });

  it('groups a thread’s answers by model and engine, and keeps records newest first', async () => {
    const thread = uid('thr');
    await repo.createThread({ id: thread, workspace_id: ws });
    const msgs = [
      { model: 'openai/gpt-5', at: '2026-10-01T10:00:00.000Z' },
      { model: 'openai/gpt-5', at: '2026-10-02T10:00:00.000Z' },
      { model: 'claude-code/opus', at: '2026-10-03T10:00:00.000Z', cc: true },
    ];
    await repo.insertMessages(
      msgs.map((m) => ({
        id: uid('msg'),
        thread_id: thread,
        parent_id: null,
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'secret content' }],
        status: 'complete' as const,
        model_id: m.model,
        trace_id: 't',
        created_at: m.at,
        ...(m.cc && { provenance: { claude_code: { session_id: 's' } } }),
      })),
    );
    if (store instanceof MemorySharedHistoryStore)
      for (const m of msgs)
        store.answersList.push({
          thread_id: thread,
          notebook_id: null,
          model_id: m.model,
          claude_code: !!m.cc,
          created_at: m.at,
        });
    const groups = (await store.answers('thread', thread)).sort((a, b) =>
      (a.model_id ?? '').localeCompare(b.model_id ?? ''),
    );
    expect(groups).toEqual([
      {
        model_id: 'claude-code/opus',
        claude_code: true,
        turns: 1,
        first_at: '2026-10-03T10:00:00.000Z',
        last_at: '2026-10-03T10:00:00.000Z',
      },
      {
        model_id: 'openai/gpt-5',
        claude_code: false,
        turns: 2,
        first_at: '2026-10-01T10:00:00.000Z',
        last_at: '2026-10-02T10:00:00.000Z',
      },
    ]);
    const h = new SharedHistory({ store, classify });
    const first = await h.record('thread', thread, 'local_only');
    const second = await h.record('thread', thread, 'local_only');
    const listed = await h.list([{ level: 'thread', refId: thread }]);
    expect(listed.map((r) => r.id)).toEqual([second.id, first.id].sort().reverse());
    expect(listed[0]).toMatchObject({
      turns: 3,
      destinations: [
        { destination: 'openai', turns: 2 },
        { destination: 'claude_code', turns: 1 },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain('secret content');
  });
});
