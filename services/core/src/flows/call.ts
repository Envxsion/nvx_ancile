/**
 * ------------------------------------------------------------------
 *  Title    |  Flow model calls outside a chat turn
 *  Ref      |  DESIGN.md §16.6 (Try a message, run one node)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Stream one model call through the Gateway for the
 *           |  editor's "Try a message" and "Run only this node",
 *           |  with the same fallbacks, wake waits and pricing as a
 *           |  chat turn, writing nothing to a thread.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import type { Gateway } from '../gateway/gateway';
import type { ModelRegistry } from '../gateway/registry';
import type { ModelRequest } from '../gateway/types';
import type { ModelCallResult } from './execute';

export function priceOf(
  m: ModelConfig | undefined,
  u: { inputTokens: number; outputTokens: number; cachedTokens?: number },
): number {
  if (!m) return 0;
  const cached = u.cachedTokens ?? 0;
  const p = m.price;
  return (
    ((u.inputTokens - cached) * p.input_per_mtok +
      cached * (p.cached_per_mtok ?? p.input_per_mtok) +
      u.outputTokens * p.output_per_mtok) /
    1_000_000
  );
}

export async function streamCall(
  deps: { gateway: Gateway; registry: ModelRegistry },
  chain: ModelConfig[],
  req: ModelRequest,
  signal: AbortSignal,
  onDelta: (channel: 'text' | 'reasoning', delta: string) => void,
  opts: { computeWaitMs?: number } = {},
): Promise<ModelCallResult> {
  const out: ModelCallResult = {
    text: '',
    reasoning: '',
    modelId: chain[0]?.id ?? '',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  };
  let current: ModelConfig | undefined = chain[0];
  for await (const ev of deps.gateway.stream(chain, req, signal, opts)) {
    if (ev.type === 'model') {
      current = deps.registry.get(ev.modelId) ?? chain.find((m) => m.id === ev.modelId);
      out.modelId = ev.modelId;
    } else if (ev.type === 'chunk') {
      const c = ev.chunk;
      if (c.type === 'text') {
        out.text += c.delta;
        onDelta('text', c.delta);
      } else if (c.type === 'reasoning') {
        out.reasoning += c.delta;
        onDelta('reasoning', c.delta);
      } else if (c.type === 'tool_call') {
        out.toolCalls = [...(out.toolCalls ?? []), { callId: c.callId, tool: c.tool, args: c.args }];
      } else if (c.type === 'finish') {
        out.tokensIn += c.usage.inputTokens;
        out.tokensOut += c.usage.outputTokens;
        out.costUsd += priceOf(current, c.usage);
      }
    }
  }
  return out;
}
