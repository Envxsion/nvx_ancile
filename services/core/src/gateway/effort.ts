/**
 * ------------------------------------------------------------------
 *  Title    |  Reasoning effort per provider
 *  Ref      |  ROADMAP.md EN1 · PV3 (profiles.ts) · CA2 (conductor/epoch.ts)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Which models take a reasoning effort (low, medium,
 *           |  high), and what the request carries for it under each
 *           |  provider's own option name. The Cockpit shows the chip
 *           |  from `effortLevels`; the gateway sends `effortOptions`.
 *  How      |  The provider profile says whether and how it takes an
 *           |  effort (reasoning.effort); this file narrows that to the
 *           |  models that do (a reasoning model, and for Ollama and
 *           |  xAI only the families that read it). Anthropic and
 *           |  OpenAI take it as an option; Google as thinkingLevel
 *           |  (Gemini 3 and later) or a thinking budget (2.5);
 *           |  OpenRouter as `reasoning.effort`; Ollama as `think`.
 *  Note     |  Effort is a request parameter, never text in the
 *           |  prompt, so it is not an epoch reason and the cached
 *           |  start of the request stays as it was. Turning thinking
 *           |  itself on or off still starts a new epoch (epoch.ts). A
 *           |  value for a model that takes none is dropped, never sent.
 * ------------------------------------------------------------------
 */

import type { Effort, ModelConfig } from '@nvx/contracts';
import { profileFor } from './profiles';

type Model = Pick<ModelConfig, 'provider' | 'provider_model' | 'capabilities' | 'via'>;

/** Gemini 2.5 takes a thinking budget in tokens; 3 and later take a named level. */
const GOOGLE_BUDGET: Record<Effort, number> = { low: 1_024, medium: 8_192, high: 24_576 };
const OPENAI_REASONING = /^(o\d|gpt-5)/i;
const GPT_OSS = /gpt-oss/i;
const GROK_MINI = /grok-[\w.]*-mini/i;
const GEMINI_LEVEL = /gemini-(?:[3-9]|\d{2,})/i;

/** The levels this model takes through its provider; empty when it takes none. */
export function effortLevels(m: Model): readonly Effort[] {
  if (m.via === 'controller' || !m.capabilities.includes('reasoning')) return [];
  const e = profileFor(m.provider).reasoning.effort;
  if (!e) return [];
  const id = m.provider_model;
  switch (m.provider) {
    case 'openai':
      return OPENAI_REASONING.test(id) ? e.levels : [];
    case 'xai':
      return GROK_MINI.test(id) ? e.levels : [];
    case 'ollama':
      // Other thinking models only think or not; there is no level to pick.
      return GPT_OSS.test(id) ? e.levels : [];
    default:
      return e.levels;
  }
}

/** What to add to the request for this model: AI SDK provider options, and Ollama's `think`. */
export interface EffortParams {
  options: Record<string, Record<string, unknown>>;
  think?: Effort;
}

/**
 * The request parameters for `effort`, or nothing when the model takes none or takes
 * not this level (a xAI mini has no medium: it is then left to its default).
 */
export function effortOptions(m: Model, effort: Effort | undefined): EffortParams {
  const none: EffortParams = { options: {} };
  if (!effort) return none;
  const levels = effortLevels(m);
  if (!levels.includes(effort)) return none;
  switch (m.provider) {
    case 'anthropic':
      return { options: { anthropic: { effort } } };
    case 'openai':
      return { options: { openai: { reasoningEffort: effort } } };
    case 'google':
      return {
        options: {
          google: {
            thinkingConfig: GEMINI_LEVEL.test(m.provider_model)
              ? { thinkingLevel: effort }
              : { thinkingBudget: GOOGLE_BUDGET[effort] },
          },
        },
      };
    case 'openrouter':
      return { options: { openrouter: { reasoning: { effort } } } };
    case 'xai':
      return { options: { xai: { reasoningEffort: effort } } };
    case 'ollama':
      return { options: {}, think: effort };
    default:
      return none;
  }
}
