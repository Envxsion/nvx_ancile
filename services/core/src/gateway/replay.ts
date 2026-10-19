/**
 * ------------------------------------------------------------------
 *  Title    |  Reasoning replay rules
 *  Ref      |  ROADMAP.md CA1 · docs/prompt-caching.md · gateway/profiles.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A model's reasoning is kept exactly as it arrived, and
 *           |  sent back by each provider's own rule. DeepSeek's
 *           |  thinking mode with tools fails with a 400 if earlier
 *           |  reasoning_content is dropped; Anthropic wants its signed
 *           |  thinking blocks back unchanged; Gemini wants its thought
 *           |  signature on the function-call turn; OpenRouter wants
 *           |  reasoning_details for Anthropic and Gemini upstreams.
 *           |  Everyone else gets none, every time, so their requests
 *           |  stay the same from turn to turn.
 *  How      |  `replayFor` reads the provider's profile (reasoning
 *           |  section) and says which mode applies to this call;
 *           |  convert.ts shapes each earlier assistant message to it.
 *           |  What is stored never depends on the mode.
 *  Note     |  A cancelled stream: a provider that signs (Anthropic,
 *           |  Gemini, OpenRouter) rejects a block with no signature,
 *           |  so a block that never got one is dropped whole and never
 *           |  sent. A provider that takes plain text (DeepSeek, Kimi,
 *           |  GLM, Qwen, MiniMax) cannot reject a short one, and may
 *           |  400 on a missing one, so it keeps what arrived.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { profileFor } from './profiles';

/**
 * none: send no reasoning. text: reasoning_content, as received. blocks:
 * Anthropic thinking blocks with their signatures. calls: the thought
 * signature on each function call (Gemini). details: reasoning_details on the
 * message (OpenRouter). all: keep everything (what is stored).
 */
export type ReplayMode = 'none' | 'text' | 'blocks' | 'calls' | 'details' | 'all';

export interface Replay {
  mode: ReplayMode;
  /** The epoch this call is made in. */
  epochId?: string;
  /** False: reasoning written in another epoch is not sent (its signature belongs to that epoch's settings). */
  acrossEpochs: boolean;
}

export const NO_REPLAY: Replay = { mode: 'none', acrossEpochs: true };

export function replayFor(
  m: Pick<ModelConfig, 'provider' | 'via' | 'provider_model'>,
  ctx: { tools: boolean; epochId?: string | undefined },
): Replay {
  const base = (mode: ReplayMode, acrossEpochs: boolean): Replay => ({
    mode,
    acrossEpochs,
    ...(ctx.epochId !== undefined && { epochId: ctx.epochId }),
  });
  if (m.via === 'controller') return base('none', true);
  const profile = profileFor(m.provider);
  if (profile.reasoning.replay === 'none' || profile.reasoning.replay === 'unknown')
    return base('none', true);
  switch (m.provider) {
    // Signed under that epoch's thinking settings: not replayed across a change of them.
    case 'anthropic':
      return base('blocks', false);
    case 'google':
      return base('calls', true);
    case 'openrouter':
      return base('details', !m.provider_model.startsWith('anthropic/'));
  }
  if (!profile.reasoning.field?.includes('reasoning_content')) return base('none', true);
  if (profile.reasoning.replay === 'always') return base('text', true);
  // with_tools: only a request that declares tools needs it.
  return base(ctx.tools ? 'text' : 'none', true);
}
