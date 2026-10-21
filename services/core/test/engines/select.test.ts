/**
 * Choosing an engine per message, the scope check before anything runs,
 * Claude Code as a model (Mode A) through the gateway's routing client,
 * and the Pro seam keeping it out of Beam and the Flow lab without Pro.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveScope, ModelConfig } from '@nvx/contracts';
import { ClassifiedError } from '@nvx/resilience';
import { describe, expect, it } from 'vitest';
import type {
  LiveBridge,
  LiveEvent,
  LiveOpenParams,
  LivePermissionReply,
} from '../../src/claudecode/bridge-protocol';
import { Engines } from '../../src/engines';
import {
  ClaudeCodeModelClient,
  claudeCodeModels,
  promptOf,
  syncClaudeCodeModels,
} from '../../src/engines/mode-a';
import { isLocalModel, selectEngine } from '../../src/engines/select';
import type { Engine } from '../../src/engines/types';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import { DEFAULT_SCOPE, resolveScope } from '../../src/scopes';
import type { ThreadRecord } from '../../src/threads/repo';

const gpt = { id: 'openai/gpt-5', provider: 'openai', via: 'direct' } as ModelConfig;
const llama = { id: 'ollama/llama3', provider: 'ollama', via: 'direct' } as ModelConfig;
const registry = {
  get: (id: string) => [gpt, llama, ...claudeCodeModels()].find((m) => m.id === id),
  chain: () => [gpt],
};
const thread = (settings: ThreadRecord['settings'] = {}, notebook: string | null = null) =>
  ({ id: 'thr_1', workspace_id: 'w', notebook_id: notebook, settings }) as ThreadRecord;
const bound = { claude_code: { session_id: 'S', cwd: '/c/app', last_uuid: null, synced_at: '' } };

describe('choosing an engine', () => {
  it('carries a bound thread on in Claude Code unless another model is asked for', () => {
    expect(selectEngine(thread(bound), undefined, { registry })).toMatchObject({
      engine: 'claude_code',
      mode: 'session',
      engineModel: null,
    });
    expect(selectEngine(thread(bound), 'claude-code/opus', { registry })).toMatchObject({
      mode: 'session',
      engineModel: 'opus',
    });
    expect(selectEngine(thread(bound), 'openai/gpt-5', { registry })).toMatchObject({
      engine: 'gateway',
      local: false,
    });
  });

  it('picks the credit variant of a bound session with the plain model name (CR1)', () => {
    expect(selectEngine(thread(bound), 'claude-code/opus@credit', { registry })).toMatchObject({
      mode: 'session',
      engineModel: 'opus',
      credit: true,
    });
    expect(selectEngine(thread(bound), 'claude-code/opus', { registry })).not.toHaveProperty('credit');
  });

  it('answers claude-code models elsewhere as a model through the gateway (Mode A)', () => {
    expect(selectEngine(thread(), 'claude-code/sonnet', { registry })).toMatchObject({
      engine: 'claude_code',
      mode: 'model',
    });
    expect(selectEngine(thread(), null, { registry })).toMatchObject({
      engine: 'gateway',
      checkModel: 'openai/gpt-5',
    });
    expect(selectEngine(thread(), 'ollama/llama3', { registry }).local).toBe(true);
    expect(isLocalModel({ provider: 'openai', via: 'direct', base_url: 'http://127.0.0.1:8000/v1' })).toBe(
      true,
    );
  });

  it('lets a turn with no route through a local-only scope, for a flow of local steps to answer', () => {
    const none = {
      get: () => undefined,
      chain: () => {
        throw new Error('no route');
      },
    } as never;
    expect(selectEngine(thread(), null, { registry: none })).toMatchObject({ checkModel: null, local: true });
    // A model id NVX Ancile does not know is never taken for local.
    expect(selectEngine(thread(), 'mystery/model', { registry: none }).local).toBe(false);
  });

  it('counts a GPU node on your network as local, and a rented pod as not', () => {
    expect(isLocalModel({ provider: 'node', via: 'controller', runs_on: 'your_network' })).toBe(true);
    expect(isLocalModel({ provider: 'node', via: 'controller', runs_on: 'rented' })).toBe(false);
    for (const runs_on of ['rented', 'your_network'] as const) {
      const m = { id: 'node/qwen', provider: 'node', via: 'controller', runs_on } as ModelConfig;
      const r = { get: () => m, chain: () => [m] } as never;
      expect(selectEngine(thread(), 'node/qwen', { registry: r }).local).toBe(runs_on === 'your_network');
    }
  });
});

const fakeEngine = (id: string): Engine & { started: number } => ({
  id,
  kind: id,
  displayName: id,
  modelPrefix: null,
  started: 0,
  capabilities: () => ({
    streaming: true,
    tools: true,
    images: false,
    own_context: false,
    context_window: null,
  }),
  status: async () => ({ available: true, reason: null }),
  async start(t) {
    this.started++;
    return {
      run_id: 'run_1',
      user_message_id: 'msg_u',
      assistant_message_id: null,
      model_id: t.requestedModelId,
    };
  },
});

describe('the scope is checked before anything runs', () => {
  const scope = (priv: boolean, patch: Partial<EffectiveScope['scope']> = {}) =>
    resolveScope({ notebookId: 'nb', threadId: 'thr_1', private: priv, notebook: patch, thread: null });

  it('refuses Claude Code in a private notebook with an AncileError', async () => {
    const gw = fakeEngine('gateway');
    const cc = fakeEngine('claude_code');
    const engines = new Engines({ registry, gateway: gw, claudeCode: cc, scopeOf: async () => scope(true) });
    await expect(
      engines.send(thread(bound, 'nb'), {
        text: 'hi',
        parentId: undefined,
        model: null,
        idempotencyKey: 'k-000001',
      }),
    ).rejects.toMatchObject({ code: 'scope.private_notebook', status: 403 });
    expect(cc.started).toBe(0);
    // A local model still answers there.
    const ok = await engines.send(thread(bound, 'nb'), {
      text: 'hi',
      parentId: undefined,
      model: 'ollama/llama3',
      idempotencyKey: 'k-000002',
    });
    expect(ok).toMatchObject({ engine: 'gateway', model_id: 'ollama/llama3', context_notice: null });
    expect(gw.started).toBe(1);
  });

  it('sends a bound thread to Claude Code when allowed', async () => {
    const gw = fakeEngine('gateway');
    const cc = fakeEngine('claude_code');
    const engines = new Engines({
      registry,
      gateway: gw,
      claudeCode: cc,
      scopeOf: async () =>
        resolveScope({ notebookId: null, threadId: null, private: false, notebook: null, thread: null }),
    });
    const r = await engines.send(thread(bound), {
      text: 'go on',
      parentId: undefined,
      model: 'claude-code/opus',
      idempotencyKey: 'k-000003',
    });
    expect(r.engine).toBe('claude_code');
    expect(cc.started).toBe(1);
    expect(DEFAULT_SCOPE.engines).toBeNull();
  });
});

class Bridge implements LiveBridge {
  /** What the session's result says; the default is a normal success. */
  result: Record<string, unknown> = { subtype: 'success', is_error: false };
  /** Messages the session writes before its answer (Claude Code's own error, as an assistant message). */
  before: Record<string, unknown>[] = [];
  opened: LiveOpenParams[] = [];
  sent: string[] = [];
  /** The images that went with each prompt (HO1). */
  images: { mime: string; data: string }[][] = [];
  replies: LivePermissionReply[] = [];
  closed: string[] = [];
  private fns = new Set<(e: LiveEvent) => void>();
  async open(p: LiveOpenParams) {
    this.opened.push(p);
    return { handle: 'hA' };
  }
  async send(handle: string, text: string, opts?: { images?: { mime: string; data: string }[] }) {
    this.sent.push(text);
    if (opts?.images) this.images.push(opts.images);
    setTimeout(() => {
      this.push({
        event: 'session.permission',
        data: {
          handle,
          request_id: 'r1',
          tool_name: 'Bash',
          input: { command: 'ls' },
          tool_use_id: 't1',
          via: 'hook',
        },
      });
      this.push({
        event: 'session.permission',
        data: {
          handle,
          request_id: 'r2',
          tool_name: 'mcp__ancile__search',
          input: { query: 'x' },
          tool_use_id: 't2',
          via: 'hook',
        },
      });
      for (const m of this.before) this.msg(handle, m);
      for (const d of this.before.length ? [] : ['Hel', 'lo'])
        this.msg(handle, {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: d } },
        });
      setTimeout(
        () =>
          this.msg(handle, {
            type: 'result',
            ...this.result,
            usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 40 },
          }),
        20,
      );
    }, 0);
  }
  async interrupt() {}
  async control<T>() {
    return {} as T;
  }
  async close(h: string) {
    this.closed.push(h);
  }
  async reply(_h: string, _id: string, r: LivePermissionReply) {
    this.replies.push(r);
  }
  onEvent(fn: (e: LiveEvent) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  setKeepAlive() {}
  push(e: LiveEvent) {
    for (const f of this.fns) f(e);
  }
  msg(handle: string, message: Record<string, unknown>) {
    this.push({ event: 'session.message', data: { handle, message } });
  }
}

