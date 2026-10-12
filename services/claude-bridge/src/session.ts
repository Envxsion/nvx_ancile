/**
 * ------------------------------------------------------------------
 *  Title    |  Live Claude Code sessions
 *  Ref      |  services/claude-bridge/LICENSE (MIT) · src/protocol.ts
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  Run the person's own Claude Code as a live session for
 *           |  NVX Ancile, through the Agent SDK's query() in streaming
 *           |  input mode, and ask Core before every tool call.
 *  How      |  One query() per open handle, its input an async queue
 *           |  kept open between turns. Every SDK message is pushed to
 *           |  Core as it is (session.message). Every tool call passes
 *           |  a PreToolUse hook, on its real input, which asks Core
 *           |  (session.permission) and waits for session.permission_reply;
 *           |  canUseTool asks the same way when Claude Code itself
 *           |  wants to ask, and reuses an answer the hook already got
 *           |  for that call. No answer in time means deny. Ancile never
 *           |  answers with Claude Code's own "always" suggestions:
 *           |  remembering lives in Ancile's grants. A handle closes
 *           |  after ten idle minutes, when asked, or when the Core
 *           |  connection that opened it goes away.
 *  Note     |  MIT, a separate program. Logs carry handles, op names
 *           |  and timings, never message contents or tool input.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import type {
  ClaudeAgentSdk,
  SdkHookCallback,
  SdkPermissionResult,
  SdkQuery,
  SdkQueryOptions,
  SdkUserMessage,
} from './sdk-types';
import { hasLiveSessions } from './sdk-types';
import { compactsAt, planUsage } from './usage';
import { log } from './util';

export const PERMISSION_TIMEOUT_MS = 30 * 60_000;
export const SESSION_IDLE_MS = 10 * 60_000;
export const NO_ANSWER = 'No answer from NVX Ancile';

/** An async iterable of user messages that stays open until end(). */
export interface InputQueue {
  iterable: AsyncIterable<SdkUserMessage>;
  push(m: SdkUserMessage): void;
  end(): void;
}

export function inputQueue(): InputQueue {
  const items: SdkUserMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(m) {
      if (ended) return;
      items.push(m);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = items.shift();
          if (next) {
            yield next;
            continue;
          }
          if (ended) return;
          await new Promise<void>((r) => {
            wake = r;
          });
          wake = null;
        }
      },
    },
  };
}

export type SessionState = 'starting' | 'ready' | 'working' | 'closed';
export type Pusher = (event: string, data: unknown) => void;

export interface OpenParams {
  session_id?: string;
  resume?: string;
  fork?: boolean;
  resume_at?: string;
  cwd: string;
  model?: string;
  effort?: string;
  permission_mode?: string;
  append_system_prompt?: string;
  mcp_servers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>;
  env?: Record<string, string>;
  path_to_cli: string;
  /** false: a session that writes no transcript (reading the command list). */
  persist?: boolean;
  /** Built-in tools on; [] turns every one off (Claude Code as a model). */
  tools?: string[];
  /** Which settings load; [] none. Absent: user, project and local. */
  setting_sources?: ('user' | 'project' | 'local')[];
}

export interface PermissionReply {
  behavior: 'allow' | 'deny';
  updated_input?: Record<string, unknown>;
  message?: string;
}

interface Waiting {
  resolve: (r: PermissionReply) => void;
  timer: NodeJS.Timeout;
}

interface Live {
  handle: string;
  q: SdkQuery;
  input: InputQueue;
  push: Pusher;
  owner: unknown;
  state: SessionState;
  sessionId: string | null;
  waiting: Map<string, Waiting>;
  /** Answers the hook already got, by tool_use_id, so canUseTool does not ask twice. */
  decided: Map<string, PermissionReply>;
  idle: NodeJS.Timeout | null;
}

