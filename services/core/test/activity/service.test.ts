/**
 * The Activity panel's data: runs with their progress, Claude Code sessions
 * open elsewhere, subagents and shells from transcripts (temp files), the
 * running count published as an event, typing, and the routes. Fakes only:
 * no processes are listed and nothing under ~/.claude is read.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityResponse, type GlobalEvent } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { progressOf } from '../../src/activity/progress';
import { activityRoutes } from '../../src/activity/routes';
import { type ActivityClaude, ActivityService } from '../../src/activity/service';
import type { AppEnv } from '../../src/app';
import type { CcSessionInfo } from '../../src/claudecode/bridge-protocol';
import { InflightScanner } from '../../src/claudecode/inflight';
import { MemoryEventBus } from '../../src/events/bus';
import { errorHandler } from '../../src/obs/errors';
import { MemoryRunStore } from '../../src/runs/store';

const NOW = Date.UTC(2026, 9, 12, 9, 0, 0);
let dir: string;
let now = NOW;

beforeEach(async () => {
  now = NOW;
  dir = await mkdtemp(join(tmpdir(), 'ancile-activity-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const call = (uuid: string, ms: number, id: string, name: string, input: Record<string, unknown>) =>
  line({
    type: 'assistant',
    uuid,
    timestamp: iso(ms),
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
const res = (uuid: string, ms: number, id: string, content: string) =>
  line({
    type: 'user',
    uuid,
    timestamp: iso(ms),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });

function claude(over: Partial<ActivityClaude> & { infos: CcSessionInfo[] }): ActivityClaude {
  const scanner = new InflightScanner();
  return {
    installed: () => true,
    sessions: async () => over.infos,
    bindings: async () => [
      {
        session_id: 'term',
        thread_id: 'thr_term',
        title: 'Term',
        cwd: 'C:\\Code\\app',
        last_modified: 0,
        synced_at: '',
        mapper_version: 3,
      },
    ],
    heldSessions: async () => new Map(),
    isLive: () => false,
    ownWriteAt: () => null,
    transcript: async (id) => join(dir, `${id}.jsonl`),
    scan: (p) => scanner.scan(p),
    messageFor: async (_t, uuid) => (uuid === 'e-task' ? 'msg_task' : null),
    importProgress: () => null,
    excluded: async (cwd) => !!cwd?.includes('claude-mem'),
    ...over,
  };
}

const info = (id: string, extra: Partial<CcSessionInfo> = {}): CcSessionInfo => ({
  sessionId: id,
  summary: `Session ${id}`,
  lastModified: NOW - 3_600_000,
  cwd: 'C:\\Code\\app',
  ...extra,
});

describe('runs', () => {
  it('lists unfinished runs, newest first, with their progress and thread', async () => {
    const runs = new MemoryRunStore();
    runs.now = () => NOW - 5_000;
    await runs.create({
      id: 'run_fc',
      kind: 'factcheck',
      traceId: 't',
      threadId: 'thr_1',
      messageId: 'msg_1',
      checkpoint: null,
    });
    runs.now = () => NOW - 1_000;
    await runs.create({
      id: 'run_r',
      kind: 'research',
      traceId: 't',
      threadId: 'thr_2',
      messageId: null,
      checkpoint: null,
    });
    await runs.claim('w', 10_000); // the oldest: run_fc is running
    await runs.create({
      id: 'run_done',
      kind: 'chat_turn',
      traceId: 't',
      threadId: 'thr_3',
      messageId: null,
      checkpoint: null,
    });
    const done = await runs.get('run_done');
    if (done) await runs.save({ ...done, status: 'cancelled' }, { status: 'queued' });

    const svc = new ActivityService({
      runs,
      runProgress: async () =>
        new Map([
          [
            'run_fc',
            progressOf('factcheck.progress', { stage: 'verifying', done: 3, total: 7 }) ?? { label: null },
          ],
        ]),
      threadTitle: async (id) => (id === 'thr_1' ? 'Pricing notes' : null),
      now: () => now,
    });
    const r = ActivityResponse.parse(await svc.list());
    expect(r.items.map((i) => i.id)).toEqual(['run:run_r', 'run:run_fc']);
    expect(r.items[1]).toMatchObject({
      kind: 'run',
      title: 'Fact-check',
      detail: 'Checking claims',
      state: 'running',
      run_kind: 'factcheck',
      run_status: 'running',
      progress: { done: 3, total: 7 },
      thread_id: 'thr_1',
      thread_title: 'Pricing notes',
      message_id: 'msg_1',
    });
    expect(r.items[0]).toMatchObject({ title: 'Research', detail: 'Queued', state: 'waiting' });
    expect(r.running).toBe(2);
  });

  it('reads progress from step, fact-check and flow events', () => {
    expect(progressOf('step.started', { label: 'Searching sources' })).toEqual({
      label: 'Searching sources',
    });
    expect(progressOf('flow.node.started', { label: 'Router', kind: 'router' })).toEqual({
      label: 'Flow: Router',
    });
    expect(progressOf('text.delta', {})).toBeNull();
  });
});

describe('Claude Code', () => {
  it('shows sessions a terminal holds or someone else just wrote, never ones NVX Ancile is writing', async () => {
    const svc = new ActivityService({
      runs: new MemoryRunStore(),
      threadTitle: async (id) => (id === 'thr_term' ? 'Fix the login bug' : null),
      now: () => now,
      claude: claude({
        infos: [
          info('term', { lastModified: NOW - 3_600_000 }),
          info('fresh', { lastModified: NOW - 20_000, cwd: 'C:\\Code\\site' }),
          info('ours', { lastModified: NOW - 10_000 }),
          info('live', { lastModified: NOW - 1_000 }),
          info('quiet', { lastModified: NOW - 120_000 }),
          info('mem', { lastModified: NOW - 5_000, cwd: 'C:\\Users\\p\\.claude-mem' }),
        ],
        heldSessions: async () => new Map([['term', { pid: 42, how: 'session' as const }]]),
        isLive: (id) => id === 'live',
        ownWriteAt: (id) => (id === 'ours' ? NOW - 10_500 : null),
      }),
    });
    const r = ActivityResponse.parse(await svc.list());
    const sessions = r.items.filter((i) => i.kind === 'claude_session');
    expect(sessions.map((i) => i.session_id).sort()).toEqual(['fresh', 'term']);
    expect(sessions.find((i) => i.session_id === 'term')).toMatchObject({
      title: 'Fix the login bug',
      held: 'terminal',
      detail: 'Open in a terminal',
      project: 'app',
      thread_id: 'thr_term',
    });
    expect(sessions.find((i) => i.session_id === 'fresh')).toMatchObject({
      title: 'Session fresh',
      held: 'recent',
      project: 'site',
      thread_id: null,
    });
  });

  it('lists subagents in flight and background shells, linked to their message, finished ones for a while', async () => {
    await writeFile(
      join(dir, 'term.jsonl'),
      [
        call('e-task', NOW - 60_000, 'toolu_t', 'Task', {
          description: 'Explore the parser',
          subagent_type: 'Explore',
        }),
        call('e-done', NOW - 59_000, 'toolu_d', 'Task', { description: 'Already back' }),
        res('r-done', NOW - 58_000, 'toolu_d', 'ok'),
        call('e-sh', NOW - 50_000, 'toolu_s', 'Bash', {
          command: 'pnpm dev',
          description: 'Start the dev server',
          run_in_background: true,
        }),
        res('r-sh', NOW - 49_000, 'toolu_s', 'Command running in background with ID: b1.'),
        call('e-old', NOW - 3_000_000, 'toolu_o', 'Bash', { command: 'pnpm build', run_in_background: true }),
        line({
          type: 'user',
          timestamp: iso(NOW - 2_900_000),
          message: {
            content:
              '<task-notification><tool-use-id>toolu_o</tool-use-id><status>completed</status></task-notification>',
          },
        }),
        call('e-new', NOW - 40_000, 'toolu_n', 'Bash', { command: 'pnpm test', run_in_background: true }),
        line({
          type: 'user',
          timestamp: iso(NOW - 30_000),
          message: {
            content:
              '<task-notification><tool-use-id>toolu_n</tool-use-id><status>completed</status></task-notification>',
          },
        }),
      ].join(''),
    );
    const svc = new ActivityService({
      runs: new MemoryRunStore(),
      threadTitle: async () => 'Fix the login bug',
      now: () => now,
      claude: claude({ infos: [info('term', { lastModified: NOW - 30_000 })] }),
    });
    const r = ActivityResponse.parse(await svc.list());
    const agent = r.items.find((i) => i.kind === 'subagent');
    expect(agent).toMatchObject({
      id: 'agent:term:toolu_t',
      title: 'Explore the parser',
      detail: 'Subagent: Explore',
      state: 'running',
      thread_id: 'thr_term',
      message_id: 'msg_task',
    });
    const shells = r.items.filter((i) => i.kind === 'shell');
    expect(shells.map((s) => [s.title, s.state])).toEqual([
      ['pnpm dev', 'running'],
      ['pnpm test', 'finished'],
    ]);
    // Session (written 30 s ago by someone else), subagent and the running shell; the finished shell does not count.
    expect(r.running).toBe(3);
  });

  it('says nothing about Claude Code when it is not on this computer', async () => {
    const svc = new ActivityService({
      runs: new MemoryRunStore(),
      threadTitle: async () => null,
      claude: claude({ infos: [info('x', { lastModified: NOW })], installed: () => false }),
    });
    expect((await svc.list()).items).toEqual([]);
  });
});

describe('the running count and typing', () => {
  it('publishes activity.changed only when the count moves', async () => {
    const bus = new MemoryEventBus();
    const seen: GlobalEvent[] = [];
    bus.subscribe(0, (e) => seen.push(e));
    const runs = new MemoryRunStore();
    const svc = new ActivityService({ runs, threadTitle: async () => null, bus });
    expect(await svc.publishCount()).toBe(0);
    expect(await svc.publishCount()).toBe(0);
    await runs.create({
      id: 'run_a',
      kind: 'agent',
      traceId: 't',
      threadId: null,
      messageId: null,
      checkpoint: null,
    });
    expect(await svc.publishCount()).toBe(1);
    expect(
      seen.filter((e) => e.type === 'activity.changed').map((e) => (e as { running: number }).running),
    ).toEqual([0, 1]);
  });

  it('remembers typing for a short while, capped', () => {
    const svc = new ActivityService({
      runs: new MemoryRunStore(),
      threadTitle: async () => null,
      now: () => now,
    });
    expect(svc.isTyping()).toBe(false);
    svc.typing(2_000);
    expect(svc.isTyping()).toBe(true);
    now += 2_001;
    expect(svc.isTyping()).toBe(false);
    svc.typing(999_999);
    now += 10_001;
    expect(svc.isTyping()).toBe(false);
  });

  it('answers GET /activity in its closed shape, and takes typing hints', async () => {
    const svc = new ActivityService({
      runs: new MemoryRunStore(),
      threadTitle: async () => null,
      now: () => now,
    });
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', activityRoutes({ activity: svc }));
    const got = await app.request('/activity');
    expect(got.status).toBe(200);
    expect(ActivityResponse.parse(await got.json())).toMatchObject({ items: [], running: 0, import: null });
    const typed = await app.request('/activity/typing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: 1500 }),
    });
    expect(typed.status).toBe(204);
    expect(svc.isTyping()).toBe(true);
    const bad = await app.request('/activity/typing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: 1500, pid: 4 }),
    });
    expect(bad.status).toBe(400);
  });
});