describe('Claude Code as a model (Mode A)', () => {
  it('is offered only while Claude Code is installed and verified', () => {
    let set: ModelConfig[] = [];
    const reg = { setProviderModels: (_p: string, m: ModelConfig[]) => (set = m) };
    expect(
      syncClaudeCodeModels(reg, {
        installed: true,
        version_ok: true,
        verification: { state: 'verified', error: null },
      }),
    ).toBe(true);
    expect(set.map((m) => m.id)).toContain('claude-code/opus');
    expect(set.every((m) => m.provider === 'claude_code' && m.price.input_per_mtok === 0)).toBe(true);
    syncClaudeCodeModels(reg, {
      installed: true,
      version_ok: true,
      verification: { state: 'failed', error: 'x' },
    });
    expect(set).toEqual([]);
  });

  it('is one Claude Code turn with built-in tools off; only Ancile tools, through the gate', async () => {
    const bridge = new Bridge();
    const handles = new Set<string>();
    const perms = new MemoryPermissionStore();
    const client = new ClaudeCodeModelClient({
      bridge,
      cli: async () => ({ path: 'claude', version: '2.1.300' }),
      env: async () => ({}),
      cwd: join(tmpdir(), 'ancile-claude-model'),
      mcp: { url: 'http://127.0.0.1:9/mcp/claude', secret: 's'.repeat(32) },
      gate: (root) => createGate({ policy: new BuiltinPolicy(), store: perms, workspaceRoot: root }),
      userId: 'usr_1',
      workspaceId: 'w',
      handles,
    });
    const model = claudeCodeModels().find((m) => m.id === 'claude-code/sonnet') as ModelConfig;
    const chunks = [];
    for await (const c of client.stream(
      model,
      {
        system: 'Be brief.',
        messages: [{ role: 'user', content: 'Say hello' }],
        meta: { threadId: 'thr_1', notebookId: 'nb' },
      },
      new AbortController().signal,
    ))
      chunks.push(c);
    expect(bridge.opened[0]).toMatchObject({
      persist: false,
      tools: [],
      setting_sources: [],
      strict_mcp: true,
      model: 'sonnet',
      append_system_prompt: 'Be brief.',
    });
    // The account's claude.ai connectors never ride along (they once added ~280k tokens).
    expect(bridge.opened[0]?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(bridge.opened[0]?.mcp_servers?.ancile?.headers?.authorization).toMatch(/^Bearer thr_1\./);
    expect(bridge.sent).toEqual(['Say hello']);
    expect(
      chunks
        .filter((c) => c.type === 'text')
        .map((c) => (c as { delta: string }).delta)
        .join(''),
    ).toBe('Hello');
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      usage: { inputTokens: 7, outputTokens: 2, cachedTokens: 40 },
    });
    expect(bridge.replies[0]).toMatchObject({ behavior: 'deny' }); // Bash: built-ins are off
    expect(bridge.replies[1]).toMatchObject({ behavior: 'allow' }); // the notebook's search
    expect(handles.size).toBe(0);
    expect(bridge.closed).toEqual(['hA']);
  });

  it('passes the conversation images to Claude as image input (HO1)', async () => {
    const bridge = new Bridge();
    const client = new ClaudeCodeModelClient({
      bridge,
      cli: async () => ({ path: 'claude', version: '2.1.300' }),
      env: async () => ({}),
      cwd: join(tmpdir(), 'ancile-claude-model'),
      gate: (root) =>
        createGate({ policy: new BuiltinPolicy(), store: new MemoryPermissionStore(), workspaceRoot: root }),
      userId: 'usr_1',
      workspaceId: 'w',
      handles: new Set<string>(),
      images: async (id) => (id === 'img_1' ? { bytes: Buffer.from('PNGDATA'), mime: 'image/png' } : null),
    });
    const model = claudeCodeModels().find((m) => m.id === 'claude-code/sonnet') as ModelConfig;
    for await (const _ of client.stream(
      model,
      {
        messages: [
          {
            role: 'user',
            content: '',
            parts: [
              { type: 'text', text: 'What is in this? ' },
              { type: 'image', url: '/api/v1/images/img_1', mime: 'image/png', image_id: 'img_1' },
            ],
          },
        ],
      },
      new AbortController().signal,
    ));
    expect(bridge.images).toEqual([[{ mime: 'image/png', data: Buffer.from('PNGDATA').toString('base64') }]]);
    expect(bridge.sent[0]).toContain('[Image 1 attached]');
  });

  it('says what Claude Code said when its result is an error, even one marked success', async () => {
    const bridge = new Bridge();
    bridge.result = { subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded' };
    const client = new ClaudeCodeModelClient({
      bridge,
      cli: async () => ({ path: 'claude', version: '2.1.300' }),
      env: async () => ({}),
      cwd: join(tmpdir(), 'ancile-claude-model'),
      gate: (root) =>
        createGate({ policy: new BuiltinPolicy(), store: new MemoryPermissionStore(), workspaceRoot: root }),
      userId: 'usr_1',
      workspaceId: 'w',
      handles: new Set<string>(),
    });
    const model = claudeCodeModels().find((m) => m.id === 'claude-code/haiku') as ModelConfig;
    const run = async () => {
      for await (const _ of client.stream(
        model,
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ));
    };
    await expect(run()).rejects.toThrow('Claude Code could not answer: API Error: 529 Overloaded');
  });

  it('runs the monthly-credit variant on the Anthropic key, in that one session only (CR1)', async () => {
    const KEY = 'sk-ant-api03-CREDITKEYCREDITKEY0001';
    const mk = (bridge: Bridge, over: Partial<ConstructorParameters<typeof ClaudeCodeModelClient>[0]> = {}) =>
      new ClaudeCodeModelClient({
        bridge,
        cli: async () => ({ path: 'claude', version: '2.1.300' }),
        env: async () => ({ DISABLE_TELEMETRY: '1' }),
        creditKey: async () => KEY,
        cwd: join(tmpdir(), 'ancile-claude-model'),
        gate: (root) =>
          createGate({
            policy: new BuiltinPolicy(),
            store: new MemoryPermissionStore(),
            workspaceRoot: root,
          }),
        userId: 'usr_1',
        workspaceId: 'w',
        handles: new Set<string>(),
        ...over,
      });
    const run = async (client: ClaudeCodeModelClient, id: string) => {
      const out = [];
      for await (const c of client.stream(
        claudeCodeModels().find((m) => m.id === id) as ModelConfig,
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ))
        out.push(c);
      return out;
    };
    const plan = new Bridge();
    await run(mk(plan), 'claude-code/sonnet');
    expect(plan.opened[0]?.env).toEqual({ DISABLE_TELEMETRY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    expect(JSON.stringify(plan.opened[0])).not.toContain(KEY);

    const credit = new Bridge();
    credit.result = { subtype: 'success', is_error: false, total_cost_usd: 0.0123 };
    const chunks = await run(mk(credit), 'claude-code/sonnet@credit');
    expect(credit.opened[0]).toMatchObject({ model: 'sonnet', env: { ANTHROPIC_API_KEY: KEY } });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', costUsd: 0.0123 });
  });

  it('says the credit is spent when Anthropic says so, and marks it (CR1)', async () => {
    const bridge = new Bridge();
    bridge.result = {
      subtype: 'success',
      is_error: true,
      result: 'Credit balance is too low to access the Anthropic API',
    };
    let told = 0;
    const client = new ClaudeCodeModelClient({
      bridge,
      cli: async () => ({ path: 'claude', version: '2.1.300' }),
      env: async () => ({}),
      creditKey: async () => 'sk-ant-api03-CREDITKEYCREDITKEY0001',
      onCreditExhausted: () => {
        told++;
      },
      cwd: join(tmpdir(), 'ancile-claude-model'),
      gate: (root) =>
        createGate({ policy: new BuiltinPolicy(), store: new MemoryPermissionStore(), workspaceRoot: root }),
      userId: 'usr_1',
      workspaceId: 'w',
      handles: new Set<string>(),
    });
    const model = claudeCodeModels().find((m) => m.id === 'claude-code/haiku@credit') as ModelConfig;
    const go = async () => {
      for await (const _ of client.stream(
        model,
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ));
    };
    await expect(go()).rejects.toMatchObject({ errorClass: 'permanent', code: 'provider.credit_exhausted' });
    expect(told).toBe(1);
  });

  it('refuses a monthly-credit call when no Anthropic key is saved (CR1)', async () => {
    const client = new ClaudeCodeModelClient({
      bridge: new Bridge(),
      cli: async () => ({ path: 'claude', version: '2.1.300' }),
      env: async () => ({}),
      creditKey: async () => null,
      cwd: join(tmpdir(), 'ancile-claude-model'),
      gate: (root) =>
        createGate({ policy: new BuiltinPolicy(), store: new MemoryPermissionStore(), workspaceRoot: root }),
      userId: 'usr_1',
      workspaceId: 'w',
      handles: new Set<string>(),
    });
    const model = claudeCodeModels().find((m) => m.id === 'claude-code/opus@credit') as ModelConfig;
    const go = async () => {
      for await (const _ of client.stream(
        model,
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ));
    };
    await expect(go()).rejects.toMatchObject({ errorClass: 'permanent', code: 'provider.auth_failed' });
  });

  it("never saves Claude Code's own 'Prompt is too long' as the answer, and names it", async () => {
    const bridge = new Bridge();
    const said =
      'Prompt is too long · the request is ~286227 tokens (limit 200000) but this conversation is only ~3598 tokens';
    bridge.before = [
      {
        type: 'assistant',
        parent_tool_use_id: null,
        isApiErrorMessage: true,
        message: { model: '<synthetic>', content: [{ type: 'text', text: said }] },
      },
    ];
    bridge.result = { subtype: 'success', is_error: true, result: said };
    const client = new ClaudeCodeModelClient({
      bridge,
      cli: async () => ({ path: 'claude', version: '2.1.300' }),
      env: async () => ({}),
      cwd: join(tmpdir(), 'ancile-claude-model'),
      gate: (root) =>
        createGate({ policy: new BuiltinPolicy(), store: new MemoryPermissionStore(), workspaceRoot: root }),
      userId: 'usr_1',
      workspaceId: 'w',
      handles: new Set<string>(),
    });
    const model = claudeCodeModels().find((m) => m.id === 'claude-code/haiku') as ModelConfig;
    const seen: string[] = [];
    const run = async () => {
      for await (const c of client.stream(
        model,
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ))
        if (c.type === 'text') seen.push(c.delta);
    };
    const err = await run().catch((e: unknown) => e as ClassifiedError);
    expect(seen).toEqual([]);
    expect(err).toBeInstanceOf(ClassifiedError);
    // Not the conversation's fault, so compacting is no cure: the chain may go on to another model.
    expect((err as ClassifiedError).errorClass).toBe('permanent');
    expect((err as ClassifiedError).message).toMatch(/^Claude Code said its prompt was too long/);
  });

  it('turns a conversation into one prompt', () => {
    expect(
      promptOf({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
        ],
      }),
    ).toContain('Answer this, the latest message:\n\nc');
  });
});
