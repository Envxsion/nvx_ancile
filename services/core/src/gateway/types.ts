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
}

/** A tool as the model sees it: name, description, JSON Schema for its input. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system?: string;
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
}

export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; callId: string; tool: string; args: unknown }
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
