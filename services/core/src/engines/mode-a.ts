/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: Claude Code as a model (Mode A)
 *  Ref      |  docs/engines.md (Claude Code as a model) · docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  `claude-code/<model>` usable wherever a model is: a
 *           |  thread's model, a routing chain, a flow's node. Each
 *           |  call is one Claude Code turn, answered like any gateway
 *           |  model's stream.
 *  How      |  A ModelClient for the `claude_code` provider. A call
 *           |  opens a session through the Claude bridge that writes no
 *           |  transcript, in NVX Ancile's own empty folder, with every
 *           |  built-in tool off and none of the person's settings
 *           |  loaded. When the call comes from a thread, NVX Ancile's
 *           |  MCP server for that thread is its only tools, and each
 *           |  call is decided by the permission gate as
 *           |  agent:claude-code on its real arguments: allowed runs,
 *           |  anything else is refused (a model call cannot wait for a
 *           |  person). The prompt is the request's messages (the
 *           |  assembled context: summary, last turns, recall and
 *           |  passages), cut newest first to MODE_A_PROMPT_TOKENS,
 *           |  never the whole branch; the system prompt goes in the
 *           |  appended note. Its window is MODE_A_WINDOW, so threads
 *           |  and flow steps budget and compact to it as for any
 *           |  gateway model: a fresh session per call reads it all.
 *  Note     |  Free in chat and routing; inside Pro's Beam and Flow
 *           |  lab it is Pro (pro/answers.ts allowModel). Usage counts
 *           |  against Claude Code's own account; NVX Ancile prices it
 *           |  at zero. TODO(phase-4): approvals inside Mode A calls.
 * ------------------------------------------------------------------
 */

import { mkdir } from 'node:fs/promises';
import {
  CLAUDE_CODE_MODEL_PREFIX,
  CLAUDE_CODE_PROVIDER,
  type ClaudeCodeStatus,
  type ModelConfig,
} from '@nvx/contracts';
import { ClassifiedError } from '@nvx/resilience';
import type { LiveBridge, LiveEvent } from '../claudecode/bridge-protocol';
import { threadToken } from '../claudecode/mcp-server';
import { ANCILE_MCP_SERVER, CLAUDE_CODE_PRINCIPAL, gateRoot, mapTool } from '../claudecode/permission-map';
import type { ModelRegistry } from '../gateway/registry';
import type { ModelClient, ModelRequest, StreamChunk } from '../gateway/types';
import { logFor } from '../obs/logger';
import type { Gate } from '../permissions/gate';

const log = logFor('claude-code-model');

/** The models offered: Claude Code's own aliases. */
export const CLAUDE_CODE_MODELS: { alias: string; name: string }[] = [
  { alias: 'default', name: 'Claude Code (its default model)' },
  { alias: 'opus', name: 'Claude Code: Opus' },
  { alias: 'sonnet', name: 'Claude Code: Sonnet' },
  { alias: 'haiku', name: 'Claude Code: Haiku' },
];

const SYSTEM_MAX = 18_000;
/** The window NVX Ancile budgets Claude Code calls to (each call is a fresh session). */
export const MODE_A_WINDOW = 32_000;
/** The most of the conversation one call's prompt carries, in tokens (about 4 characters each). */
export const MODE_A_PROMPT_TOKENS = 20_000;
const approx = (s: string) => Math.ceil(s.length / 4);

/**
 * Claude Code's error result, in plain words. Its subtype can read "success"
 * on an error, so that word is never shown. "Prompt is too long" with a count
 * far above what was sent comes from Claude Code's own context, not ours:
 * say what NVX Ancile sent so the two are not confused.
 */
export function errorResult(m: Record<string, unknown>, sentTokens: number): ClassifiedError {
  const said = typeof m.result === 'string' ? m.result.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
  if (/too long|context (window|limit)|exceed/i.test(said))
    return new ClassifiedError(
      'context_overflow',
      `Claude Code said its prompt was too long (${said}). NVX Ancile sent it about ${Math.max(1, Math.round(sentTokens / 1000))}k tokens; the rest is Claude Code's own setup.`,
    );
  const subtype = typeof m.subtype === 'string' && m.subtype !== 'success' ? ` (${m.subtype})` : '';
  return new ClassifiedError(
    'transient',
    said
      ? `Claude Code could not answer: ${said}`
      : `Claude Code could not answer and gave no reason${subtype}.`,
  );
}

