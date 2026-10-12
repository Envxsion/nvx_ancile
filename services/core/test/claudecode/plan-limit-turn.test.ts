/**
 * Claude Code's plan limit reached mid-turn (track G): the turn stops
 * cleanly, keeps what streamed, and says when the limit resets, from the
 * rate_limit_event, from Claude Code's own "limit reached|<epoch>" words,
 * or from the plan figures NVX Ancile already holds. Any other failure
 * stays "stopped before it answered".
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunEvent } from '@nvx/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveBridge, LiveEvent, LiveOpenParams } from '../../src/claudecode/bridge-protocol';
import { limitFromResult, planLimitTitle } from '../../src/claudecode/errors';
import { ClaudeCodeLive, type LiveServiceView } from '../../src/claudecode/live';
import { PlanLimits } from '../../src/claudecode/plan-limits';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import type { RunContext, RunOutcome } from '../../src/runs/engine';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { MemorySettings } from '../../src/settings';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_01TESTWORKSPACE000000000000';
const S = 'sess-limit-0001';
const CWD = join(tmpdir(), 'ancile-cc-limit', 'app');
/** 14:00 today, local time, a little after "now". */
const NOW = new Date(2026, 9, 12, 13, 20, 0).getTime();
const RESET = new Date(2026, 9, 12, 14, 0, 0).getTime();

type Script = (b: Bridge, handle: string) => void;

class Bridge implements LiveBridge {
  opened: LiveOpenParams[] = [];
  script: Script = () => undefined;
  private fns = new Set<(e: LiveEvent) => void>();
  async open(p: LiveOpenParams) {
    this.opened.push(p);
    return { handle: 'h1' };
  }
  async send(handle: string) {
    setTimeout(() => this.script(this, handle), 0);
  }
  async interrupt() {}
  /** This Claude Code does not report plan usage (the event figures stand). */
  async control<T>(): Promise<T> {
    throw new Error('no usage report');
  }
  async close() {}
  async reply() {}
  onEvent(fn: (e: LiveEvent) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  setKeepAlive() {}
  msg(handle: string, message: Record<string, unknown>) {
    for (const f of this.fns) f({ event: 'session.message', data: { handle, message } });
  }
}

/** Half an answer, then (optionally) the rejected rate_limit_event, then Claude Code's error result. */
const stopsAtLimit =
  (o: { event?: boolean; words?: string }): Script =>
  (b, h) => {
    b.msg(h, { type: 'system', subtype: 'init', session_id: S });
    b.msg(h, {
      type: 'assistant',
      uuid: 'a2',
      session_id: S,
      parent_tool_use_id: null,
      message: { id: 'api-a2', content: [{ type: 'text', text: 'Half of the refactor is done' }] },
    });
    if (o.event)
      b.msg(h, {
        type: 'rate_limit_event',
        session_id: S,
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: RESET / 1000, utilization: 1 },
      });
    b.msg(h, {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: o.words ?? 'Claude AI usage limit reached',
      session_id: S,
    });
  };

let threads: MemoryThreadRepo;
let runs: MemoryRunStore;
let events: MemoryRunEventLog;
let bridge: Bridge;
let live: ClaudeCodeLive;
let settings: MemorySettings;

const service: LiveServiceView = {
  cliPath: async () => ({ path: 'claude', version: '2.1.300' }),
  cliEnv: async () => ({}),
  syncSession: async () => ({ thread_id: 'thr_1', added: 0, notebook_id: null }),
  transcriptModified: async () => null,
  setLiveGuard: () => undefined,
};

async function execute(runId: string): Promise<RunOutcome> {
  const run = (await runs.get(runId)) as NonNullable<Awaited<ReturnType<typeof runs.get>>>;
  const ctx: RunContext = {
    run,
    events,
    signal: new AbortController().signal,
    checkpoint: async () => undefined,
    once: async (s, kind, input, effect) => {
      const out = await effect();
      await runs.putStep({ runId, seq: s, kind, idempotencyKey: `${runId}:${s}`, status: 'succeeded', input, output: out });
      return out;
    },
  };
  return live.handler().execute(ctx);
}

beforeEach(async () => {
  threads = new MemoryThreadRepo();
  runs = new MemoryRunStore();
  events = new MemoryRunEventLog();
  bridge = new Bridge();
  settings = new MemorySettings();
  const perms = new MemoryPermissionStore();
  const limits = new PlanLimits({
    settings,
    bridge,
    cli: async () => ({ path: 'claude' }),
    env: async () => ({}),
    openHandle: () => null,
    now: () => NOW,
  });
  live = new ClaudeCodeLive({
    workspaceId: WS,
    userId: 'usr_1',
    bridge,
    service,
    sessionInfo: async () => null,
    threads,
    store: new MemoryClaudeCodeStore(threads),
    runs,
    events,
    worker: { kick: () => undefined },
    permissions: perms,
    gateFor: (root) => createGate({ policy: new BuiltinPolicy(), store: perms, workspaceRoot: root }),
    notebook: async () => null,
    folderExists: async () => true,
    now: () => NOW,
    limits,
  });
  await threads.createThread({
    id: 'thr_1',
    workspace_id: WS,
    title: 'Refactor',
    settings: { claude_code: { session_id: S, cwd: CWD, last_uuid: 'a1', synced_at: '' } },
  });
  await threads.insertMessages([
    {
      id: 'msg_u1',
      thread_id: 'thr_1',
      parent_id: null,
      role: 'user',
      parts: [{ type: 'text', text: 'Refactor auth' }],
      status: 'complete',
      trace_id: 't',
      provenance: { claude_code: { session_id: S, uuid: 'u1', uuids: ['u1'] } },
    },
    {
      id: 'msg_a1',
      thread_id: 'thr_1',
      parent_id: 'msg_u1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Starting.' }],
      status: 'complete',
      trace_id: 't',
      provenance: { claude_code: { session_id: S, uuid: 'a1', uuids: ['a1'] } },
    },
  ]);
  await threads.patchThread('thr_1', { active_head_id: 'msg_a1', root_message_id: 'msg_u1' });
});
afterEach(() => live.stop());

