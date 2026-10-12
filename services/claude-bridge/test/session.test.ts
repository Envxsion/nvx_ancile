/**
 * Live sessions with a fake Agent SDK: query() is scripted, so no Claude
 * Code runs. Every tool call is asked about through the PreToolUse hook
 * and canUseTool, answered by "Core" (the test) or by the timeout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type {
  ClaudeAgentSdk,
  SdkHookCallback,
  SdkQuery,
  SdkQueryOptions,
  SdkUserMessage,
} from '../src/sdk-types';
import { handleSession, openParams, type RunningBridge, startServer } from '../src/server';
import { inputQueue, NO_ANSWER, SessionManager } from '../src/session';

interface Script {
  /** What happens for each user message sent. */
  turn(msg: SdkUserMessage, opts: SdkQueryOptions, out: (m: unknown) => void): Promise<void>;
}

interface FakeQuery extends SdkQuery {
  opts: SdkQueryOptions;
  calls: string[];
  closed: boolean;
}

function fakeSdk(script: Script, made: FakeQuery[] = []): ClaudeAgentSdk & { made: FakeQuery[] } {
  const base = {
    listSessions: async () => [],
    getSessionInfo: async () => undefined,
    getSessionMessages: async () => [],
    listSubagents: async () => [],
    getSubagentMessages: async () => [],
  };
  return {
    ...base,
    made,
    query({ prompt, options }: { prompt: AsyncIterable<SdkUserMessage>; options?: SdkQueryOptions }) {
      const opts = options ?? {};
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      const out = (m: unknown) => {
        queue.push(m);
        wake?.();
      };
      const q: FakeQuery = {
        opts,
        calls: [],
        closed: false,
        async interrupt() {
          q.calls.push('interrupt');
          out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'S1' });
        },
        async setPermissionMode(m) {
          q.calls.push(`mode:${m}`);
        },
        async setModel(m) {
          q.calls.push(`model:${m}`);
        },
        async setMaxThinkingTokens() {
          q.calls.push('thinking');
        },
        async applyFlagSettings(s) {
          q.calls.push(`flags:${JSON.stringify(s)}`);
        },
        async supportedCommands() {
          return [{ name: 'compact', description: 'Compact', argumentHint: '', builtin: true }];
        },
        async supportedModels() {
          return [{ value: 'opus', displayName: 'Opus', description: '' }];
        },
        async mcpServerStatus() {
          return [{ name: 'ancile', status: 'connected' }];
        },
        async getContextUsage() {
          return { totalTokens: 1000, maxTokens: 200_000, percentage: 0.5, model: 'opus' };
        },
        async rewindFiles() {
          return { canRewind: true };
        },
        close() {
          q.closed = true;
          finished = true;
          wake?.();
        },
        async *[Symbol.asyncIterator]() {
          void (async () => {
            for await (const msg of prompt) await script.turn(msg, opts, out);
            finished = true;
            wake?.();
          })();
          out({
            type: 'system',
            subtype: 'init',
            session_id: 'S1',
            model: 'opus',
            permissionMode: 'default',
          });
          while (true) {
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            if (finished) return;
            await new Promise<void>((r) => {
              wake = r;
            });
            wake = null;
          }
        },
      };
      made.push(q);
      return q;
    },
  } as unknown as ClaudeAgentSdk & { made: FakeQuery[] };
}

const hookOf = (o: SdkQueryOptions): SdkHookCallback => {
  const h = o.hooks?.PreToolUse?.[0]?.hooks[0];
  if (!h) throw new Error('no PreToolUse hook');
  return h;
};

const OPEN = { cwd: 'C:\\code\\app', path_to_cli: 'C:\\claude.exe' };

