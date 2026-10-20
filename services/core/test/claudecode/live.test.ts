/**
 * Live Claude Code turns against a fake bridge: scripted SDK messages and
 * permission asks, memory stores, the real gate (built-in policy). No
 * Claude Code, no Agent SDK, no network.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AncileError,
  type ClaudeCodeBinding,
  type RunEvent,
  type SearchHit,
  SendClaudeCodeRequest,
  SendTurnRequest,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import type {
  CcSessionInfo,
  LiveBridge,
  LiveControlOp,
  LiveEvent,
  LiveOpenParams,
  LivePermissionReply,
} from '../../src/claudecode/bridge-protocol';
import {
  type ClaudeCodeCheckpoint,
  ClaudeCodeLive,
  dedupeCommands,
  isPendingSession,
  type LiveServiceView,
} from '../../src/claudecode/live';
import { MAPPER_VERSION, planSync } from '../../src/claudecode/map';
import { CLAUDE_CODE_PRINCIPAL } from '../../src/claudecode/permission-map';
import { claudeCodeRoutes } from '../../src/claudecode/routes';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
import { ClaudeCodeEngine } from '../../src/engines';
import { claudeHooks } from '../../src/engines/claude';
import { errorHandler } from '../../src/obs/errors';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { permissionRoutes } from '../../src/permissions/routes';
import { type ApprovalRecord, MemoryPermissionStore } from '../../src/permissions/store';
import type { RunContext, RunOutcome, RunRecord } from '../../src/runs/engine';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { resolveScope } from '../../src/scopes';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_01TESTWORKSPACE000000000000';
const USER = 'usr_1';
const CWD = join(tmpdir(), 'ancile-cc-live', 'app');
const S = 'sess-original-0001';
const F = 'sess-fork-0002';

type Script = (b: FakeBridge, handle: string, text: string, uuid: string | undefined) => Promise<void> | void;

class FakeBridge implements LiveBridge {
  opened: LiveOpenParams[] = [];
  closed: string[] = [];
  sent: { handle: string; text: string; uuid?: string }[] = [];
  replies: { handle: string; request_id: string; r: LivePermissionReply }[] = [];
  controls: { handle: string; op: LiveControlOp; args?: Record<string, unknown> }[] = [];
  interrupted: string[] = [];
  script: Script = () => undefined;
  controlAnswers: Partial<Record<LiveControlOp, unknown>> = {};
  private listeners = new Set<(e: LiveEvent) => void>();
  private n = 0;
  keepAlive: () => boolean = () => false;

  async open(p: LiveOpenParams) {
    this.opened.push(p);
    return { handle: `h${++this.n}` };
  }
  async send(handle: string, text: string, opts: { uuid?: string } = {}) {
    this.sent.push({ handle, text, ...(opts.uuid && { uuid: opts.uuid }) });
    setTimeout(() => void this.script(this, handle, text, opts.uuid), 0);
  }
  async interrupt(handle: string) {
    this.interrupted.push(handle);
    this.push({
      event: 'session.message',
      data: { handle, message: { type: 'result', subtype: 'error_during_execution', is_error: true } },
    });
  }
  async control<T>(handle: string, op: LiveControlOp, args?: Record<string, unknown>) {
    this.controls.push({ handle, op, ...(args && { args }) });
    return (this.controlAnswers[op] ?? { ok: true }) as T;
  }
  async close(handle: string) {
    this.closed.push(handle);
  }
  async reply(handle: string, requestId: string, r: LivePermissionReply) {
    this.replies.push({ handle, request_id: requestId, r });
  }
  onEvent(fn: (e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  setKeepAlive(fn: () => boolean) {
    this.keepAlive = fn;
  }
  push(e: LiveEvent) {
    for (const fn of this.listeners) fn(e);
  }
  msg(handle: string, message: Record<string, unknown>) {
    this.push({ event: 'session.message', data: { handle, message } });
  }
  ask(handle: string, id: string, tool: string, input: unknown, toolUseId: string) {
    this.push({
      event: 'session.permission',
      data: { handle, request_id: id, tool_name: tool, input, tool_use_id: toolUseId, via: 'hook' },
    });
  }
}

const textAnswer =
  (sessionId: string, uuid: string, text: string, cost = 0.02): Script =>
  (b, h) => {
    b.msg(h, {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: 'claude-opus-5-5',
      permissionMode: 'default',
    });
    b.msg(h, {
      type: 'stream_event',
      parent_tool_use_id: null,
      session_id: sessionId,
      event: { type: 'message_start', message: { id: `api-${uuid}`, model: 'claude-opus-5-5' } },
    });
    b.msg(h, {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    const half = Math.ceil(text.length / 2);
    for (const piece of [text.slice(0, half), text.slice(half)])
      b.msg(h, {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
      });
    b.msg(h, {
      type: 'assistant',
      uuid,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: `api-${uuid}`,
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100 },
      },
    });
    b.msg(h, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: cost,
      session_id: sessionId,
    });
  };

let threads: MemoryThreadRepo;
let store: MemoryClaudeCodeStore;
let runs: MemoryRunStore;
let events: MemoryRunEventLog;
let perms: MemoryPermissionStore;
let bridge: FakeBridge;
let live: ClaudeCodeLive;
let synced: string[];
let modified: number | null;
let now: number;
const NOW = Date.UTC(2026, 9, 11, 9, 0, 0);

const service: LiveServiceView = {
  cliPath: async () => ({ path: 'C:\\claude.exe', version: '2.1.286' }),
  cliEnv: async () => ({ DISABLE_TELEMETRY: '1' }),
  syncSession: async (info) => {
    synced.push(info.sessionId);
    return { thread_id: 'x', added: 0, notebook_id: null };
  },
  transcriptModified: async () => modified,
  setLiveGuard: () => undefined,
};

const info = (id: string): CcSessionInfo => ({ sessionId: id, summary: 't', lastModified: 1, cwd: CWD });

function makeLive(extra: Partial<ConstructorParameters<typeof ClaudeCodeLive>[0]> = {}) {
  return new ClaudeCodeLive({
    workspaceId: WS,
    userId: USER,
    bridge,
    service,
    sessionInfo: async (id) => info(id),
    threads,
    store,
    runs,
    events,
    worker: { kick: () => undefined },
    permissions: perms,
    gateFor: (root) => createGate({ policy: new BuiltinPolicy(), store: perms, workspaceRoot: root }),
    mcp: { url: 'http://127.0.0.1:9/mcp/claude', secret: 's'.repeat(32) },
    notebook: async () => ({ title: 'app', grounded: false }),
    now: () => now,
    stopGraceMs: 200,
    folderExists: async () => true,
    ...extra,
  });
}

/** A thread brought in from Claude Code: a prompt and its answer. */
async function seed() {
  await threads.createThread({
    id: 'thr_1',
    workspace_id: WS,
    title: 'Fix the login bug',
    notebook_id: 'nbk_1',
    settings: {
      claude_code: { session_id: S, cwd: CWD, last_uuid: 'a1', synced_at: new Date(NOW).toISOString() },
    },
  });
  await threads.insertMessages([
    {
      id: 'msg_u1',
      thread_id: 'thr_1',
      parent_id: null,
      role: 'user',
      parts: [{ type: 'text', text: 'Fix the login bug' }],
      status: 'complete',
      trace_id: 't',
      provenance: { claude_code: { session_id: S, uuid: 'u1', uuids: ['u1'] } },
    },
    {
      id: 'msg_a1',
      thread_id: 'thr_1',
      parent_id: 'msg_u1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Fixed.' }],
      status: 'complete',
      trace_id: 't',
      provenance: { claude_code: { session_id: S, uuid: 'a1', uuids: ['a1'] } },
    },
  ]);
  await threads.patchThread('thr_1', { active_head_id: 'msg_a1', root_message_id: 'msg_u1' });
  await store.putSession(WS, {
    session_id: S,
    thread_id: 'thr_1',
    title: 'Fix the login bug',
    cwd: CWD,
    last_modified: 1,
    synced_at: new Date(NOW).toISOString(),
    mapper_version: MAPPER_VERSION,
  });
}

