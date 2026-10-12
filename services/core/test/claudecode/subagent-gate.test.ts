/**
 * Track G: a Claude Code subagent's tool calls (the Task tool) pass the same
 * gate as the parent session. The bridge's PreToolUse hook asks NVX Ancile
 * about every call, a subagent's included, with the subagent's agent_id; Core
 * must decide it as agent:claude-code, on the real arguments, with the same
 * mapping, grants and floors. Launching the subagent itself is bookkeeping
 * and runs; what the subagent then does is checked.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  LiveBridge,
  LiveControlOp,
  LiveEvent,
  LiveOpenParams,
  LivePermissionReply,
} from '../../src/claudecode/bridge-protocol';
import { ClaudeCodeLive, type LiveServiceView } from '../../src/claudecode/live';
import { MAPPER_VERSION } from '../../src/claudecode/map';
import { CLAUDE_CODE_PRINCIPAL } from '../../src/claudecode/permission-map';
import { MemoryClaudeCodeStore } from '../../src/claudecode/store';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate, type GateRequest } from '../../src/permissions/gate';
import { type ApprovalRecord, MemoryPermissionStore } from '../../src/permissions/store';
import type { RunContext } from '../../src/runs/engine';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_01TESTWORKSPACE000000000000';
const CWD = join(tmpdir(), 'ancile-cc-subagent', 'app');
const S = 'sess-sub-0001';

class FakeBridge implements LiveBridge {
  replies: { request_id: string; r: LivePermissionReply }[] = [];
  script: (b: FakeBridge, handle: string) => void = () => undefined;
  private listeners = new Set<(e: LiveEvent) => void>();
  async open(_p: LiveOpenParams) {
    return { handle: 'h1' };
  }
  async send(handle: string) {
    setTimeout(() => this.script(this, handle), 0);
  }
  async interrupt() {}
  async control<T>(_h: string, _op: LiveControlOp) {
    return { ok: true } as T;
  }
  async close() {}
  async reply(_h: string, requestId: string, r: LivePermissionReply) {
    this.replies.push({ request_id: requestId, r });
  }
  onEvent(fn: (e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  setKeepAlive() {}
  push(e: LiveEvent) {
    for (const fn of this.listeners) fn(e);
  }
  msg(handle: string, message: Record<string, unknown>) {
    this.push({ event: 'session.message', data: { handle, message } });
  }
  /** A permission ask, from the parent (no agent id) or from a subagent. */
  ask(handle: string, id: string, tool: string, input: unknown, agentId?: string) {
    this.push({
      event: 'session.permission',
      data: {
        handle,
        request_id: id,
        tool_name: tool,
        input,
        tool_use_id: `tu-${id}`,
        ...(agentId && { agent_id: agentId }),
        via: 'hook',
      },
    });
  }
}

const service: LiveServiceView = {
  cliPath: async () => ({ path: 'C:\\claude.exe', version: '2.1.286' }),
  cliEnv: async () => ({}),
  syncSession: async () => ({ thread_id: 'x', added: 0, notebook_id: null }),
  transcriptModified: async () => null,
  setLiveGuard: () => undefined,
};

let threads: MemoryThreadRepo;
let runs: MemoryRunStore;
let perms: MemoryPermissionStore;
let bridge: FakeBridge;
let live: ClaudeCodeLive;
let checked: GateRequest[];

const until = async (pred: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
};

beforeEach(async () => {
  threads = new MemoryThreadRepo();
  const store = new MemoryClaudeCodeStore(threads);
  runs = new MemoryRunStore();
  perms = new MemoryPermissionStore();
  bridge = new FakeBridge();
  checked = [];
  live = new ClaudeCodeLive({
    workspaceId: WS,
    userId: 'usr_1',
    bridge,
    service,
    sessionInfo: async (id) => ({ sessionId: id, summary: 't', lastModified: 1, cwd: CWD }),
    threads,
    store,
    runs,
    events: new MemoryRunEventLog(),
    worker: { kick: () => undefined },
    permissions: perms,
    gateFor: (root) => {
      const gate = createGate({ policy: new BuiltinPolicy(), store: perms, workspaceRoot: root });
      return {
        check: (req) => {
          checked.push(req);
          return gate.check(req);
        },
      };
    },
    notebook: async () => ({ title: 'app', grounded: false }),
    folderExists: async () => true,
  });
  await threads.createThread({
    id: 'thr_1',
    workspace_id: WS,
    title: 'Refactor',
    settings: {
      claude_code: { session_id: S, cwd: CWD, last_uuid: null, synced_at: new Date().toISOString() },
    },
  });
  await store.putSession(WS, {
    session_id: S,
    thread_id: 'thr_1',
    title: 'Refactor',
    cwd: CWD,
    last_modified: 1,
    synced_at: new Date().toISOString(),
    mapper_version: MAPPER_VERSION,
  });
});