export function claudeCodeModels(): ModelConfig[] {
  return CLAUDE_CODE_MODELS.map((m) => ({
    id: `${CLAUDE_CODE_MODEL_PREFIX}${m.alias}`,
    provider: CLAUDE_CODE_PROVIDER,
    provider_model: m.alias,
    display_name: m.name,
    via: 'direct' as const,
    family: 'claude',
    context_window: MODE_A_WINDOW,
    max_output: 8_000,
    capabilities: ['tools' as const],
    // Claude Code's usage counts against its own account; NVX Ancile shows no price.
    price: { input_per_mtok: 0, output_per_mtok: 0 },
    enabled: true,
  }));
}

/**
 * Offer Claude Code's models when it is installed, up to date and verified;
 * withdraw them otherwise. While it is installed but not signed in they stay
 * listed as 'signed_out' (Settings shows them with "Sign in"; routing and the
 * pickers skip them). The registry also learns how it is signed in, so each
 * model can say whether a plan or a key pays for it.
 */
export function syncClaudeCodeModels(
  registry: Pick<ModelRegistry, 'setProviderModels'> & Partial<Pick<ModelRegistry, 'setClaudeAuth'>>,
  status: Pick<ClaudeCodeStatus, 'installed' | 'version_ok' | 'verification'> &
    Partial<Pick<ClaudeCodeStatus, 'signed_in' | 'auth_method' | 'plan'>>,
): boolean {
  const ok = status.installed && status.version_ok && status.verification.state !== 'failed';
  registry.setClaudeAuth?.(
    ok && status.signed_in !== undefined
      ? { signed_in: status.signed_in, auth_method: status.auth_method ?? null, plan: status.plan ?? null }
      : null,
  );
  registry.setProviderModels(CLAUDE_CODE_PROVIDER, ok ? claudeCodeModels() : []);
  return ok;
}

/**
 * The request's messages as one prompt for one Claude Code turn: the latest
 * message whole, and the turns before it newest first while they fit in
 * `budget` tokens. Never the whole branch of a long thread.
 */
