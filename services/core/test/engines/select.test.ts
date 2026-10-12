/**
 * Choosing an engine per message, the scope check before anything runs,
 * Claude Code as a model (Mode A) through the gateway's routing client,
 * and the Pro seam keeping it out of Beam and the Flow lab without Pro.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveScope, ModelConfig } from '@nvx/contracts';
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
  opened: LiveOpenParams[] = [];
  sent: string[] = [];
  replies: LivePermissionReply[] = [];
  closed: string[] = [];
  private fns = new Set<(e: LiveEvent) => void>();
  async open(p: LiveOpenParams) {
    this.opened.push(p);
    return { handle: 'hA' };
  }
  async send(handle: string, text: string) {
    this.sent.push(text);
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
      for (const d of ['Hel', 'lo'])
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
      model: 'sonnet',
      append_system_prompt: 'Be brief.',
    });
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
