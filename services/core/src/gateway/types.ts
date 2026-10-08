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

import type { ErrorClass, ModelConfig, Part } from '@nvx/contracts';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain text of the message; what a provider sees when there are no parts. */
  content: string;
  /** Full parts (tool calls, tool results). Providers that support them get them. */
  parts?: Part[];
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
}

export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; callId: string; tool: string; args: unknown }
  | {
      type: 'finish';
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
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