export function promptOf(req: ModelRequest, budget = MODE_A_PROMPT_TOKENS): string {
  const msgs = req.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (msgs.length === 1) return msgs[0]?.content ?? '';
  const last = msgs.at(-1);
  const earlier = last?.role === 'user' ? msgs.slice(0, -1) : msgs;
  let left = budget - approx(last?.role === 'user' ? last.content : '');
  const kept: string[] = [];
  for (let i = earlier.length - 1; i >= 0; i--) {
    const m = earlier[i];
    if (!m) continue;
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`;
    if (approx(line) > left) break;
    left -= approx(line);
    kept.unshift(line);
  }
  const dropped = earlier.length - kept.length;
  const before = [
    ...(dropped > 0
      ? [`(${dropped} earlier message${dropped === 1 ? '' : 's'} left out to keep this short.)`]
      : []),
    ...kept,
  ].join('\n\n');
  return [
    'The conversation so far:',
    '',
    before,
    '',
    ...(last?.role === 'user' ? ['Answer this, the latest message:', '', last.content] : ['Continue.']),
  ].join('\n');
}

export interface ModeADeps {
  bridge: LiveBridge;
  cli(): Promise<{ path: string; version: string }>;
  env(): Promise<Record<string, string>>;
  /** NVX Ancile's own empty folder the calls run in. */
  cwd: string;
  /** Ancile's MCP server for sessions (/mcp/claude), when it is served. */
  mcp?: { url: string; secret: string } | null;
  gate(root: string): Gate;
  userId: string;
  workspaceId: string;
  /** Handles this client drives; the live layer leaves their events alone. */
  handles: Set<string>;
  /** Plan figures Claude Code reports while it answers (plan-limits.ts observe). */
  observe?: (m: Record<string, unknown>) => Promise<void>;
}

type Item = { kind: 'message'; m: Record<string, unknown> } | { kind: 'end'; error?: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class ClaudeCodeModelClient implements ModelClient {
  constructor(private readonly deps: ModeADeps) {}

  async *stream(model: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const d = this.deps;
    const cli = await d.cli();
    await mkdir(d.cwd, { recursive: true });
    const threadId = req.meta?.threadId;
    const notebookId = req.meta?.notebookId ?? null;
    const prompt = promptOf(req);
    const items: Item[] = [];
    let wake: (() => void) | null = null;
    let handle: string | null = null;
    const push = (i: Item) => {
      items.push(i);
      wake?.();
    };
    const off = d.bridge.onEvent((e: LiveEvent) => {
      if (e.event === 'bridge.closed') return push({ kind: 'end', error: 'The Claude bridge stopped' });
      if (!handle || e.data.handle !== handle) return;
      if (e.event === 'session.message') push({ kind: 'message', m: e.data.message });
      else if (e.event === 'session.state' && e.data.state === 'closed')
        push({ kind: 'end', error: e.data.error ?? 'Claude Code closed the session' });
      else if (e.event === 'session.permission') void this.decide(handle, e.data, notebookId, threadId);
    });
    const onAbort = () => {
      if (handle) void d.bridge.interrupt(handle).catch(() => undefined);
      push({ kind: 'end', error: 'stopped' });
    };
    signal.addEventListener('abort', onAbort);
    try {
      handle = (
        await d.bridge.open({
          cwd: d.cwd,
          path_to_cli: cli.path,
          persist: false,
          tools: [],
          setting_sources: [],
          permission_mode: 'default',
          ...(model.provider_model && model.provider_model !== 'default' && { model: model.provider_model }),
          ...(req.system && { append_system_prompt: req.system.slice(0, SYSTEM_MAX) }),
          ...(threadId &&
            d.mcp && {
              mcp_servers: {
                [ANCILE_MCP_SERVER]: {
                  type: 'http' as const,
                  url: d.mcp.url,
                  headers: { authorization: `Bearer ${threadToken(d.mcp.secret, threadId)}` },
                },
              },
            }),
          env: await d.env(),
        })
      ).handle;
      d.handles.add(handle);
      await d.bridge.send(handle, prompt);
      let streamed = false;
      for (;;) {
        const next = items.shift();
        if (!next) {
          await new Promise<void>((r) => {
            wake = r;
          });
          wake = null;
          continue;
        }
        if (next.kind === 'end') {
          if (signal.aborted) return;
          throw new ClassifiedError('transient', next.error ?? 'Claude Code stopped');
        }
        const m = next.m;
        if (m.type === 'rate_limit_event') {
          void d.observe?.(m).catch(() => undefined);
          continue;
        }
        if (m.type === 'stream_event' && isObj(m.event) && m.parent_tool_use_id == null) {
          const ev = m.event;
          if (ev.type === 'content_block_delta' && isObj(ev.delta)) {
            if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text) {
              streamed = true;
              yield { type: 'text', delta: ev.delta.text };
            } else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string')
              yield { type: 'reasoning', delta: ev.delta.thinking };
          }
        } else if (m.type === 'assistant' && !streamed && m.parent_tool_use_id == null && isObj(m.message)) {
          const content = Array.isArray(m.message.content) ? m.message.content.filter(isObj) : [];
          for (const b of content)
            if (b.type === 'text' && typeof b.text === 'string') yield { type: 'text', delta: b.text };
        } else if (m.type === 'result') {
          if (m.is_error === true) {
            // An error result can say "success" as its subtype; its text says what went wrong.
            throw errorResult(m, approx(prompt) + approx(req.system ?? ''));
          }
          const u = isObj(m.usage) ? m.usage : {};
          const n = (v: unknown) => (typeof v === 'number' ? v : 0);
          yield {
            type: 'finish',
            finishReason: String(m.subtype ?? 'stop'),
            usage: {
              inputTokens: n(u.input_tokens) + n(u.cache_creation_input_tokens),
              outputTokens: n(u.output_tokens),
              cachedTokens: n(u.cache_read_input_tokens),
            },
          };
          return;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      off();
      if (handle) {
        d.handles.delete(handle);
        await d.bridge.close(handle).catch(() => undefined);
      }
    }
  }

  /** Only NVX Ancile's own tools, each decided by the gate; nothing waits for a person here. */
  private async decide(
    handle: string,
    ask: { request_id: string; tool_name: string; input: unknown },
    notebookId: string | null,
    threadId: string | undefined,
  ) {
    const d = this.deps;
    const deny = (message: string) =>
      d.bridge.reply(handle, ask.request_id, { behavior: 'deny', message }).catch(() => undefined);
    if (!threadId || !ask.tool_name.startsWith(`mcp__${ANCILE_MCP_SERVER}__`))
      return deny('Only NVX Ancile tools are on when Claude Code answers as a model');
    const mapped = mapTool(ask.tool_name, ask.input, {
      cwd: d.cwd,
      notebookId,
      workspaceId: d.workspaceId,
    });
    try {
      const decision = await d.gate(gateRoot(d.cwd)).check({
        userId: d.userId,
        principal: CLAUDE_CODE_PRINCIPAL,
        action: mapped.action,
        resource: mapped.resource,
        toolTier: mapped.tier,
        destructive: mapped.destructive,
        scope: { threadId, notebookId, workspaceId: d.workspaceId },
        runId: null,
        traceId: '',
      });
      if (decision.outcome === 'allow')
        await d.bridge.reply(handle, ask.request_id, { behavior: 'allow' }).catch(() => undefined);
      else await deny('NVX Ancile did not allow this here; it needs your approval in a thread');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'a Claude Code model tool call could not be decided');
      await deny('NVX Ancile could not decide this');
    }
  }
}
