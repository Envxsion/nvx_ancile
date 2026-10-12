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
  /** Who put a user entry there ({ kind: 'human' | 'peer' | 'task-notification', … }); passed through as is. */
  origin?: unknown;
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

/* ---- Live sessions (protocol 2) --------------------------------------------
 * Our own minimal description of query() in streaming-input mode and the
 * few control calls Ancile makes. Messages stay loosely typed: the bridge
 * forwards them to Core as they are.
 */

/** A user message sent into a live session. */
export interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | Record<string, unknown>[] };
  parent_tool_use_id: null;
  /** Ancile's id for the prompt, so the transcript entry can be matched. */
  uuid?: string;
  session_id: string;
}

export interface SdkPermissionAllow {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
  toolUseID?: string;
}
export interface SdkPermissionDeny {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
}
export type SdkPermissionResult = SdkPermissionAllow | SdkPermissionDeny;

export type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: unknown[];
    toolUseID?: string;
    agentID?: string;
    decisionReason?: string;
    blockedPath?: string;
  },
) => Promise<SdkPermissionResult>;

/** A PreToolUse hook: every tool call passes it, with its real input. */
export type SdkHookCallback = (
  input: {
    hook_event_name: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    agent_id?: string;
  },
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

export interface SdkQueryOptions {
  cwd?: string;
  pathToClaudeCodeExecutable?: string;
  resume?: string;
  forkSession?: boolean;
  resumeSessionAt?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  includePartialMessages?: boolean;
  settingSources?: ('user' | 'project' | 'local')[];
  systemPrompt?: { type: 'preset'; preset: 'claude_code'; append?: string };
  mcpServers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>;
  env?: Record<string, string | undefined>;
  canUseTool?: SdkCanUseTool;
  hooks?: Record<string, { matcher?: string; hooks: SdkHookCallback[]; timeout?: number }[]>;
  enableFileCheckpointing?: boolean;
  persistSession?: boolean;
  stderr?: (data: string) => void;
}

export interface SdkSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
  builtin?: boolean;
}

/** The running session query() returns. */
export interface SdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: string): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(n: number | null): Promise<void>;
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>;
  supportedCommands(): Promise<SdkSlashCommand[]>;
  supportedModels(): Promise<
    { value: string; displayName: string; description: string; supportedEffortLevels?: string[] }[]
  >;
  mcpServerStatus(): Promise<{ name: string; status: string; error?: string }[]>;
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<{
    totalTokens: number;
    maxTokens: number;
    percentage: number;
    model?: string;
    autoCompactThreshold?: number;
    isAutoCompactEnabled?: boolean;
  }>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown>;
  reconnectMcpServer?(name: string): Promise<void>;
  toggleMcpServer?(name: string, enabled: boolean): Promise<void>;
  close(): void;
}

export interface ClaudeAgentSdkLive extends ClaudeAgentSdk {
  query(params: { prompt: AsyncIterable<SdkUserMessage>; options?: SdkQueryOptions }): SdkQuery;
}

export function hasLiveSessions(m: ClaudeAgentSdk): m is ClaudeAgentSdkLive {
  return typeof (m as unknown as Record<string, unknown>).query === 'function';
}