/** A turn that uses Bash once and answers. */
const bashScript = (record: { hook?: unknown; can?: unknown }): Script => ({
  async turn(msg, opts, out) {
    const signal = new AbortController().signal;
    record.hook = await hookOf(opts)(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' },
      't1',
      { signal },
    );
    const hook = record.hook as { hookSpecificOutput?: { permissionDecision?: string } };
    if (hook.hookSpecificOutput?.permissionDecision === 'allow' && opts.canUseTool)
      record.can = await opts.canUseTool('Bash', { command: 'ls' }, { signal, toolUseID: 't1' });
    out({
      type: 'assistant',
      uuid: 'a1',
      session_id: 'S1',
      parent_tool_use_id: null,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: `re: ${msg.uuid}` }] },
    });
    out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, session_id: 'S1' });
  },
});

function collector() {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const push = (event: string, data: unknown) =>
    events.push({ event, data: data as Record<string, unknown> });
  const next = async (pred: (e: { event: string; data: Record<string, unknown> }) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('event never came');
  };
  return { events, push, next };
}

describe('the input queue', () => {
  it('yields what was pushed, in order, and ends when told', async () => {
    const q = inputQueue();
    const got: string[] = [];
    const done = (async () => {
      for await (const m of q.iterable) got.push(m.uuid ?? '');
    })();
    q.push({
      type: 'user',
      message: { role: 'user', content: 'a' },
      parent_tool_use_id: null,
      uuid: '1',
      session_id: '',
    });
    q.push({
      type: 'user',
      message: { role: 'user', content: 'b' },
      parent_tool_use_id: null,
      uuid: '2',
      session_id: '',
    });
    q.end();
    await done;
    expect(got).toEqual(['1', '2']);
  });
});

