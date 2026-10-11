/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Agent SDK: the calls Ancile makes
 *  Ref      |  services/claude-bridge/LICENSE (MIT) · docs/claude-code.md
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  Our own minimal description of the few session-reading
 *           |  functions Ancile calls on Anthropic's Agent SDK, so no
 *           |  Ancile code imports types from that package.
 *  How      |  Written from the documented signatures. Every field is
 *           |  optional or loosely typed where the SDK may change it,
 *           |  and the mapping code (map.ts) checks shapes at runtime.
 *  Note     |  The SDK itself is proprietary (Anthropic). It is never a
 *           |  dependency of Ancile; sdk.ts fetches it on the person's
 *           |  machine when they turn Claude Code on.
 * ------------------------------------------------------------------
 */

/** One session's metadata, as listSessions and getSessionInfo report it. */
export interface CcSessionInfo {
  sessionId: string;
  /** Display title: custom title, summary or first prompt. */
  summary: string;
  /** Milliseconds since the epoch. */
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  /** Milliseconds since the epoch. */
  createdAt?: number;
}

/** One transcript entry, as getSessionMessages and getSubagentMessages return it. */
export interface CcSessionMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id: string;
  /** The API message: { role, content, model?, usage?, id? }. */
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id?: string | null;
  /** ISO time, when the transcript has it. */
  timestamp?: string;
  /** The summary written when Claude Code compacted the conversation. */
  isCompactSummary?: boolean;
  is_meta?: boolean;
}

export interface CcDirOptions {
  /** A project folder; omitted means every project. */
  dir?: string;
}

/** The part of the Agent SDK module Ancile uses. */
export interface ClaudeAgentSdk {
  listSessions(options?: CcDirOptions & { limit?: number; offset?: number }): Promise<CcSessionInfo[]>;
  getSessionInfo(sessionId: string, options?: CcDirOptions): Promise<CcSessionInfo | undefined>;
  getSessionMessages(
    sessionId: string,
    options?: CcDirOptions & { limit?: number; offset?: number; includeSystemMessages?: boolean },
  ): Promise<CcSessionMessage[]>;
  listSubagents(sessionId: string, options?: CcDirOptions): Promise<string[]>;
  getSubagentMessages(
    sessionId: string,
    agentId: string,
    options?: CcDirOptions & { limit?: number; offset?: number },
  ): Promise<CcSessionMessage[]>;
}

/** Check a loaded module has what Ancile calls. */
export function isClaudeAgentSdk(m: unknown): m is ClaudeAgentSdk {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return [
    'listSessions',
    'getSessionInfo',
    'getSessionMessages',
    'listSubagents',
    'getSubagentMessages',
  ].every((k) => typeof o[k] === 'function');
}