/** Run a queued claude_code run's handler the way the worker would. */
async function execute(
  runId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<RunOutcome> {
  const run = (await runs.get(runId)) as NonNullable<Awaited<ReturnType<typeof runs.get>>>;
  const ctx: RunContext = {
    run,
    events,
    signal,
    checkpoint: async () => undefined,
    once: async (seq, kind, input, effect) => {
      const out = await effect();
      await runs.putStep({
        runId,
        seq,
        kind,
        idempotencyKey: `${runId}:${seq}`,
        status: 'succeeded',
        input,
        output: out,
      });
      return out;
    },
  };
  return live.handler().execute(ctx);
}

const until = async (pred: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
};

const kinds = async (runId: string) => (await events.since(runId, 0)).map((e: RunEvent) => e.type);

beforeEach(async () => {
  now = NOW;
  modified = null;
  synced = [];
  threads = new MemoryThreadRepo();
  store = new MemoryClaudeCodeStore(threads);
  runs = new MemoryRunStore();
  events = new MemoryRunEventLog();
  perms = new MemoryPermissionStore();
  bridge = new FakeBridge();
  live = makeLive();
  await seed();
});

afterEach(() => live.stop());

describe('sending a turn', () => {
  it('streams like any answer and writes what an import would write', async () => {
    bridge.script = textAnswer(S, 'a2', 'Hello world');
    const sent = await live.send('thr_1', {
      text: 'Thanks, now add a test',
      idempotency_key: 'key-00000001',
    });
    const user = await threads.getMessage(sent.user_message_id);
    expect(user?.parent_id).toBe('msg_a1');
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp).toMatchObject({ sessionId: S, fork: false, resumeAt: null, cwd: CWD });
    // The same key again is the same turn.
    expect(
      await live.send('thr_1', { text: 'Thanks, now add a test', idempotency_key: 'key-00000001' }),
    ).toEqual(sent);

    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened[0]).toMatchObject({
      resume: S,
      cwd: CWD,
      permission_mode: 'default',
      path_to_cli: 'C:\\claude.exe',
      env: { DISABLE_TELEMETRY: '1' },
    });
    expect(bridge.opened[0]?.fork).toBeUndefined();
    expect(bridge.opened[0]?.append_system_prompt).toContain('NVX Ancile');
    expect(bridge.opened[0]?.mcp_servers?.ancile?.headers?.authorization).toMatch(/^Bearer thr_1\./);
    expect(bridge.sent[0]).toEqual({ handle: 'h1', text: 'Thanks, now add a test', uuid: cp.promptUuid });

    const evs = await events.since(sent.run_id, 0);
    const deltas = evs.flatMap((e) => (e.type === 'text.delta' ? [e.delta] : []));
    expect(deltas.join('')).toBe('Hello world'); // streamed once, not again from the full block
    expect(evs.map((e) => e.type)).toContain('usage');

    const answer = await threads.getMessage(cp.assistantMessageId);
    expect(answer).toMatchObject({
      status: 'complete',
      parent_id: sent.user_message_id,
      model_id: 'claude-code/claude-opus-5-5',
    });
    expect(answer?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(answer?.provenance?.claude_code).toMatchObject({
      session_id: S,
      uuid: 'a2',
      uuids: ['a2'],
      cost_estimate: { usd: 0.02 },
    });
    // CA2: input counts the 100 cache reads in; the answer is billed to a plan.
    expect(answer?.usage).toEqual({
      input_tokens: 110,
      output_tokens: 4,
      cached_tokens: 100,
      cache_write_tokens: 0,
      cache_reported: true,
      cost_usd: 0.02,
      billing: { kind: 'plan', payer: null },
    });
    expect((await threads.getThread('thr_1'))?.active_head_id).toBe(cp.assistantMessageId);
    expect(synced).toContain(S);

    // A sync of the transcript afterwards adds nothing: every entry is already there.
    const transcript = [
      {
        type: 'user' as const,
        uuid: 'u1',
        session_id: S,
        message: { role: 'user', content: 'Fix the login bug' },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant' as const,
        uuid: 'a1',
        session_id: S,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] },
        parent_tool_use_id: null,
      },
      {
        type: 'user' as const,
        uuid: cp.promptUuid,
        session_id: S,
        message: { role: 'user', content: 'Thanks, now add a test' },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant' as const,
        uuid: 'a2',
        session_id: S,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
        parent_tool_use_id: null,
      },
    ];
    expect(planSync(transcript, await store.mirror('thr_1'), () => 'new', null).planned).toEqual([]);
    // And the live answer is exactly what an import maps the same entries to.
    const fresh = planSync(transcript.slice(3), { byUuid: new Map(), messages: new Map() }, () => 'x', null);
    expect(fresh.planned[0]?.parts).toEqual(answer?.parts);
  });

  it('names each step in words, carries server tool results and says when hooks run', async () => {
    bridge.script = (b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S, model: 'claude-opus-5-5' });
      b.msg(h, {
        type: 'assistant',
        uuid: 'a3',
        session_id: S,
        parent_tool_use_id: null,
        message: {
          id: 'api-a3',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [
            { type: 'text', text: "I'll look it up first." },
            { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'AI tutoring' } },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srv1',
              content: [
                {
                  type: 'web_search_result',
                  title: 'Tutoring',
                  url: 'https://a.example',
                  encrypted_content: 'SECRET',
                },
              ],
            },
            {
              type: 'tool_use',
              id: 'b1',
              name: 'Bash',
              input: { command: 'ls src', description: 'Listing the source folder' },
            },
          ],
        },
      });
      b.msg(h, { type: 'system', subtype: 'hook_started', hook_event: 'PostToolUse', session_id: S });
      b.msg(h, { type: 'system', subtype: 'hook_response', hook_event: 'PostToolUse', session_id: S });
      b.msg(h, {
        type: 'user',
        uuid: 'r1',
        session_id: S,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'b1', content: [{ type: 'text', text: 'a.ts\nb.ts' }] },
          ],
        },
      });
      b.msg(h, { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, session_id: S });
    };
    const sent = await live.send('thr_1', { text: 'Look it up', idempotency_key: 'key-00000077' });
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    const evs = await events.since(sent.run_id, 0);
    const calls = evs.flatMap((e) => (e.type === 'tool.call' ? [[e.call_id, e.title]] : []));
    expect(calls).toEqual([
      ['srv1', "Searching the web for 'AI tutoring'"],
      ['b1', 'Listing the source folder'],
    ]);
    const results = new Map(
      evs.flatMap((e) => (e.type === 'tool.result' ? [[e.call_id, e.preview] as const] : [])),
    );
    expect(results.get('srv1')).toContain('"url":"https://a.example"');
    expect(results.get('srv1')).not.toContain('SECRET');
    // A list of text blocks is shown as its text.
    expect(results.get('b1')).toBe('a.ts\nb.ts');
    const acts = evs.flatMap((e) => (e.type === 'activity' ? [e.phase] : []));
    expect(acts).toEqual(['hooks', null]);
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    const answer = await threads.getMessage(cp.assistantMessageId);
    const saved = answer?.parts.find((p) => p.type === 'tool_result' && p.call_id === 'srv1');
    expect(saved?.type === 'tool_result' && saved.result).toBe(
      '{"title":"Tutoring","url":"https://a.example"}',
    );
  });

  it('a slash command sent from NVX Ancile shows once: the sent message becomes the command', async () => {
    bridge.script = (b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S, model: 'claude-opus-5-5' });
      // Claude Code records the command as its own entry, not as the prompt NVX Ancile wrote.
      b.msg(h, {
        type: 'user',
        uuid: 'c1',
        session_id: S,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content:
            '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>',
        },
      });
      b.msg(h, {
        type: 'user',
        uuid: 'c2',
        session_id: S,
        parent_tool_use_id: null,
        message: { role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>' },
      });
      b.msg(h, { type: 'result', subtype: 'success', is_error: false, session_id: S });
    };
    const sent = await live.send('thr_1', { text: '/model opus', idempotency_key: 'key-cmd-0001' });
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    const all = (await threads.messages('thr_1')).filter((m) => !m.deleted_at);
    const users = all.filter((m) => m.role === 'user' && m.id !== 'msg_u1');
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe(sent.user_message_id);
    expect(users[0]?.provenance?.claude_code).toMatchObject({
      kind: 'command',
      command: { name: '/model', args: 'opus', output: 'Set model to opus' },
    });
    expect((users[0]?.provenance?.claude_code as { uuids?: string[] } | undefined)?.uuids).toEqual(
      expect.arrayContaining(['c1', 'c2']),
    );
    // A later sync of the transcript adds nothing: the command's entries are on the sent message.
    const mirror = await store.mirror('thr_1');
    expect(mirror.byUuid.get('c1')).toBe(sent.user_message_id);
  });

  it('refuses a session written to by Claude Code elsewhere a moment ago, and offers a branch', async () => {
    modified = NOW - 10_000;
    await expect(
      live.send('thr_1', { text: 'Go on', idempotency_key: 'key-00000002' }),
    ).rejects.toMatchObject({
      code: 'claude_code.session_busy',
      status: 409,
    });
    const sent = await live.send('thr_1', {
      text: 'Go on',
      as_branch: true,
      idempotency_key: 'key-00000003',
    });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp).toMatchObject({ fork: true, resumeAt: 'a1', sessionId: S });
  });

  it('goes on in a branch by itself when a terminal has the session open, however long it has been idle', async () => {
    // Idle for an hour: the 60 s rule would not see it, the process list does.
    modified = NOW - 3_600_000;
    const asked: { sessionId: string; cwd: string | null }[] = [];
    live.stop();
    live = makeLive({
      holders: {
        holder: async (q) => {
          asked.push({ sessionId: q.sessionId, cwd: q.cwd });
          return q.sessionId === S ? { pid: 4242, how: 'session' } : null;
        },
      },
    });
    const sent = await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-00000101' });
    expect(sent.branched).toBe('open_in_terminal');
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp).toMatchObject({ fork: true, resumeAt: 'a1', sessionId: S });
    expect(asked[0]).toEqual({ sessionId: S, cwd: CWD });
    const state = await live.state('thr_1');
    expect(state).toMatchObject({ locked_elsewhere: true, open_in_terminal: true });
  });

  it('keeps the 60 s rule when no process holds the session, and says it is a guess', async () => {
    live.stop();
    live = makeLive({ holders: { holder: async () => null } });
    modified = NOW - 10_000;
    expect(await live.state('thr_1')).toMatchObject({ locked_elsewhere: true, open_in_terminal: false });
    await expect(
      live.send('thr_1', { text: 'Go on', idempotency_key: 'key-00000102' }),
    ).rejects.toMatchObject({
      code: 'claude_code.session_busy',
    });
    modified = null;
    const sent = await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-00000103' });
    expect(sent.branched).toBeUndefined();
  });

  it('branches from an earlier message by forking the session there, and binds the fork to the thread', async () => {
    bridge.script = textAnswer(S, 'a2', 'First way');
    const first = await live.send('thr_1', { text: 'Do it one way', idempotency_key: 'key-00000004' });
    await execute(first.run_id);
    await runs.save(
      { ...((await runs.get(first.run_id)) as RunRecord), status: 'succeeded' },
      { status: 'queued' },
    );

    bridge.script = textAnswer(F, 'b2', 'Second way');
    const second = await live.send('thr_1', {
      text: 'Do it another way',
      parent_id: 'msg_a1',
      idempotency_key: 'key-00000005',
    });
    const cp = (await runs.get(second.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp).toMatchObject({ fork: true, resumeAt: 'a1', sessionId: S });
    expect(await execute(second.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened.at(-1)).toMatchObject({ resume: S, fork: true, resume_at: 'a1' });
    expect(bridge.closed).toContain('h1'); // the handle on the original session made way

    const user = await threads.getMessage(second.user_message_id);
    expect(user?.parent_id).toBe('msg_a1');
    expect((user?.provenance?.claude_code as { session_id?: string } | undefined)?.session_id).toBe(F);
    const answer = await threads.getMessage(cp.assistantMessageId);
    expect((answer?.provenance?.claude_code as { session_id?: string } | undefined)?.session_id).toBe(F);
    const bindings = await store.sessions(WS);
    expect(bindings.map((b) => [b.session_id, b.thread_id]).sort()).toEqual([
      [F, 'thr_1'],
      [S, 'thr_1'],
    ]);
    // Both answers hang off the first answer: a branch in Ancile, a fork in Claude Code.
    const kids = (await threads.messages('thr_1')).filter((m) => m.parent_id === 'msg_a1');
    expect(kids).toHaveLength(2);
  });

  it('refuses to branch from a message that did not come from Claude Code', async () => {
    await threads.insertMessage({
      id: 'msg_note',
      thread_id: 'thr_1',
      parent_id: 'msg_a1',
      role: 'user',
      parts: [{ type: 'text', text: 'mine' }],
      status: 'complete',
      trace_id: 't',
    });
    await expect(
      live.send('thr_1', { text: 'x', parent_id: 'msg_note', idempotency_key: 'key-00000006' }),
    ).rejects.toMatchObject({ code: 'claude_code.branch_unmapped' });
  });

  it('stops when interrupted, keeping what streamed', async () => {
    bridge.script = (b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      b.msg(h, {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'm9' } },
      });
      b.msg(h, {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partly' } },
      });
      b.msg(h, {
        type: 'assistant',
        uuid: 'a9',
        session_id: S,
        parent_tool_use_id: null,
        message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: 'Partly' }] },
      });
    };
    const sent = await live.send('thr_1', { text: 'Long job', idempotency_key: 'key-00000007' });
    const run = execute(sent.run_id);
    await until(async () => (await kinds(sent.run_id)).includes('text.delta'));
    expect(await live.interrupt('thr_1')).toEqual({ interrupted: true });
    expect(await run).toEqual({ kind: 'cancelled' });
    expect(bridge.interrupted).toEqual(['h1']);
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    const answer = await threads.getMessage(cp.assistantMessageId);
    expect(answer?.status).toBe('stopped');
    expect(answer?.parts).toEqual([{ type: 'text', text: 'Partly' }]);
  });

  it('stops when the run is cancelled', async () => {
    bridge.script = (b, h) => b.msg(h, { type: 'system', subtype: 'init', session_id: S });
    const sent = await live.send('thr_1', { text: 'Long job', idempotency_key: 'key-00000008' });
    const ac = new AbortController();
    const run = execute(sent.run_id, ac.signal);
    await until(() => bridge.sent.length > 0);
    ac.abort(new Error('cancelled'));
    expect(await run).toEqual({ kind: 'cancelled' });
    expect(bridge.interrupted).toEqual(['h1']);
  });
});