const errorOf = async (runId: string) =>
  (await events.since(runId, 0)).find((e): e is Extract<RunEvent, { type: 'error' }> => e.type === 'error');

describe('the plan limit reached mid-turn', () => {
  it('stops cleanly, keeps what streamed, and says when it resets (from the rate_limit_event)', async () => {
    bridge.script = stopsAtLimit({ event: true });
    const sent = await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-limit-0001' });
    const out = await execute(sent.run_id);
    expect(out).toMatchObject({
      kind: 'failed',
      error: { code: 'claude_code.plan_limit', title: 'Claude Code limit reached, resets at 14:00' },
    });
    const e = await errorOf(sent.run_id);
    expect(e).toMatchObject({
      code: 'claude_code.plan_limit',
      title: 'Claude Code limit reached, resets at 14:00',
      resets_at: new Date(RESET).toISOString(),
    });
    expect(e?.hint).toContain('Finish on another model');
    const answer = await threads.getMessage(sent.assistant_message_id);
    expect(answer?.status).toBe('error');
    expect(answer?.parts).toEqual([{ type: 'text', text: 'Half of the refactor is done' }]);
    expect((answer?.provenance as { error?: unknown }).error).toMatchObject({
      code: 'claude_code.plan_limit',
      resets_at: new Date(RESET).toISOString(),
    });
    // The plan figures saw the event too (it is saved alongside the turn's end).
    const limits = (live as unknown as { deps: { limits: PlanLimits } }).deps.limits;
    for (let i = 0; i < 100 && !(await limits.blockedUntil()); i++) await new Promise((r) => setTimeout(r, 5));
    expect(await limits.blockedUntil()).toBe(new Date(RESET).toISOString());
  });

  it("reads the reset from Claude Code's own words when no event came", async () => {
    bridge.script = stopsAtLimit({ words: `Claude AI usage limit reached|${Math.floor(RESET / 1000)}` });
    const sent = await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-limit-0002' });
    await execute(sent.run_id);
    expect(await errorOf(sent.run_id)).toMatchObject({
      code: 'claude_code.plan_limit',
      resets_at: new Date(RESET).toISOString(),
    });
  });

  it('falls back to the plan figures NVX Ancile holds, then to no time at all', async () => {
    await settings.set('claude_code.plan_limits', {
      available: true,
      plan: 'max',
      windows: [
        {
          id: 'five_hour',
          kind: 'session',
          label: null,
          percent: 100,
          resets_at: new Date(RESET).toISOString(),
          status: 'rejected',
          updated_at: new Date(NOW).toISOString(),
        },
      ],
      updated_at: new Date(NOW).toISOString(),
      source: 'event',
    });
    bridge.script = stopsAtLimit({ words: "You've hit your limit" });
    const sent = await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-limit-0003' });
    await execute(sent.run_id);
    expect((await errorOf(sent.run_id))?.title).toBe('Claude Code limit reached, resets at 14:00');
  });

  it('any other failure is still "stopped before it answered"', async () => {
    bridge.script = (b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      b.msg(h, { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: S });
    };
    const sent = await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-limit-0004' });
    await execute(sent.run_id);
    const e = await errorOf(sent.run_id);
    expect(e?.code).toBe('claude_code.live_failed');
    expect(e?.resets_at).toBeUndefined();
  });
});

describe('words for the limit', () => {
  it('names the reset in local time, the day when it is not today, and nothing when unknown', () => {
    expect(planLimitTitle(new Date(RESET).toISOString(), NOW)).toBe('Claude Code limit reached, resets at 14:00');
    const monday = new Date(2026, 9, 19, 9, 5, 0);
    expect(planLimitTitle(monday.toISOString(), NOW)).toBe('Claude Code limit reached, resets Mon 09:05');
    expect(planLimitTitle(null, NOW)).toBe('Claude Code limit reached');
    expect(planLimitTitle('not a date', NOW)).toBe('Claude Code limit reached');
  });

  it('only a failed result that says so is a limit', () => {
    expect(limitFromResult({ is_error: true, result: 'Claude AI usage limit reached|1760277600' })).toEqual({
      resetsAt: new Date(1760277600 * 1000).toISOString(),
    });
    expect(limitFromResult({ is_error: true, result: '5-hour limit reached ∙ resets 2pm' })).toEqual({
      resetsAt: null,
    });
    expect(limitFromResult({ is_error: false, result: 'The rate limit middleware is done' })).toBeNull();
    expect(limitFromResult({ is_error: true, result: 'Something else broke' })).toBeNull();
    expect(limitFromResult(null)).toBeNull();
  });
});