export class SessionError extends Error {
  constructor(
    readonly code: 'bad_request' | 'unknown_handle' | 'sdk_unavailable' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

const CONTROL_OPS = [
  'set_model',
  'set_permission_mode',
  'set_max_thinking_tokens',
  'set_effort',
  'supported_commands',
  'supported_models',
  'context_usage',
  'rewind_files',
  'mcp_status',
  'mcp_reconnect',
  'mcp_toggle',
  'usage',
] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

/** Permission modes Core may set. bypassPermissions is never one: every call asks Ancile. */
const MODES = new Set(['default', 'plan', 'acceptEdits']);

export interface SessionManagerOptions {
  load: () => Promise<ClaudeAgentSdk>;
  permissionTimeoutMs?: number;
  idleMs?: number;
  /** The bridge's version, for Claude Code's User-Agent. */
  version?: string;
}

export class SessionManager {
  private readonly live = new Map<string, Live>();

  constructor(private readonly opts: SessionManagerOptions) {}

  get open(): number {
    return this.live.size;
  }

  private setState(l: Live, state: SessionState, error?: string) {
    if (l.state === state && !error) return;
    l.state = state;
    l.push('session.state', {
      handle: l.handle,
      state,
      ...(l.sessionId && { session_id: l.sessionId }),
      ...(error && { error }),
    });
  }

  private touch(l: Live) {
    if (l.idle) clearTimeout(l.idle);
    l.idle = setTimeout(() => {
      if (l.state === 'working' || l.waiting.size) return this.touch(l);
      log('info', 'live session idle: closing it', { handle: l.handle });
      this.close(l.handle);
    }, this.opts.idleMs ?? SESSION_IDLE_MS);
    l.idle.unref?.();
  }

  private get(handle: unknown): Live {
    const l = typeof handle === 'string' ? this.live.get(handle) : undefined;
    if (!l) throw new SessionError('unknown_handle', 'No open session with that handle');
    return l;
  }

  /** Ask Core about one tool call and wait for its answer (or deny when none comes). */
  private ask(
    l: Live,
    req: {
      tool_name: string;
      input: unknown;
      tool_use_id: string | null;
      agent_id?: string;
      suggestions?: unknown[];
      decision_reason?: string;
      via: 'hook' | 'can_use_tool';
    },
    signal: AbortSignal,
  ): Promise<PermissionReply> {
    const request_id = randomUUID();
    return new Promise<PermissionReply>((resolve) => {
      const done = (r: PermissionReply) => {
        const w = l.waiting.get(request_id);
        if (!w) return;
        clearTimeout(w.timer);
        l.waiting.delete(request_id);
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => done({ behavior: 'deny', message: 'The call was stopped' });
      const timer = setTimeout(
        () => done({ behavior: 'deny', message: NO_ANSWER }),
        this.opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS,
      );
      timer.unref?.();
      l.waiting.set(request_id, { resolve: done, timer });
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      l.push('session.permission', { handle: l.handle, request_id, ...req });
    });
  }

  /** Core's answer to a session.permission. */
  reply(handle: unknown, requestId: unknown, r: PermissionReply): boolean {
    const l = this.get(handle);
    const w = typeof requestId === 'string' ? l.waiting.get(requestId) : undefined;
    if (!w) return false;
    w.resolve(r);
    return true;
  }

  async openSession(p: OpenParams, push: Pusher, owner?: unknown): Promise<{ handle: string }> {
    let sdk: ClaudeAgentSdk;
    try {
      sdk = await this.opts.load();
    } catch (err) {
      throw new SessionError('sdk_unavailable', (err as Error).message || 'The Agent SDK is not available');
    }
    if (!hasLiveSessions(sdk))
      throw new SessionError('sdk_unavailable', 'This Agent SDK cannot run live sessions');
    if (p.permission_mode && !MODES.has(p.permission_mode))
      throw new SessionError('bad_request', 'That permission mode is not offered');
    const handle = `h_${randomUUID()}`;
    const input = inputQueue();
    // Filled in below, once the query exists; the callbacks only run after that.
    let l = null as unknown as Live;

    const hook: SdkHookCallback = async (h, toolUseID, { signal }) => {
      if (h.hook_event_name !== 'PreToolUse') return {};
      const id = h.tool_use_id ?? toolUseID ?? null;
      const r = await this.ask(
        l,
        {
          tool_name: String(h.tool_name ?? ''),
          input: h.tool_input ?? {},
          tool_use_id: id,
          ...(h.agent_id && { agent_id: h.agent_id }),
          via: 'hook',
        },
        signal,
      );
      if (r.behavior === 'allow') {
        if (id) l.decided.set(id, r);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            ...(r.updated_input && { updatedInput: r.updated_input }),
          },
        };
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: r.message || 'NVX Ancile did not allow this',
        },
      };
    };

    const options: SdkQueryOptions = {
      cwd: p.cwd,
      pathToClaudeCodeExecutable: p.path_to_cli,
      ...(p.resume && { resume: p.resume }),
      ...(p.resume && p.fork && { forkSession: true }),
      ...(p.resume && p.resume_at && { resumeSessionAt: p.resume_at }),
      ...(p.model && { model: p.model }),
      ...(p.effort && { effort: p.effort }),
      permissionMode: p.permission_mode ?? 'default',
      includePartialMessages: true,
      // What the interactive CLI loads, so the person's CLAUDE.md, settings, skills and plugins apply.
      settingSources: p.setting_sources ?? ['user', 'project', 'local'],
      ...(p.tools && { tools: p.tools }),
      ...(p.append_system_prompt && {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: p.append_system_prompt },
      }),
      ...(p.mcp_servers && Object.keys(p.mcp_servers).length && { mcpServers: p.mcp_servers }),
      env: {
        ...process.env,
        ...(p.env ?? {}),
        CLAUDE_AGENT_SDK_CLIENT_APP: `nvx-ancile-bridge/${this.opts.version ?? '0'}`,
      },
      enableFileCheckpointing: true,
      ...(p.persist === false && { persistSession: false }),
      hooks: {
        PreToolUse: [
          {
            hooks: [hook],
            timeout: Math.ceil((this.opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS) / 1000) + 60,
          },
        ],
      },
      canUseTool: async (toolName, toolInput, o): Promise<SdkPermissionResult> => {
        const id = o.toolUseID ?? null;
        const known = id ? l.decided.get(id) : undefined;
        const r =
          known ??
          (await this.ask(
            l,
            {
              tool_name: toolName,
              input: toolInput,
              tool_use_id: id,
              ...(o.agentID && { agent_id: o.agentID }),
              ...(o.suggestions && { suggestions: o.suggestions }),
              ...(o.decisionReason && { decision_reason: o.decisionReason }),
              via: 'can_use_tool',
            },
            o.signal,
          ));
        if (id) l.decided.delete(id);
        return r.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: r.updated_input ?? toolInput, ...(id && { toolUseID: id }) }
          : {
              behavior: 'deny',
              message: r.message || 'NVX Ancile did not allow this',
              ...(id && { toolUseID: id }),
            };
      },
      stderr: () => undefined,
    };

    let q: SdkQuery;
    try {
      q = sdk.query({ prompt: input.iterable, options });
    } catch (err) {
      throw new SessionError('failed', (err as Error).message || 'Claude Code could not start');
    }
    l = {
      handle,
      q,
      input,
      push,
      owner,
      state: 'starting',
      sessionId: p.resume && !p.fork ? p.resume : null,
      waiting: new Map(),
      decided: new Map(),
      idle: null,
    };
    this.live.set(handle, l);
    this.touch(l);
    void this.pump(l);
    this.setState(l, 'ready');
    log('info', 'live session opened', { handle, resumed: !!p.resume, fork: !!p.fork });
    return { handle };
  }

  private async pump(l: Live) {
    let error: string | undefined;
    try {
      for await (const raw of l.q) {
        const m = raw as Record<string, unknown>;
        this.touch(l);
        if (typeof m.session_id === 'string' && m.session_id && m.session_id !== l.sessionId) {
          l.sessionId = m.session_id;
        }
        l.push('session.message', { handle: l.handle, message: m });
        if (m.type === 'result') this.setState(l, 'ready');
      }
    } catch (err) {
      error = (err as Error).message?.slice(0, 500) || 'Claude Code stopped';
      log('warn', 'live session ended with an error', { handle: l.handle });
    } finally {
      this.finish(l, error);
    }
  }

  private finish(l: Live, error?: string) {
    if (!this.live.has(l.handle)) return;
    this.live.delete(l.handle);
    if (l.idle) clearTimeout(l.idle);
    for (const [, w] of l.waiting) w.resolve({ behavior: 'deny', message: NO_ANSWER });
    l.waiting.clear();
    l.input.end();
    this.setState(l, 'closed', error);
  }

  send(
    handle: unknown,
    text: string,
    opts: { images?: { mime: string; data: string }[]; uuid?: string } = {},
  ) {
    const l = this.get(handle);
    const content: Record<string, unknown>[] = [{ type: 'text', text }];
    for (const img of opts.images ?? [])
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
    l.input.push({
      type: 'user',
      message: { role: 'user', content: content.length === 1 ? text : content },
      parent_tool_use_id: null,
      ...(opts.uuid && { uuid: opts.uuid }),
      session_id: l.sessionId ?? '',
    });
    this.touch(l);
    this.setState(l, 'working');
    return { accepted: true };
  }

  async interrupt(handle: unknown) {
    const l = this.get(handle);
    await l.q.interrupt();
    return { interrupted: true };
  }

  async control(handle: unknown, op: unknown, args: Record<string, unknown> = {}): Promise<unknown> {
    const l = this.get(handle);
    if (typeof op !== 'string' || !(CONTROL_OPS as readonly string[]).includes(op))
      throw new SessionError('bad_request', 'Unknown control op');
    const s = (k: string) => {
      const v = args[k];
      if (typeof v !== 'string' || !v || v.length > 500)
        throw new SessionError('bad_request', `${k} is required`);
      return v;
    };
    this.touch(l);
    switch (op as ControlOp) {
      case 'set_model':
        await l.q.setModel(typeof args.model === 'string' && args.model ? args.model : undefined);
        return { ok: true };
      case 'set_permission_mode': {
        const mode = s('mode');
        if (!MODES.has(mode)) throw new SessionError('bad_request', 'That permission mode is not offered');
        await l.q.setPermissionMode(mode);
        return { ok: true };
      }
      case 'set_max_thinking_tokens':
        await l.q.setMaxThinkingTokens(typeof args.tokens === 'number' ? args.tokens : null);
        return { ok: true };
      case 'set_effort': {
        if (!l.q.applyFlagSettings) throw new SessionError('failed', 'This Claude Code cannot change effort');
        const level = args.effort === null || args.effort === 'auto' ? null : s('effort');
        await l.q.applyFlagSettings({ effortLevel: level });
        return { ok: true };
      }
      case 'supported_commands':
        return l.q.supportedCommands();
      case 'supported_models':
        return l.q.supportedModels();
      case 'context_usage': {
        const u = await l.q.getContextUsage({ detail: 'summary' });
        return {
          total_tokens: u.totalTokens,
          max_tokens: u.maxTokens,
          percentage: u.percentage,
          model: u.model ?? null,
          compacts_at: compactsAt(u as unknown as Record<string, unknown>),
        };
      }
      case 'usage':
        // Experimental in the SDK: feature-detected and read loosely (usage.ts).
        try {
          return await planUsage(l.q);
        } catch (err) {
          throw new SessionError('failed', (err as Error).message || 'Claude Code did not report usage');
        }
      case 'rewind_files':
        return l.q.rewindFiles(s('user_message_id'), { dryRun: args.dry_run === true });
      case 'mcp_status':
        return l.q.mcpServerStatus();
      case 'mcp_reconnect':
        if (!l.q.reconnectMcpServer) throw new SessionError('failed', 'Not offered by this Claude Code');
        await l.q.reconnectMcpServer(s('server'));
        return { ok: true };
      case 'mcp_toggle':
        if (!l.q.toggleMcpServer) throw new SessionError('failed', 'Not offered by this Claude Code');
        await l.q.toggleMcpServer(s('server'), args.enabled === true);
        return { ok: true };
    }
  }

  close(handle: unknown): { closed: boolean } {
    const l = typeof handle === 'string' ? this.live.get(handle) : undefined;
    if (!l) return { closed: false };
    try {
      l.q.close();
    } catch {
      /* already gone */
    }
    this.finish(l);
    log('info', 'live session closed', { handle: l.handle });
    return { closed: true };
  }

  /** Close every session a connection opened (it went away). */
  closeOwnedBy(owner: unknown): number {
    let n = 0;
    for (const l of [...this.live.values()])
      if (l.owner === owner) {
        this.close(l.handle);
        n++;
      }
    return n;
  }

  closeAll(): void {
    for (const h of [...this.live.keys()]) this.close(h);
  }
}