describe('live sessions', () => {
  let mgr: SessionManager | null = null;
  afterEach(() => mgr?.closeAll());

  it('opens a streaming-input query with what Core asked for, and nothing that skips asking', async () => {
    const sdk = fakeSdk(bashScript({}));
    mgr = new SessionManager({ load: async () => sdk });
    const c = collector();
    await mgr.openSession(
      openParams({
        ...OPEN,
        resume: 'S0',
        fork: true,
        resume_at: 'u9',
        model: 'opus',
        append_system_prompt: 'You are running inside NVX Ancile.',
        mcp_servers: {
          ancile: {
            type: 'http',
            url: 'http://127.0.0.1:1/mcp/claude',
            headers: { authorization: 'Bearer x' },
          },
        },
        env: { DISABLE_TELEMETRY: '1' },
      }),
      c.push,
    );
    const o = sdk.made[0]?.opts as SdkQueryOptions;
    expect(o).toMatchObject({
      cwd: OPEN.cwd,
      pathToClaudeCodeExecutable: OPEN.path_to_cli,
      resume: 'S0',
      forkSession: true,
      resumeSessionAt: 'u9',
      model: 'opus',
      permissionMode: 'default',
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are running inside NVX Ancile.' },
      mcpServers: { ancile: { type: 'http', url: 'http://127.0.0.1:1/mcp/claude' } },
    });
    expect(o.env?.DISABLE_TELEMETRY).toBe('1');
    expect(typeof o.canUseTool).toBe('function');
    expect(() => openParams({ ...OPEN, mcp_servers: { x: { type: 'stdio', command: 'evil' } } })).toThrow(
      /http/,
    );
    // Claude Code as a model: every built-in tool off, none of the person's settings.
    expect(openParams({ ...OPEN, tools: [], setting_sources: [] })).toMatchObject({
      tools: [],
      setting_sources: [],
    });
    expect(() => openParams({ ...OPEN, tools: 'Bash' })).toThrow(/tool names/);
    expect(() => openParams({ ...OPEN, setting_sources: ['everything'] })).toThrow(/setting_sources/);
    await expect(
      mgr.openSession(openParams({ ...OPEN, permission_mode: 'bypassPermissions' }), c.push),
    ).rejects.toThrow(/not offered/);
  });

  it('asks Core about every tool call, on its real input, and carries the answer back', async () => {
    const rec: { hook?: unknown; can?: unknown } = {};
    const sdk = fakeSdk(bashScript(rec));
    mgr = new SessionManager({ load: async () => sdk });
    const c = collector();
    const { handle } = await mgr.openSession(openParams(OPEN), c.push);
    mgr.send(handle, 'list the files', { uuid: 'p1' });
    const ask = await c.next((e) => e.event === 'session.permission');
    expect(ask.data).toMatchObject({
      handle,
      tool_name: 'Bash',
      input: { command: 'ls' },
      tool_use_id: 't1',
      via: 'hook',
    });
    expect(
      mgr.reply(handle, ask.data.request_id, { behavior: 'allow', updated_input: { command: 'ls -la' } }),
    ).toBe(true);
    await c.next(
      (e) => e.event === 'session.message' && (e.data.message as { type: string }).type === 'result',
    );
    expect(rec.hook).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'ls -la' },
      },
    });
    // canUseTool after the hook reuses the answer: one question, not two.
    expect(rec.can).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' }, toolUseID: 't1' });
    expect(c.events.filter((e) => e.event === 'session.permission')).toHaveLength(1);
    const types = c.events
      .filter((e) => e.event === 'session.message')
      .map((e) => (e.data.message as { type: string }).type);
    expect(types).toEqual(['system', 'assistant', 'result']);
    // The prompt went in with Ancile's uuid.
    const answer = c.events.find((e) => (e.data.message as { type?: string })?.type === 'assistant');
    expect(JSON.stringify(answer?.data.message)).toContain('re: p1');
    const states = c.events.filter((e) => e.event === 'session.state').map((e) => e.data.state);
    expect(states).toEqual(['ready', 'working', 'ready']);
  });

  it('denies with the reason Core gives', async () => {
    const rec: { hook?: unknown } = {};
    mgr = new SessionManager({ load: async () => fakeSdk(bashScript(rec)) });
    const c = collector();
    const { handle } = await mgr.openSession(openParams(OPEN), c.push);
    mgr.send(handle, 'go');
    const ask = await c.next((e) => e.event === 'session.permission');
    mgr.reply(handle, ask.data.request_id, {
      behavior: 'deny',
      message: 'A policy blocks this (balanced.shell-dangerous).',
    });
    await c.next((e) => (e.data.message as { type?: string })?.type === 'result');
    expect(rec.hook).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'A policy blocks this (balanced.shell-dangerous).',
      },
    });
  });

  it('denies when Core does not answer in time', async () => {
    const rec: { hook?: unknown } = {};
    mgr = new SessionManager({ load: async () => fakeSdk(bashScript(rec)), permissionTimeoutMs: 30 });
    const c = collector();
    const { handle } = await mgr.openSession(openParams(OPEN), c.push);
    mgr.send(handle, 'go');
    await c.next((e) => (e.data.message as { type?: string })?.type === 'result');
    expect(rec.hook).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: NO_ANSWER },
    });
  });

  it('runs control ops, interrupts, and closes sessions whose connection went away', async () => {
    const sdk = fakeSdk(bashScript({}));
    mgr = new SessionManager({ load: async () => sdk });
    const c = collector();
    const owner = {};
    const { handle } = await mgr.openSession(openParams(OPEN), c.push, owner);
    await mgr.control(handle, 'set_model', { model: 'sonnet' });
    await mgr.control(handle, 'set_effort', { effort: 'high' });
    await mgr.control(handle, 'set_permission_mode', { mode: 'plan' });
    await expect(mgr.control(handle, 'set_permission_mode', { mode: 'bypassPermissions' })).rejects.toThrow();
    expect(await mgr.control(handle, 'supported_commands')).toEqual([
      { name: 'compact', description: 'Compact', argumentHint: '', builtin: true },
    ]);
    expect(await mgr.control(handle, 'context_usage')).toEqual({
      total_tokens: 1000,
      max_tokens: 200_000,
      percentage: 0.5,
      model: 'opus',
      compacts_at: null,
    });
    // The fake SDK has no experimental usage method: a clear error, never a crash.
    await expect(mgr.control(handle, 'usage')).rejects.toThrow(/does not report plan usage/);
    await mgr.interrupt(handle);
    const q = sdk.made[0] as FakeQuery;
    expect(q.calls).toEqual(['model:sonnet', 'flags:{"effortLevel":"high"}', 'mode:plan', 'interrupt']);
    await expect(mgr.control('nope', 'set_model')).rejects.toThrow(/handle/);
    expect(mgr.closeOwnedBy(owner)).toBe(1);
    expect(q.closed).toBe(true);
    expect(mgr.open).toBe(0);
    await c.next((e) => e.event === 'session.state' && e.data.state === 'closed');
  });

  it('closes a session left idle', async () => {
    mgr = new SessionManager({ load: async () => fakeSdk(bashScript({})), idleMs: 20 });
    const c = collector();
    await mgr.openSession(openParams(OPEN), c.push);
    await c.next((e) => e.event === 'session.state' && e.data.state === 'closed');
    expect(mgr.open).toBe(0);
  });
});