afterEach(() => live.stop());

async function run(script: (b: FakeBridge, h: string) => void) {
  bridge.script = script;
  const sent = await live.send('thr_1', {
    text: 'Refactor with a subagent',
    idempotency_key: `k-${Math.random()}`,
  });
  const r = (await runs.get(sent.run_id)) as NonNullable<Awaited<ReturnType<typeof runs.get>>>;
  const ctx: RunContext = {
    run: r,
    events: new MemoryRunEventLog(),
    signal: new AbortController().signal,
    checkpoint: async () => undefined,
    once: async (_seq, _kind, _input, effect) => effect(),
  };
  return live.handler().execute(ctx);
}

describe('Claude Code subagents', () => {
  it('pass the same gate as the parent: same principal, mapping, grants and asks', async () => {
    // A remembered "always deny" for rm: it must hold inside the subagent too.
    await perms.createGrant({
      userId: 'usr_1',
      principal: CLAUDE_CODE_PRINCIPAL,
      actionPattern: 'shell.exec',
      resourcePattern: 'shell:rm *',
      effect: 'deny',
      scope: 'always',
      scopeRef: null,
      expiresAt: null,
      fromApprovalId: null,
    });
    const done = run((b, h) => {
      b.msg(h, { type: 'system', subtype: 'init', session_id: S });
      // The parent launches a subagent: bookkeeping, it runs.
      b.ask(h, 'r0', 'Task', {
        description: 'Clean up',
        prompt: 'Remove the build folder',
        subagent_type: 'general-purpose',
      });
      // The subagent's own calls, with its agent id.
      b.ask(h, 'r1', 'Bash', { command: 'rm -rf build' }, 'agent-7');
      b.ask(h, 'r2', 'Read', { file_path: join(CWD, 'src', 'a.ts') }, 'agent-7');
      b.ask(h, 'r3', 'Write', { file_path: join(tmpdir(), 'elsewhere', 'x.md'), content: 'x' }, 'agent-7');
    });
    await until(() => bridge.replies.length >= 3);
    const by = Object.fromEntries(bridge.replies.map((x) => [x.request_id, x.r]));
    expect(by.r0).toMatchObject({ behavior: 'allow' });
    expect(by.r1).toMatchObject({ behavior: 'deny', message: 'You chose to always deny this' });
    expect(by.r2).toMatchObject({ behavior: 'allow' });

    // Every call, the subagent's included, went through the gate as Claude Code, on its real arguments.
    expect(checked.map((c) => [c.tool, c.principal, c.action])).toEqual([
      ['Task', CLAUDE_CODE_PRINCIPAL, 'claude_code.Task'],
      ['Bash', CLAUDE_CODE_PRINCIPAL, 'shell.exec'],
      ['Read', CLAUDE_CODE_PRINCIPAL, 'fs.read'],
      ['Write', CLAUDE_CODE_PRINCIPAL, 'fs.write'],
    ]);
    expect(checked[1]).toMatchObject({ resource: 'shell:rm -rf build', args: { command: 'rm -rf build' } });

    // A write outside the folder from the subagent is critical and waits for you, as from the parent.
    await until(async () => (await perms.pendingApprovals()).length === 1);
    const a = (await perms.pendingApprovals())[0] as ApprovalRecord;
    expect(a).toMatchObject({ principal: CLAUDE_CODE_PRINCIPAL, tool: 'Write', tier: 'critical' });
    await live.resolved(a, 'denied', 'Not there');
    bridge.msg('h1', { type: 'result', subtype: 'success', is_error: false, session_id: S });
    await done;
  });
});
