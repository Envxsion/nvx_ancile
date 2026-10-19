/**
 * ------------------------------------------------------------------
 *  Title    |  Gateway types
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The provider-neutral shapes every model call goes
 *           |  through. ModelClient is the seam: the AI SDK client in
 *           |  production, FakeProvider in tests and in the offline
 *           |  test model (deterministic streams, injectable failures).
 * ------------------------------------------------------------------
 */

import type { ErrorClass, ModelConfig, Part, RoutingSettings } from '@nvx/contracts';
import type { CallUsage } from './usage';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain text of the message; what a provider sees when there are no parts. */
  content: string;
  /** Full parts (tool calls, tool results). Providers that support them get them. */
  parts?: Part[];
  /**
   * CA4: this message exactly as it was sent last time, as JSON text of the
   * provider messages it became. Sent as stored, so a later turn starts with
   * the same bytes however parts or rules have changed since; absent on older
   * messages, which are rebuilt from their parts.
   */
  sent?: string;
  /** CA1: the prompt epoch this message was written in, so reasoning is not replayed across one a provider forbids. */
  epochId?: string;
}

/**
 * CA5: who this request belongs to, so a provider's cache key, conversation id
 * and session id are the same on every turn of a branch and never random.
 * `shard` tells apart calls that run side by side on the same branch (Beam
 * members, judges): each gets its own key.
 */
export interface CacheScope {
  threadId: string;
  /** Stable across the turns of one branch, different between branches. */
  branch: string;
  epochId: string;
  shard?: string;
}

/** A tool as the model sees it: name, description, JSON Schema for its input. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system?: string;
  /**
   * CA5: `system` in two pieces, the rules and the frozen snapshot, joined by a
   * blank line. Only Anthropic uses them (a marker after each); others get `system`.
   */
  systemBlocks?: [string, string];
  messages: ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  tools?: ToolDef[];
  /** CA3: fixed for the whole thread, so the tool choice never changes the request's start. */
  toolChoice?: 'auto';
  /**
   * Where the call is made from, for clients that act on it (Claude Code as
   * a model gives that thread's notebook tools). Providers never see it.
   */
  meta?: { threadId?: string; notebookId?: string | null };
  /** OpenRouter: a flow step's own routing choice; else the thread's, notebook's or model's applies. */
  routing?: RoutingSettings;
  /** CA5: where the call is made from, for cache keys. Absent: no key is sent. */
  cache?: CacheScope;
}

export type StreamChunk =
  | { type: 'text'; delta: string }
  /**
   * `block`: a new reasoning block begins. `meta`: what the provider signed or
   * wants back (CA1), in the shape of ReasoningPart.provider_meta; may arrive
   * with an empty delta.
   */
  | { type: 'reasoning'; delta: string; block?: true; meta?: Record<string, unknown> }
  | { type: 'tool_call'; callId: string; tool: string; args: unknown; meta?: Record<string, unknown> }
  /** Something the person should know about this answer (a local model cut the prompt). */
  | { type: 'warning'; code: string; message: string }
  | {
      type: 'finish';
      finishReason: string;
      /** Every prompt token in inputTokens, cache reads and writes included (gateway/usage.ts). */
      usage: CallUsage;
      /** OpenRouter: the provider (and model) that actually answered. */
      served?: { provider: string | null; model: string | null };
      /** What the provider billed, when it says (OpenRouter's usage.cost); else Ancile prices it. */
      costUsd?: number;
      /** CA5: the call left its cache pin on purpose (OpenRouter's pinned provider was down); recorded in provenance. */
      cacheReset?: { reason: string; provider: string | null; detail: string };
    };

export interface ModelClient {
  stream(model: ModelConfig, req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}

export type GatewayEvent =
  | { type: 'model'; modelId: string }
  | { type: 'chunk'; modelId: string; chunk: StreamChunk }
  | { type: 'fallback'; from: string; to: string; reason: ErrorClass; detail: string }
  | { type: 'seam'; from: string; to: string; reason: string }
  /** The model's GPU node is waking; the gateway waits and asks again (compute.ts). */
  | {
      type: 'compute_waiting';
      modelId: string;
      nodeId: string | null;
      etaS: number | null;
      canUseCloud: boolean;
      detail: string;
    };
