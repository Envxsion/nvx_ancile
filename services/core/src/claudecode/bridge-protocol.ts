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
 *           |  Pushes    { event, data } (phase 2 streams).
 *           |  `hello` with the protocol version comes first.
 *  Note     |  Session fields are described here from the SDK's
 *           |  documented shapes; the mapping (map.ts) still checks
 *           |  every field at run time.
 * ------------------------------------------------------------------
 */

export const BRIDGE_PROTOCOL = 1;
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
