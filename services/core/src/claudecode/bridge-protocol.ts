/**
 * ------------------------------------------------------------------
 *  Title    |  Claude bridge protocol (Core's side)
 *  Ref      |  docs/claude-code.md · services/claude-bridge/src/protocol.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The plain JSON shapes Core exchanges with the Claude
 *           |  bridge, a separate MIT program that holds Anthropic's
 *           |  Agent SDK. Core never loads the SDK itself.
 *  How      |  Requests  { id, op, params?, trace_id? }
 *           |  Replies   { id, ok: true, result } or
 *           |            { id, ok: false, error: { code, message } }
 *           |  Pushes    { event, data }: session.message,
 *           |            session.permission, session.state (live
 *           |            sessions, protocol 2).
 *           |  `hello` with the protocol version comes first.
 *  Note     |  Session fields are described here from the SDK's
 *           |  documented shapes; the mapping (map.ts) still checks
 *           |  every field at run time.
 * ------------------------------------------------------------------
 */

export const BRIDGE_PROTOCOL = 2;
export const BRIDGE_READY_TAG = 'ANCILE_BRIDGE_READY';

/** One session's metadata (bridge op sessions.list / sessions.info). */
export interface CcSessionInfo {
  sessionId: string;
  /** Display title: custom title, summary or first prompt. */
  summary: string;
  /** Milliseconds since the epoch. */
  lastModified: number;
  fileSize?: number;
  /** Set by /rename in Claude Code (or its own generated title). */
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  /** The folder the session runs in, as Claude Code recorded it. */
  cwd?: string;
  tag?: string;
  createdAt?: number;
}

/** One transcript entry (bridge op sessions.messages / subagents.messages). */
export interface CcSessionMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id: string;
  /** The API message: { role, content, model?, usage?, id? }. */
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id?: string | null;
  timestamp?: string;
  isCompactSummary?: boolean;
  is_meta?: boolean;
  /**
   * Who put a user entry there, when Claude Code says: { kind: 'human' },
   * { kind: 'peer', name, body, handback? } for another session or an
   * agent's hand-back, { kind: 'task-notification' }. Checked at run time.
   */
  origin?: unknown;
}

export interface BridgeSdkStatus {
  ready: boolean;
  version: string | null;
  error: string | null;
  loading?: boolean;
}

export interface Paging {
  limit?: number;
  offset?: number;
}

/** What Core reads Claude Code sessions through (the bridge, or a fake in tests). */
export interface SessionSource {
  sdkStatus(load?: boolean): Promise<BridgeSdkStatus>;
  listSessions(opts?: Paging & { dir?: string }): Promise<CcSessionInfo[]>;
  sessionInfo(sessionId: string): Promise<CcSessionInfo | null>;
  sessionMessages(sessionId: string, page?: Paging): Promise<CcSessionMessage[]>;
  listSubagents(sessionId: string): Promise<string[]>;
  subagentMessages(sessionId: string, agentId: string, page?: Paging): Promise<CcSessionMessage[]>;
  /** The last SDK status seen, without asking (null before the bridge ever ran). */
  lastSdkStatus(): BridgeSdkStatus | null;
}

/* ---- Live sessions (protocol 2) -------------------------------------------- */

/** session.open's parameters (see services/claude-bridge/src/session.ts). */
export interface LiveOpenParams {
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
  /** The located, verified Claude Code executable. */
  path_to_cli: string;
  /** false: a session that writes no transcript (reading the command list). */
  persist?: boolean;
}

/** A tool call the session asks about (pushed as session.permission). */
export interface LivePermissionAsk {
  handle: string;
  request_id: string;
  tool_name: string;
  input: unknown;
  tool_use_id: string | null;
  agent_id?: string;
  suggestions?: unknown[];
  decision_reason?: string;
  via: 'hook' | 'can_use_tool';
}

export interface LivePermissionReply {
  behavior: 'allow' | 'deny';
  updated_input?: Record<string, unknown>;
  message?: string;
}

export type LiveEvent =
  | { event: 'session.message'; data: { handle: string; message: Record<string, unknown> } }
  | { event: 'session.permission'; data: LivePermissionAsk }
  | {
      event: 'session.state';
      data: {
        handle: string;
        state: 'starting' | 'ready' | 'working' | 'closed';
        session_id?: string;
        error?: string;
      };
    }
  /** The bridge itself went away: every handle is gone. */
  | { event: 'bridge.closed'; data: Record<string, never> };

export type LiveControlOp =
  | 'set_model'
  | 'set_permission_mode'
  | 'set_max_thinking_tokens'
  | 'set_effort'
  | 'supported_commands'
  | 'supported_models'
  | 'context_usage'
  | 'rewind_files'
  | 'mcp_status'
  | 'mcp_reconnect'
  | 'mcp_toggle';

/** What the live layer drives sessions through (the bridge, or a fake in tests). */
export interface LiveBridge {
  open(p: LiveOpenParams): Promise<{ handle: string }>;
  send(
    handle: string,
    text: string,
    opts?: { uuid?: string; images?: { mime: string; data: string }[] },
  ): Promise<void>;
  interrupt(handle: string): Promise<void>;
  control<T = unknown>(handle: string, op: LiveControlOp, args?: Record<string, unknown>): Promise<T>;
  close(handle: string): Promise<void>;
  reply(handle: string, requestId: string, r: LivePermissionReply): Promise<void>;
  /** Listen to pushed events; returns an unsubscribe. */
  onEvent(fn: (e: LiveEvent) => void): () => void;
  /** Keep the bridge running while this says so (open sessions). */
  setKeepAlive(fn: () => boolean): void;
}