describe('over the socket', () => {
  const TOKEN = 't'.repeat(32);
  let server: RunningBridge;
  afterEach(async () => {
    await server?.close();
  });

  it('offers live sessions to protocol 2 only, and pushes their events on that connection', async () => {
    const sdk = fakeSdk(bashScript({}));
    server = await startServer({
      token: TOKEN,
      sdk: { load: async () => sdk, status: () => ({ ready: true, version: 'x', error: null }) },
    });
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${server.port}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    const reply = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        const f = frames.find((x) => x.id === id);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('no reply');
    };
    ws.send(JSON.stringify({ id: 1, op: 'hello', params: { protocol: 1 } }));
    expect(await reply(1)).toMatchObject({ ok: true, result: { protocol: 1 } });
    ws.send(JSON.stringify({ id: 2, op: 'session.open', params: OPEN }));
    expect(await reply(2)).toMatchObject({ ok: false, error: { code: 'unknown_op' } });
    ws.send(JSON.stringify({ id: 3, op: 'hello', params: { protocol: 2 } }));
    expect(await reply(3)).toMatchObject({ ok: true, result: { protocol: 2 } });
    ws.send(JSON.stringify({ id: 4, op: 'session.open', params: OPEN }));
    const opened = (await reply(4)) as { result: { handle: string } };
    ws.send(
      JSON.stringify({ id: 5, op: 'session.send', params: { handle: opened.result.handle, text: 'hi' } }),
    );
    await reply(5);
    for (let i = 0; i < 200 && !frames.some((f) => f.event === 'session.permission'); i++)
      await new Promise((r) => setTimeout(r, 5));
    const ask = frames.find((f) => f.event === 'session.permission') as { data: { request_id: string } };
    ws.send(
      JSON.stringify({
        id: 6,
        op: 'session.permission_reply',
        params: { handle: opened.result.handle, request_id: ask.data.request_id, behavior: 'allow' },
      }),
    );
    expect(await reply(6)).toMatchObject({ ok: true, result: { delivered: true } });
    ws.close();
  });

  it('checks session ops', async () => {
    const mgr = new SessionManager({ load: async () => fakeSdk(bashScript({})) });
    await expect(
      handleSession(mgr, 'session.send', { handle: 'h', text: '' }, () => undefined, null),
    ).rejects.toThrow(/text/);
    await expect(
      handleSession(
        mgr,
        'session.permission_reply',
        { handle: 'h', behavior: 'maybe' },
        () => undefined,
        null,
      ),
    ).rejects.toThrow(/allow or deny/);
    await expect(
      handleSession(mgr, 'session.interrupt', { handle: 'h' }, () => undefined, null),
    ).rejects.toMatchObject({
      code: 'unknown_handle',
    });
  });
});