describe('permissions', () => {
  const start = async (script: Script) => {
    bridge.script = script;
    const sent = await live.send('thr_1', { text: 'Work', idempotency_key: `key-${Math.random()}` });
    const run = execute(sent.run_id);
    return { sent, run };
  };
  const end: Script = (b, h) =>
    b.msg(h, { type: 'result', subtype: 'success', is_error: false, session_id: S });

  it('lets a read inside the session folder run, and asks for a shell command in Ancile', async () => {
    const { sent, run } = await start((b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      b.ask(h, 'r1', 'Read', { file_path: join(CWD, 'src', 'auth.ts') }, 'tu1');
      b.ask(h, 'r2', 'Bash', { command: 'npm test' }, 'tu2');
    });
    await until(() => bridge.replies.length >= 1);
    expect(bridge.replies[0]).toMatchObject({ request_id: 'r1', r: { behavior: 'allow' } });
    await until(async () => (await perms.pendingApprovals()).length === 1);
    const a = (await perms.pendingApprovals())[0] as ApprovalRecord;
    expect(a).toMatchObject({
      principal: CLAUDE_CODE_PRINCIPAL,
      tool: 'Bash',
      action: 'shell.exec',
      resource: 'shell:npm test',
      tier: 'gated',
      args: { command: 'npm test' },
    });
    expect(live.editable(a)).toBe(true);
    expect(await kinds(sent.run_id)).toContain('approval.required');

    // Approved with an edited command: checked again, then passed on as Claude Code's input.
    const again = await live.recheck(a, { command: 'npm test -- --run' });
    expect(again.outcome).toBe('ask');
    expect(await live.resolved(a, 'approved', null, { command: 'npm test -- --run' })).toBe(true);
    expect(bridge.replies.at(-1)).toMatchObject({
      request_id: 'r2',
      r: { behavior: 'allow', updated_input: { command: 'npm test -- --run' } },
    });
    expect(live.editable(a)).toBe(false);
    end(bridge, 'h1', '', undefined);
    await run;
  });

  it('withdraws an approval still waiting when its turn ends, so it can never be answered later', async () => {
    const { sent, run } = await start((b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      b.ask(h, 'r1', 'Bash', { command: 'npm test' }, 'tu1');
    });
    await until(async () => (await perms.pendingApprovals()).length === 1);
    const a = (await perms.pendingApprovals())[0] as ApprovalRecord;
    expect(a.run_id).toBe(sent.run_id);
    // The turn ends (stopped here) with the question unanswered.
    await live.interrupt('thr_1');
    await run;
    expect((await perms.getApproval(a.id))?.status).toBe('cancelled');
    const evs = await events.since(sent.run_id, 0);
    expect(evs.find((e) => e.type === 'approval.resolved')).toMatchObject({
      approval_id: a.id,
      decision: 'cancelled',
    });
    // An answer that arrives now is for nobody: Claude Code hears nothing more.
    const replies = bridge.replies.length;
    expect(await live.resolved(a, 'approved')).toBe(false);
    expect(bridge.replies.length).toBe(replies);
  });

  it('withdraws a waiting approval when the model changes, and tells the running turn', async () => {
    const { sent, run } = await start((b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      b.ask(h, 'r1', 'Write', { file_path: join(CWD, 'a.ts'), content: 'x' }, 'tu1');
    });
    await until(async () => (await perms.pendingApprovals()).length === 1);
    const a = (await perms.pendingApprovals())[0] as ApprovalRecord;
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', claudeCodeRoutes({ service: () => ({}) as never, live: () => live }));
    const res = await app.request('/claude-code/threads/thr_1/model-changed', { method: 'POST' });
    expect(await res.json()).toEqual({ withdrawn: 1 });
    expect((await perms.getApproval(a.id))?.status).toBe('cancelled');
    expect(bridge.replies.at(-1)).toMatchObject({
      request_id: 'r1',
      r: { behavior: 'deny', message: expect.stringContaining('model for this thread changed') },
    });
    expect(live.editable(a)).toBe(false);
    // Nothing else was waiting.
    expect(await live.modelChanged('thr_1')).toEqual({ withdrawn: 0 });
    end(bridge, 'h1', '', undefined);
    await run;
    expect(await kinds(sent.run_id)).toContain('approval.resolved');
  });

  it('denies with the reason, never asking twice, and makes a write outside the folder critical', async () => {
    perms.createGrant({
      userId: USER,
      principal: CLAUDE_CODE_PRINCIPAL,
      actionPattern: 'shell.exec',
      resourcePattern: 'shell:rm *',
      effect: 'deny',
      scope: 'always',
      scopeRef: null,
      expiresAt: null,
      fromApprovalId: null,
    });
    const outside = join(tmpdir(), 'elsewhere', 'notes.md');
    const { run } = await start((b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      b.ask(h, 'r1', 'Bash', { command: 'rm -rf build' }, 'tu1');
      b.ask(h, 'r2', 'Write', { file_path: outside, content: 'x' }, 'tu2');
    });
    await until(() => bridge.replies.length >= 1);
    expect(bridge.replies[0]).toMatchObject({
      request_id: 'r1',
      r: { behavior: 'deny', message: 'You chose to always deny this' },
    });
    await until(async () => (await perms.pendingApprovals()).length === 1);
    const a = (await perms.pendingApprovals())[0] as ApprovalRecord;
    expect(a).toMatchObject({ tool: 'Write', action: 'fs.write', tier: 'critical', suggestions: [] });
    await live.resolved(a, 'denied', 'Not there');
    expect(bridge.replies.at(-1)).toMatchObject({
      request_id: 'r2',
      r: { behavior: 'deny', message: 'Not there' },
    });
    end(bridge, 'h1', '', undefined);
    await run;
  });

  it('maps MCP tools and Claude Code bookkeeping', async () => {
    const { run } = await start((b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      b.ask(h, 'r1', 'TodoWrite', { todos: [] }, 'tu1');
      b.ask(h, 'r2', 'mcp__ancile__search', { query: 'tokens' }, 'tu2');
      b.ask(h, 'r3', 'mcp__github__create_issue', { title: 'x' }, 'tu3');
    });
    await until(() => bridge.replies.length >= 2);
    expect(bridge.replies.map((r) => [r.request_id, r.r.behavior])).toEqual([
      ['r1', 'allow'],
      ['r2', 'allow'],
    ]);
    await until(async () => (await perms.pendingApprovals()).length === 1);
    expect((await perms.pendingApprovals())[0]).toMatchObject({
      action: 'mcp.github.create_issue',
      resource: 'mcp:github/create_issue',
    });
    end(bridge, 'h1', '', undefined);
    await run;
  });

  it('takes edited arguments through the approvals route only once and only where allowed', async () => {
    const { run } = await start((b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      b.ask(h, 'r1', 'Bash', { command: 'npm test' }, 'tu1');
    });
    await until(async () => (await perms.pendingApprovals()).length === 1);
    const a = (await perms.pendingApprovals())[0] as ApprovalRecord;
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route(
      '/',
      permissionRoutes({
        store: perms,
        events,
        worker: { resume: async () => true },
        userId: USER,
        scopeRefs: async () => ({ threadId: 'thr_1', notebookId: null, workspaceId: WS }),
        onResolved: (ap, status, reason, updated) => live.resolved(ap, status, reason, updated),
        editable: (ap) => live.editable(ap),
        recheck: (ap, args) => live.recheck(ap, args),
      }),
    );
    const post = (b: unknown) =>
      app.request(`/approvals/${a.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
    const listed = (await (await app.request('/approvals')).json()) as {
      items: { args_editable?: boolean; args?: unknown }[];
    };
    expect(listed.items[0]).toMatchObject({ args_editable: true, args: { command: 'npm test' } });
    const wide = await post({ decision: 'approve', scope: 'thread', updated_args: { command: 'ls' } });
    expect(wide.status).toBe(422);
    expect(((await wide.json()) as { error: { code: string } }).error.code).toBe(
      'permission.edit_needs_once',
    );
    const ok = await post({
      decision: 'approve',
      scope: 'once',
      updated_args: { command: 'npm test -- --run' },
    });
    expect(ok.status).toBe(200);
    expect(bridge.replies.at(-1)).toMatchObject({
      r: { behavior: 'allow', updated_input: { command: 'npm test -- --run' } },
    });
    end(bridge, 'h1', '', undefined);
    await run;
  });

  it('a thread rule web:* settles the searches and fetches waiting, and covers later ones', async () => {
    const { run } = await start((b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      b.ask(h, 'r1', 'WebFetch', { url: 'https://ai.g2.com/reviews', prompt: 'x' }, 'tu1');
      b.ask(h, 'r2', 'WebSearch', { query: 'tutoring centre' }, 'tu2');
      b.ask(h, 'r3', 'WebFetch', { url: 'https://aiera.blog/', prompt: 'x' }, 'tu3');
    });
    await until(async () => (await perms.pendingApprovals()).length === 3);
    const search = (await perms.pendingApprovals()).find((x) => x.tool === 'WebSearch') as ApprovalRecord;
    expect(search).toMatchObject({ action: 'web.search', resource: 'web:search/tutoring centre' });
    expect(search.suggestions).toEqual(['web:search/tutoring centre', 'web:search', 'web:*']);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route(
      '/',
      permissionRoutes({
        store: perms,
        events,
        worker: { resume: async () => true },
        userId: USER,
        scopeRefs: async (ap) => ({ threadId: ap.thread_id, notebookId: 'nbk_1', workspaceId: WS }),
        onResolved: (ap, status, reason, updated) => live.resolved(ap, status, reason, updated),
        editable: (ap) => live.editable(ap),
        recheck: (ap, args) => live.recheck(ap, args),
        decideAgain: async (ap) => (live.editable(ap) ? live.recheck(ap, ap.args) : null),
      }),
    );
    const res = await app.request(`/approvals/${search.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', scope: 'thread', pattern: 'web:*' }),
    });
    expect(res.status).toBe(200);
    // All three answered: the one you decided, and the two the rule now covers.
    await until(() => bridge.replies.length >= 3);
    expect(await perms.pendingApprovals()).toEqual([]);
    for (const id of ['r1', 'r2', 'r3'])
      expect(bridge.replies.find((r) => r.request_id === id)?.r.behavior).toBe('allow');
    // Later searches and fetches in this thread run without asking.
    bridge.ask('h1', 'r4', 'WebSearch', { query: 'maths tutors near me' }, 'tu4');
    bridge.ask('h1', 'r5', 'WebFetch', { url: 'https://example.org/a/b?c=1', prompt: 'x' }, 'tu5');
    await until(() => bridge.replies.length >= 5);
    expect(bridge.replies.slice(3).map((r) => [r.request_id, r.r.behavior])).toEqual([
      ['r4', 'allow'],
      ['r5', 'allow'],
    ]);
    expect(await perms.pendingApprovals()).toEqual([]);
    end(bridge, 'h1', '', undefined);
    await run;
  });

  it('refuses edited arguments for a tool that cannot take them, and edits a policy denies', async () => {
    const other = await perms.createApproval({
      runId: 'run_x',
      stepSeq: 1,
      threadId: 'thr_1',
      callId: 'c1',
      principal: 'assistant',
      tool: 'fs_write',
      action: 'fs.write',
      resource: 'fs:/workspace/a.md',
      args: {},
      argsPreview: {},
      tier: 'gated',
      suggestions: [],
    });
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route(
      '/',
      permissionRoutes({
        store: perms,
        events,
        worker: { resume: async () => true },
        userId: USER,
        scopeRefs: async () => ({ threadId: 'thr_1', notebookId: null, workspaceId: WS }),
        editable: (ap) => ap.id === other.id,
        recheck: async () => ({
          outcome: 'deny',
          via: 'policy',
          tier: 'gated',
          resource: 'x',
          reason: 'no',
          policyId: 'p.1',
        }),
      }),
    );
    const res = await app.request(`/approvals/${other.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', scope: 'once', updated_args: { path: '/etc' } }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'permission.edited_args_denied',
    );
    expect((await perms.getApproval(other.id))?.status).toBe('pending');
  });
});

describe('sources and citations', () => {
  const hit = (n: number): SearchHit =>
    ({
      chunk_id: `chk_${n}`,
      source_id: `src_${n}`,
      source_title: `Source ${n}`,
      text: `Passage ${n} about tokens.`,
      char_start: n * 10,
      char_end: n * 10 + 20,
      page: null,
      heading_path: [],
      kind: 'chunk',
      score: 1,
      rerank_score: null,
      ranks: {},
    }) as unknown as SearchHit;

  it('numbers passages across the turn and turns the markers used into citations', async () => {
    bridge.script = async (b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      expect(live.passages('thr_1', [hit(1), hit(2)])?.map((p) => p.marker)).toEqual([1, 2]);
      expect(live.passages('thr_1', [hit(2), hit(3)])?.map((p) => p.marker)).toEqual([2, 3]);
      textAnswer(S, 'a5', 'Auth uses tokens [3]. Also see [9].')(b, h, '', undefined);
    };
    const sent = await live.send('thr_1', { text: 'How does auth work?', idempotency_key: 'key-00000009' });
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    const answer = await threads.getMessage(cp.assistantMessageId);
    expect(answer?.parts[0]).toEqual({ type: 'text', text: 'Auth uses tokens [3]. Also see.' });
    expect(answer?.parts[1]).toMatchObject({
      type: 'citation_ref',
      marker: 3,
      chunk_id: 'chk_3',
      source_id: 'src_3',
    });
    expect((answer?.provenance?.retrieval as { invalid_markers?: number } | undefined)?.invalid_markers).toBe(
      1,
    );
    expect(await kinds(sent.run_id)).toContain('citation');
    expect(live.passages('thr_1', [hit(1)])).toBeNull(); // no turn running
  });

  it('starts a fact-check after an answer in a grounded notebook', async () => {
    const checked: string[] = [];
    live.stop();
    live = makeLive({
      notebook: async () => ({ title: 'app', grounded: true }),
      afterAnswer: async (a) => {
        checked.push(a.messageId);
      },
    });
    bridge.script = textAnswer(S, 'a6', 'Done.');
    const sent = await live.send('thr_1', { text: 'x', idempotency_key: 'key-00000010' });
    await execute(sent.run_id);
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(checked).toEqual([cp.assistantMessageId]);
  });
});

describe('state and commands', () => {
  it('reports the live state, with Claude Code’s own context count when a session is open', async () => {
    expect(await live.state('thr_1')).toMatchObject({
      state: 'idle',
      locked_elsewhere: false,
      cwd: CWD,
      context: null,
    });
    modified = NOW - 5_000;
    expect((await live.state('thr_1')).locked_elsewhere).toBe(true);
    modified = null;
    bridge.script = textAnswer(S, 'a7', 'ok');
    const sent = await live.send('thr_1', { text: 'x', idempotency_key: 'key-00000011' });
    await execute(sent.run_id);
    bridge.controlAnswers.context_usage = { total_tokens: 50_000, max_tokens: 200_000, percentage: 25 };
    expect(await live.state('thr_1')).toMatchObject({
      state: 'ready',
      model: 'claude-opus-5-5',
      context: { used_tokens: 50_000, max_tokens: 200_000, percent: 25 },
    });
  });

  it('hands rate_limit_event to the plan limits, asks for usage after the turn, and passes the compaction point', async () => {
    const seen: unknown[] = [];
    const after: string[] = [];
    live = makeLive({
      limits: {
        observe: async (m) => {
          seen.push(m);
        },
        afterTurn: (h) => after.push(h),
      },
    });
    const answer = textAnswer(S, 'a8', 'ok');
    bridge.script = (b, h, ...rest) => {
      b.msg(h, {
        type: 'rate_limit_event',
        session_id: S,
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4 },
      });
      return answer(b, h, ...rest);
    };
    const sent = await live.send('thr_1', { text: 'x', idempotency_key: 'key-00000012' });
    await execute(sent.run_id);
    expect(seen).toEqual([expect.objectContaining({ type: 'rate_limit_event' })]);
    expect(after).toHaveLength(1);
    expect(live.openHandle()).toBe(after[0]);
    bridge.controlAnswers.context_usage = {
      total_tokens: 50_000,
      max_tokens: 200_000,
      percentage: 25,
      compacts_at: 83.5,
    };
    expect((await live.state('thr_1')).context).toEqual({
      used_tokens: 50_000,
      max_tokens: 200_000,
      percent: 25,
      compacts_at: 83.5,
    });
  });

  it("merges Claude Code's own list with what NVX Ancile does itself, from a session that writes nothing", async () => {
    bridge.controlAnswers.supported_commands = [
      { name: 'mcp', description: 'Manage MCP servers', argumentHint: '', builtin: true },
      { name: 'compact', description: 'Compact', argumentHint: '<instructions>', builtin: true },
      { name: 'theme', description: 'Theme', argumentHint: '', builtin: true },
      { name: 'model', description: 'Model', argumentHint: '', builtin: true },
      { name: 'init', description: 'Write CLAUDE.md', argumentHint: '', builtin: true },
      { name: 'my-skill', description: 'Mine', argumentHint: '<x>' },
      { name: 'plug:thing', description: 'From a plugin', argumentHint: '' },
      { name: 'memory', description: 'A user command called memory', argumentHint: '' },
    ];
    bridge.controlAnswers.supported_models = [{ value: 'opus', displayName: 'Opus' }];
    bridge.controlAnswers.mcp_status = [{ name: 'github' }];
    const first = await live.commands('thr_1');
    // At once: the built-ins, marked partial, while Claude Code's own list is read.
    expect(first.partial).toBe(true);
    expect(first.items.find((c) => c.name === 'mcp')).toMatchObject({ ancile_action: 'open_mcp' });
    expect(first.items.find((c) => c.name === 'my-skill')).toBeUndefined();
    const { items, partial } = await live.commands('thr_1', { wait: true });
    expect(partial).toBe(false);
    const by = new Map(items.map((c) => [c.name, c]));
    expect(by.get('mcp')).toMatchObject({
      handled_by: 'ancile',
      ancile_action: 'open_mcp',
      source: 'builtin',
    });
    expect(by.get('mcp')?.arguments.map((a) => a.value)).toEqual([
      'reconnect',
      'enable',
      'disable',
      'github',
    ]);
    expect(by.get('compact')).toMatchObject({ handled_by: 'claude', argument_hint: '[instructions]' });
    expect(by.get('theme')).toMatchObject({ handled_by: 'ancile', ancile_action: 'unsupported' });
    expect(by.get('model')).toMatchObject({
      ancile_action: 'set_model',
      arguments: [{ value: 'opus', description: 'Opus' }],
    });
    expect(by.get('init')).toMatchObject({ handled_by: 'claude', ancile_action: null });
    expect(by.get('my-skill')).toMatchObject({ handled_by: 'claude', source: 'skill', argument_hint: '<x>' });
    expect(by.get('plug:thing')).toMatchObject({ source: 'plugin' });
    expect(by.get('memory')).toMatchObject({ handled_by: 'claude', source: 'skill' }); // the person's own command wins
    expect(by.get('branch')).toMatchObject({
      handled_by: 'ancile',
      ancile_action: 'branch',
      source: 'ancile',
    });
    expect(by.get('effort')?.arguments.map((a) => a.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'auto',
    ]);
    expect(bridge.opened[0]).toMatchObject({ cwd: CWD, persist: false });
    expect(bridge.opened[0]?.resume).toBeUndefined();
    expect(bridge.closed).toEqual(['h1']);
    expect((await live.commands('thr_1')).partial).toBe(false);
    expect(bridge.opened).toHaveLength(1); // cached per folder and version
  });

  it('answers the routes', async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', claudeCodeRoutes({ service: () => ({}) as never, live: () => live }));
    const res = await app.request('/claude-code/threads/thr_1/live');
    expect(res.status).toBe(200);
    const bad = await app.request('/claude-code/threads/thr_1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(bad.status).toBe(400);
    const stop = await app.request('/claude-code/threads/thr_1/interrupt', { method: 'POST' });
    expect(stop.status).toBe(409);
    expect(((await stop.json()) as { error: { code: string } }).error.code).toBe('claude_code.not_live');
  });
});

describe('starting a session in a folder (POST /claude-code/threads)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ancile-cc-new-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const withFolders = (extra: Partial<LiveServiceView> = {}) =>
    makeLive({
      service: {
        ...service,
        notebookForFolder: async () => 'nbk_folder',
        folderExcluded: async (cwd) => cwd.includes('excluded'),
        ...extra,
      },
    });

  it('refuses a relative path, a missing folder, a file and an excluded folder', async () => {
    live.stop();
    live = withFolders();
    await expect(live.createThread({ cwd: 'code/app' })).rejects.toMatchObject({
      code: 'claude_code.folder_invalid',
      status: 400,
    });
    await expect(live.createThread({ cwd: join(dir, 'gone') })).rejects.toMatchObject({
      code: 'claude_code.folder_invalid',
      title: 'That folder is not on this computer',
    });
    await writeFile(join(dir, 'a.txt'), 'x');
    await expect(live.createThread({ cwd: join(dir, 'a.txt') })).rejects.toMatchObject({
      code: 'claude_code.folder_invalid',
      title: 'That is a file, not a folder',
    });
    await mkdir(join(dir, 'excluded'));
    await expect(live.createThread({ cwd: join(dir, 'excluded') })).rejects.toMatchObject({
      code: 'claude_code.folder_excluded',
    });
  });

  it('asks the notebook scope before anything exists, and checks the folder against it', async () => {
    const hooks = claudeHooks({
      threads,
      store: {} as never,
      allow: async () => undefined,
      scopeOf: async (notebookId) =>
        resolveScope({
          notebookId,
          threadId: null,
          private: false,
          notebook: { folders: [join(dir, 'allowed').replace(/\\/g, '/')] },
          thread: null,
        }),
    });
    live.stop();
    live = makeLive({
      engines: hooks,
      service: { ...service, notebookForFolder: async () => 'nbk_folder', folderExcluded: async () => false },
    });
    await mkdir(join(dir, 'allowed', 'app'), { recursive: true });
    await mkdir(join(dir, 'elsewhere'));
    await expect(live.createThread({ cwd: join(dir, 'elsewhere') })).rejects.toMatchObject({
      code: 'claude_code.folder_out_of_scope',
      status: 403,
    });
    expect((await live.createThread({ cwd: join(dir, 'allowed', 'app') })).notebook_id).toBe('nbk_folder');

    // Claude Code refused by the notebook's scope (a private notebook, say): nothing is made.
    const refused = claudeHooks({
      threads,
      store: {} as never,
      allow: async () => {
        throw new AncileError({ code: 'scope.engine_not_allowed', title: 'No', hint: 'No', status: 403 });
      },
    });
    live.stop();
    live = makeLive({ engines: refused, service: { ...service, folderExcluded: async () => false } });
    const before = (await threads.listThreads(WS)).length;
    await expect(live.createThread({ cwd: dir })).rejects.toMatchObject({ code: 'scope.engine_not_allowed' });
    expect((await threads.listThreads(WS)).length).toBe(before);
  });

  it('makes a thread bound to a new session whose first turn starts it fresh, then binds the session Claude Code started', async () => {
    live.stop();
    live = withFolders();
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', claudeCodeRoutes({ service: () => ({}) as never, live: () => live }));
    const res = await app.request('/claude-code/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir }),
    });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { thread_id: string; notebook_id: string; cwd: string; title: string };
    expect(made).toMatchObject({ notebook_id: 'nbk_folder', cwd: dir });
    expect(made.title).toMatch(/^New session in ancile-cc-new-/);
    const t = await threads.getThread(made.thread_id);
    expect(isPendingSession(t?.settings.claude_code?.session_id)).toBe(true);
    expect(await live.state(made.thread_id)).toMatchObject({
      state: 'idle',
      locked_elsewhere: false,
      cwd: dir,
    });

    const NEW = 'sess-new-0003';
    bridge.script = textAnswer(NEW, 'n1', 'Hello from a new session');
    const sent = await live.send(made.thread_id, {
      text: 'Start here',
      parent_id: null,
      idempotency_key: 'key-new-00001',
    });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp).toMatchObject({ fresh: true, fork: false, cwd: dir });
    expect(sent.assistant_message_id).toBe(cp.assistantMessageId);
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened[0]?.resume).toBeUndefined();
    expect(bridge.opened[0]?.fork).toBeUndefined();
    expect(bridge.opened[0]?.cwd).toBe(dir);

    const after = await threads.getThread(made.thread_id);
    expect(after?.settings.claude_code?.session_id).toBe(NEW);
    expect(after?.active_head_id).toBe(cp.assistantMessageId);
    expect((await store.sessions(WS)).find((b) => b.session_id === NEW)?.thread_id).toBe(made.thread_id);
    const user = await threads.getMessage(sent.user_message_id);
    expect(user?.parent_id).toBeNull();
    expect((user?.provenance?.claude_code as { session_id?: string } | undefined)?.session_id).toBe(NEW);
    expect(synced).toContain(NEW); // the usual sync afterwards, on the real session
  });
});

describe("a session's folder moved, renamed or deleted", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ancile-cc-moved-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** CWD is gone; anything else is there (the real file system decides for a new folder). */
  const moved = (extra: Partial<ConstructorParameters<typeof ClaudeCodeLive>[0]> = {}) => {
    live.stop();
    live = makeLive({
      folderExists: async (p) => p !== CWD,
      noFilesDir: join(dir, 'no-folder'),
      service: { ...service, folderExcluded: async (cwd) => cwd.includes('excluded') },
      ...extra,
    });
  };

  it('checks the folder before every turn and says so clearly, sending nothing', async () => {
    moved();
    await expect(
      live.send('thr_1', { text: 'Go on', idempotency_key: 'key-moved-001' }),
    ).rejects.toMatchObject({
      code: 'claude_code.folder_missing',
      title: "This session's folder has moved or been deleted",
      status: 409,
    });
    expect((await threads.messages('thr_1')).length).toBe(2);
    expect(await live.state('thr_1')).toMatchObject({ folder_missing: true, no_files: false });
  });

  it('points to the new folder (checked), keeps it on the thread, and starts a new session there', async () => {
    moved();
    await expect(live.setFolder('thr_1', { cwd: 'app' })).rejects.toMatchObject({
      code: 'claude_code.folder_invalid',
    });
    await expect(live.setFolder('thr_1', { cwd: join(dir, 'nope') })).rejects.toMatchObject({
      title: 'That folder is not on this computer',
    });
    await mkdir(join(dir, 'excluded'));
    await expect(live.setFolder('thr_1', { cwd: join(dir, 'excluded') })).rejects.toMatchObject({
      code: 'claude_code.folder_excluded',
    });
    const there = join(dir, 'app-renamed');
    await mkdir(there);
    // Through the route, as the Cockpit asks.
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', claudeCodeRoutes({ service: () => ({}) as never, live: () => live }));
    const res = await app.request('/claude-code/threads/thr_1/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: there }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cwd: there, no_files: false });
    expect((await threads.getThread('thr_1'))?.settings.claude_code).toMatchObject({
      cwd: there,
      fresh_next: true,
    });
    expect(await live.state('thr_1')).toMatchObject({ folder_missing: false, cwd: there });

    const NEW = 'sess-moved-0004';
    bridge.script = textAnswer(NEW, 'm1', 'Carrying on in the new folder');
    const sent = await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-moved-002' });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp).toMatchObject({ fresh: true, fork: false, cwd: there, rebind: true });
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened.at(-1)).toMatchObject({ cwd: there });
    expect(bridge.opened.at(-1)?.resume).toBeUndefined();
    // The new session is the thread's own now, in the new folder; nothing more to start.
    const bound = (await threads.getThread('thr_1'))?.settings.claude_code;
    expect(bound).toMatchObject({ session_id: NEW, cwd: there });
    expect(bound?.fresh_next).toBeUndefined();
    // The answer hangs off your message, which follows the old answer: the thread reads on.
    expect((await threads.getMessage(sent.user_message_id))?.parent_id).toBe('msg_a1');
  });

  it("refuses a new folder outside the notebook's scope", async () => {
    const allowed = join(dir, 'allowed');
    await mkdir(join(allowed, 'app'), { recursive: true });
    await mkdir(join(dir, 'elsewhere'));
    moved({
      engines: claudeHooks({
        threads,
        store: {} as never,
        allow: async () => undefined,
        scopeOf: async (notebookId) =>
          resolveScope({
            notebookId,
            threadId: null,
            private: false,
            notebook: { folders: [allowed.replace(/\\/g, '/')] },
            thread: null,
          }),
      }),
    });
    await expect(live.setFolder('thr_1', { cwd: join(dir, 'elsewhere') })).rejects.toMatchObject({
      code: 'claude_code.folder_out_of_scope',
    });
    expect((await live.setFolder('thr_1', { cwd: join(allowed, 'app') })).cwd).toBe(join(allowed, 'app'));
  });

  it('continues without files: a new session in an empty folder, with Claude Code’s own tools off', async () => {
    moved();
    expect(await live.setFolder('thr_1', { without_files: true })).toEqual({ cwd: CWD, no_files: true });
    expect(await live.state('thr_1')).toMatchObject({ folder_missing: false, no_files: true });
    bridge.script = textAnswer('sess-nofiles-0005', 'f1', 'From what we said so far');
    const sent = await live.send('thr_1', { text: 'What did we decide?', idempotency_key: 'key-moved-003' });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp).toMatchObject({ fresh: true, noFiles: true, cwd: join(dir, 'no-folder') });
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened.at(-1)).toMatchObject({
      cwd: join(dir, 'no-folder'),
      tools: [],
      setting_sources: ['user'],
    });
    // The thread keeps the folder it came from, still without files, on its new session.
    expect((await threads.getThread('thr_1'))?.settings.claude_code).toMatchObject({
      session_id: 'sess-nofiles-0005',
      cwd: CWD,
      no_files: true,
    });
    // Later turns carry that session on, still without files.
    await runs.save(
      { ...((await runs.get(sent.run_id)) as RunRecord), status: 'succeeded' },
      { status: 'queued' },
    );
    bridge.script = textAnswer('sess-nofiles-0005', 'f2', 'Still here');
    const next = await live.send('thr_1', { text: 'And then?', idempotency_key: 'key-moved-004' });
    const again = (await runs.get(next.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(again).toMatchObject({ sessionId: 'sess-nofiles-0005', noFiles: true, fork: false });
    expect(again.fresh).toBeFalsy();
  });

  it('will not change the folder while a turn is running', async () => {
    moved({ folderExists: async () => true });
    bridge.script = () => undefined;
    await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-moved-005' });
    await expect(live.setFolder('thr_1', { without_files: true })).rejects.toMatchObject({
      code: 'run.already_running',
    });
  });
});

describe('the send answer, effort and the first message', () => {
  it('names the answer it streams into, here and through the engines front door', async () => {
    bridge.script = textAnswer(S, 'a2', 'ok');
    const sent = await live.send('thr_1', { text: 'Go on', idempotency_key: 'key-ans-00001' });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(sent).toMatchObject({
      user_message_id: cp.userMessageId,
      assistant_message_id: cp.assistantMessageId,
    });
    expect((await threads.getMessage(sent.assistant_message_id))?.status).toBe('pending');
    await execute(sent.run_id);
    await runs.save(
      { ...((await runs.get(sent.run_id)) as RunRecord), status: 'succeeded' },
      { status: 'queued' },
    );

    const engine = new ClaudeCodeEngine({
      live: () => live,
      installed: async () => ({ available: true, reason: null }),
    });
    const thread = await threads.getThread('thr_1');
    const r = await engine.start({
      thread,
      text: 'And again',
      modelId: null,
      requestedModelId: null,
      idempotencyKey: 'key-ans-00002',
    } as never);
    const cp2 = (await runs.get(r.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(r.assistant_message_id).toBe(cp2.assistantMessageId);
  });

  it('takes effort "auto" as Claude Code’s own choice: no effort sent, and a set one is dropped', async () => {
    const parsed = SendClaudeCodeRequest.parse({
      text: 'x',
      effort: 'auto',
      idempotency_key: 'key-00000000',
    });
    expect(parsed.effort).toBe('auto');
    const turn = SendTurnRequest.parse({ text: 'x', effort: 'auto', idempotency_key: 'key-00000000' });
    expect(turn.effort).toBe('auto');

    bridge.script = textAnswer(S, 'a2', 'thinking hard');
    const one = await live.send('thr_1', {
      text: 'Hard one',
      effort: 'high',
      idempotency_key: 'key-eff-00001',
    });
    await execute(one.run_id);
    expect(bridge.opened[0]?.effort).toBe('high');
    await runs.save(
      { ...((await runs.get(one.run_id)) as RunRecord), status: 'succeeded' },
      { status: 'queued' },
    );

    bridge.script = textAnswer(S, 'a3', 'as it likes');
    const two = await live.send('thr_1', {
      text: 'Your call',
      effort: 'auto',
      idempotency_key: 'key-eff-00002',
    });
    await execute(two.run_id);
    // The open session had "high": it reopens without any effort, so Claude Code picks.
    expect(bridge.closed).toContain('h1');
    expect(bridge.opened).toHaveLength(2);
    expect(bridge.opened[1]?.effort).toBeUndefined();
    expect(bridge.controls.some((c) => c.op === 'set_effort')).toBe(false);
    expect((await live.state('thr_1')).effort).toBeNull();
  });

  it('edits the first message by starting a new session from the start, bound to the same thread', async () => {
    bridge.script = textAnswer(F, 'b1', 'A different start');
    const sent = await live.send('thr_1', {
      text: 'Fix the signup bug instead',
      parent_id: null,
      idempotency_key: 'key-first-0001',
    });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp).toMatchObject({ fresh: true, fork: false, resumeAt: null, sessionId: S });
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened[0]?.resume).toBeUndefined();
    expect(bridge.opened[0]?.cwd).toBe(CWD);

    const user = await threads.getMessage(sent.user_message_id);
    expect(user?.parent_id).toBeNull(); // a second root: a branch at the start
    expect((user?.provenance?.claude_code as { session_id?: string } | undefined)?.session_id).toBe(F);
    const answer = await threads.getMessage(cp.assistantMessageId);
    expect(answer).toMatchObject({ parent_id: sent.user_message_id, status: 'complete' });
    const t = await threads.getThread('thr_1');
    expect(t?.settings.claude_code?.session_id).toBe(S); // the thread's own session is unchanged
    expect(t?.active_head_id).toBe(cp.assistantMessageId);
    expect((await store.sessions(WS)).map((b) => [b.session_id, b.thread_id]).sort()).toEqual([
      [F, 'thr_1'],
      [S, 'thr_1'],
    ]);
    // The old first message is still there, with its answer.
    expect((await threads.getMessage('msg_a1'))?.parent_id).toBe('msg_u1');
  });
});

describe('the command list after a turn', () => {
  it('keeps one entry per name, the richest', async () => {
    bridge.script = textAnswer(S, 'a2', 'ok');
    const sent = await live.send('thr_1', { text: 'x', idempotency_key: 'key-cmd-00001' });
    await execute(sent.run_id);
    bridge.controlAnswers.supported_commands = [
      { name: 'review', description: '', argumentHint: '' },
      { name: 'review', description: 'Review a pull request', argumentHint: '[pr]' },
      { name: '/Deploy', description: 'Deploy' },
      { name: 'deploy', description: 'Deploy the app to staging', argumentHint: '<env>' },
      { name: 'compact', description: 'Compact', argumentHint: '<instructions>', builtin: true },
    ];
    const { items } = await live.commands('thr_1', { wait: true });
    expect(items.filter((c) => c.name.toLowerCase() === 'deploy')).toEqual([
      expect.objectContaining({
        name: 'deploy',
        description: 'Deploy the app to staging',
        argument_hint: '<env>',
      }),
    ]);
    expect(items.filter((c) => c.name === 'review')).toEqual([
      expect.objectContaining({ description: 'Review a pull request', argument_hint: '[pr]' }),
    ]);
    expect(new Set(items.map((c) => c.name.toLowerCase())).size).toBe(items.length);
  });

  it('keeps what NVX Ancile handles over a plain entry of the same name', () => {
    const plain = {
      name: 'mcp',
      description: 'x',
      argument_hint: null,
      arguments: [],
      source: 'skill' as const,
      handled_by: 'claude' as const,
      ancile_action: null,
    };
    const ours = {
      ...plain,
      description: '',
      source: 'builtin' as const,
      handled_by: 'ancile' as const,
      ancile_action: 'open_mcp' as const,
    };
    expect(dedupeCommands([plain, ours])).toEqual([ours]);
  });
});

describe('idle sessions', () => {
  const settled = async (id: string) =>
    runs.save({ ...((await runs.get(id)) as RunRecord), status: 'succeeded' }, { status: 'queued' });

  it('closes an idle session so its folder is let go, and resumes it on the next turn', async () => {
    live.stop();
    live = makeLive({ idleCloseMs: 40 });
    bridge.script = textAnswer(S, 'a2', 'One');
    const first = await live.send('thr_1', { text: 'One', idempotency_key: 'key-idle-0001' });
    expect(await execute(first.run_id)).toEqual({ kind: 'done' });
    await settled(first.run_id);
    expect(bridge.closed).toEqual([]);
    await until(() => bridge.closed.length === 1);
    expect(bridge.closed).toEqual(['h1']);
    expect((await live.state('thr_1')).state).toBe('idle');

    bridge.script = textAnswer(S, 'a3', 'Two');
    const second = await live.send('thr_1', { text: 'Two', idempotency_key: 'key-idle-0002' });
    expect(await execute(second.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened.map((o) => o.resume)).toEqual([S, S]);
  });

  it('keeps a session open while a turn is running', async () => {
    live.stop();
    live = makeLive({ idleCloseMs: 60 });
    bridge.script = textAnswer(S, 'a2', 'One');
    const a = await live.send('thr_1', { text: 'One', idempotency_key: 'key-idle-0003' });
    expect(await execute(a.run_id)).toEqual({ kind: 'done' });
    await settled(a.run_id);
    // A new turn starts before the idle close: the timer is cleared.
    bridge.script = (b, h, text, uuid) => {
      setTimeout(() => void textAnswer(S, 'a3', 'Two')(b, h, text, uuid), 150);
    };
    const b = await live.send('thr_1', { text: 'Two', idempotency_key: 'key-idle-0004' });
    expect(await execute(b.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened).toHaveLength(1);
  });
});

describe('a resumed session that writes the prompt under its own uuid', () => {
  it("takes the echoed prompt as the person's message, never a second one, and never shows the context block", async () => {
    const answer = textAnswer(S, 'a2', 'Hello world');
    bridge.script = (b, h, text, uuid) => {
      // Claude Code ignores the uuid it was given and echoes the prompt (context block and all).
      b.msg(h, {
        type: 'user',
        uuid: 'own-prompt-uuid',
        session_id: S,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: `<ancile-context>\nWhat other models said.\n</ancile-context>\n\n${text}`,
        },
      });
      return answer(b, h, text, uuid);
    };
    const sent = await live.send('thr_1', {
      text: 'Thanks, now add a test',
      idempotency_key: 'key-echo-0001',
    });
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    const msgs = await threads.messages('thr_1');
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(2);
    const user = await threads.getMessage(sent.user_message_id);
    expect(user?.parts).toEqual([{ type: 'text', text: 'Thanks, now add a test' }]);
    expect(user?.provenance?.claude_code).toMatchObject({ uuid: 'own-prompt-uuid' });
    expect(JSON.stringify(msgs)).not.toContain('ancile-context');
  });
});

describe("lean sessions (only the project's own Claude Code settings)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ancile-cc-lean-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const finish = async (runId: string) => {
    expect(await execute(runId)).toEqual({ kind: 'done' });
    await runs.save({ ...((await runs.get(runId)) as RunRecord), status: 'succeeded' }, { status: 'queued' });
  };

  it('starts a thread made in NVX Ancile lean, says what it saved, and keeps it on resume', async () => {
    const recorded: number[] = [];
    live.stop();
    live = makeLive({
      service: {
        ...service,
        notebookForFolder: async () => null,
        folderExcluded: async () => false,
        fullFirstTurn: async () => 162_000,
        recordFullFirstTurn: async (n) => {
          recorded.push(n);
        },
      },
    });
    const made = await live.createThread({ cwd: dir });
    expect((await threads.getThread(made.thread_id))?.settings.claude_code).toMatchObject({
      started_in: 'ancile',
    });

    const NEW = 'sess-lean-0001';
    bridge.script = textAnswer(NEW, 'n1', 'Hello');
    const sent = await live.send(made.thread_id, { text: 'Start here', idempotency_key: 'key-lean-0001' });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp.lean).toBe(true);
    await finish(sent.run_id);
    expect(bridge.opened[0]?.setting_sources).toEqual(['project']);
    const answer = await threads.getMessage(sent.assistant_message_id);
    expect((answer?.provenance?.claude_code as { setup?: unknown } | undefined)?.setup).toEqual({
      lean: true,
      first_turn: true,
      full_first_turn_tokens: 162_000,
    });
    // Binding the new session keeps the marker, so the next turn (a resume) is lean too.
    expect((await threads.getThread(made.thread_id))?.settings.claude_code).toMatchObject({
      session_id: NEW,
      started_in: 'ancile',
    });
    live.stop();
    live = makeLive();
    const opened = bridge.opened.length;
    bridge.script = textAnswer(NEW, 'n2', 'Again');
    const next = await live.send(made.thread_id, { text: 'Go on', idempotency_key: 'key-lean-0002' });
    expect(await execute(next.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened[opened]).toMatchObject({ resume: NEW, setting_sources: ['project'] });
    // Only a first turn that loaded the whole setup is remembered.
    expect(recorded).toEqual([]);
  });

  it('loads the whole setup for an imported thread until lean is turned on', async () => {
    // thr_1 was imported (no started_in): the person's whole setup, as in their terminal.
    bridge.script = textAnswer(S, 'a2', 'Hello');
    const sent = await live.send('thr_1', { text: 'Hi', idempotency_key: 'key-lean-0003' });
    await finish(sent.run_id);
    expect(bridge.opened[0]?.setting_sources).toBeUndefined();
    expect((await runs.get(sent.run_id))?.checkpoint).not.toHaveProperty('lean');

    // Turned on (PATCH /threads/:id with claude_code_lean): the open session reopens lean.
    const t = await threads.getThread('thr_1');
    await threads.patchThread('thr_1', {
      settings: { claude_code: { ...(t?.settings.claude_code as ClaudeCodeBinding), lean: true } },
    });
    bridge.script = textAnswer(S, 'a3', 'Lean now');
    const again = await live.send('thr_1', { text: 'And now', idempotency_key: 'key-lean-0004' });
    expect(await execute(again.run_id)).toEqual({ kind: 'done' });
    expect(bridge.opened.at(-1)).toMatchObject({ resume: S, setting_sources: ['project'] });
  });
});

describe('a tool result with its call, in a turn from NVX Ancile', () => {
  it('a notification between a call and its result: one answer holds both, with how long the step took', async () => {
    const at = (s: number) => new Date(NOW + s * 1000).toISOString();
    bridge.script = (b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S, model: 'claude-opus-5-5' });
      b.msg(h, {
        type: 'assistant',
        uuid: 'a3',
        session_id: S,
        parent_tool_use_id: null,
        timestamp: at(1),
        message: {
          id: 'api-a3',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm build' } }],
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      });
      b.msg(h, {
        type: 'user',
        uuid: 'n1',
        session_id: S,
        parent_tool_use_id: null,
        timestamp: at(2),
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>t9</task-id>\n<status>completed</status>\n<summary>Lint finished</summary>\n</task-notification>',
        },
      });
      b.msg(h, {
        type: 'user',
        uuid: 'r1',
        session_id: S,
        parent_tool_use_id: null,
        timestamp: at(4),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'built' }] },
      });
      b.msg(h, {
        type: 'assistant',
        uuid: 'a4',
        session_id: S,
        parent_tool_use_id: null,
        timestamp: at(5),
        message: {
          id: 'api-a4',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'Built.' }],
          usage: { input_tokens: 3, output_tokens: 7 },
        },
      });
      b.msg(h, { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, session_id: S });
    };
    const sent = await live.send('thr_1', { text: 'Build it', idempotency_key: 'key-stray-0001' });
    expect(await execute(sent.run_id)).toEqual({ kind: 'done' });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    const answer = await threads.getMessage(cp.assistantMessageId);
    expect(answer?.parts).toEqual([
      { type: 'tool_call', call_id: 'b1', tool: 'Bash', args: { command: 'pnpm build' } },
      { type: 'tool_result', call_id: 'b1', ok: true, result: 'built', duration_ms: 3000 },
    ]);
    const msgs = await threads.messages('thr_1');
    const note = msgs.find((m) => m.parent_id === cp.assistantMessageId);
    expect(note?.provenance?.claude_code).toMatchObject({
      kind: 'notification',
      uuids: ['n1', 'r1'],
      live: true,
    });
    const after = msgs.find((m) => m.parent_id === note?.id);
    expect(after).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'Built.' }] });
    expect((await threads.getThread('thr_1'))?.active_head_id).toBe(after?.id);
    // No answer of nothing but results.
    expect(msgs.filter((m) => m.parts.length && m.parts.every((p) => p.type === 'tool_result'))).toEqual([]);
  });
});

describe('monthly-credit sessions (CR1)', () => {
  const KEY = 'sk-ant-api03-CREDITKEYCREDITKEY0001';
  const finish = async (runId: string) => {
    expect(await execute(runId)).toEqual({ kind: 'done' });
    await runs.save({ ...((await runs.get(runId)) as RunRecord), status: 'succeeded' }, { status: 'queued' });
  };

  it('runs on the Anthropic key in that one session, never resumes a plan session, and never the reverse', async () => {
    live.stop();
    live = makeLive({ creditKey: async () => KEY });
    // thr_1 is bound to a session started on the plan.
    bridge.script = textAnswer('sess-credit-0001', 'c1', 'On the credit');
    const sent = await live.send('thr_1', {
      text: 'Use the credit',
      credit: true,
      idempotency_key: 'key-credit-001',
    });
    const cp = (await runs.get(sent.run_id))?.checkpoint as ClaudeCodeCheckpoint;
    expect(cp).toMatchObject({ credit: true, fresh: true, rebind: true });
    await finish(sent.run_id);
    const opened = bridge.opened.at(-1);
    expect(opened?.env?.ANTHROPIC_API_KEY).toBe(KEY);
    expect(opened).not.toHaveProperty('resume');
    const answer = await threads.getMessage(sent.assistant_message_id);
    expect(answer?.usage?.billing).toEqual({ kind: 'credit', payer: "Your plan's monthly API credit" });
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect((await threads.getThread('thr_1'))?.settings.claude_code).toMatchObject({
      session_id: 'sess-credit-0001',
      pay: 'credit',
    });

    // The next credit turn carries that session on: the open session is reused, not reopened.
    const openedBefore = bridge.opened.length;
    bridge.script = textAnswer('sess-credit-0001', 'c2', 'Still on the credit');
    const again = await live.send('thr_1', {
      text: 'And again',
      credit: true,
      idempotency_key: 'key-credit-002',
    });
    expect((await runs.get(again.run_id))?.checkpoint).toMatchObject({
      sessionId: 'sess-credit-0001',
      fork: false,
    });
    expect(
      ((await runs.get(again.run_id))?.checkpoint as ClaudeCodeCheckpoint | undefined)?.fresh,
    ).toBeFalsy();
    await finish(again.run_id);
    expect(bridge.opened).toHaveLength(openedBefore);

    // Back to the plan: a new session again, and the key is not in its environment.
    bridge.script = textAnswer('sess-plan-0002', 'c3', 'Back on the plan');
    const back = await live.send('thr_1', { text: 'Plan again', idempotency_key: 'key-credit-003' });
    expect((await runs.get(back.run_id))?.checkpoint).toMatchObject({ fresh: true, rebind: true });
    await finish(back.run_id);
    expect(bridge.opened.at(-1)?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(bridge.opened.at(-1)).not.toHaveProperty('resume');
    expect((await threads.getThread('thr_1'))?.settings.claude_code).toMatchObject({
      session_id: 'sess-plan-0002',
      pay: 'plan',
    });
  });

  it('refuses a monthly-credit turn when no Anthropic key is saved', async () => {
    live.stop();
    live = makeLive({ creditKey: async () => null });
    bridge.script = textAnswer('sess-credit-0009', 'c9', 'never');
    const sent = await live.send('thr_1', {
      text: 'Use the credit',
      credit: true,
      idempotency_key: 'key-credit-009',
    });
    const outcome = await execute(sent.run_id);
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(bridge.opened.some((o) => o.env?.ANTHROPIC_API_KEY)).toBe(false);
  });
});
