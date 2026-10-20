/**
 * ------------------------------------------------------------------
 *  Title    |  How a key is tested
 *  Ref      |  DESIGN.md §13 (onboarding), docs/errors.md (provider.*, setup.*)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Say, for each provider, whether a key can be proved good
 *           |  without spending a token, and tell a model the key is not
 *           |  offered from a key that does not work.
 *  How      |  KEY_CHECKS is a table: `list` reads the provider's own
 *           |  model list with the key (the list rejects a bad key),
 *           |  `key` asks the provider's key endpoint (OpenRouter), and
 *           |  `call` is the one-token fallback for providers whose list
 *           |  is public, missing or undocumented. offeredBy() matches
 *           |  our configured models to what the list offered.
 *  Note     |  A provider is only `list` or `key` when its own docs show
 *           |  the call carrying the key. Anything else stays `call`,
 *           |  so a list that answers every key is never trusted.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { lineOfModel } from '../models/watch/lines';
import { normaliseForMatch } from '../models/watch/listers';

export interface KeyCheckPlan {
  via: 'list' | 'key' | 'call';
  /** The provider's page that shows the call (or why there is none). Checked 2026-10-20. */
  source: string;
}

export const KEY_CHECKS: Record<string, KeyCheckPlan> = {
  // GET /v1/models with x-api-key (the docs' own curl example).
  anthropic: { via: 'list', source: 'https://platform.claude.com/docs/en/api/models/list' },
  // GET /v1/models with Authorization: Bearer. The page refused an automated fetch (403); the API reference's curl carries the key.
  openai: { via: 'list', source: 'https://platform.openai.com/docs/api-reference/models/list' },
  // GET /v1beta/models with x-goog-api-key. AI Studio keys made since 2026-05-28 start with AQ. (auth keys) and travel the same way.
  google: { via: 'list', source: 'https://ai.google.dev/gemini-api/docs/api-key' },
  // Its /models list is public and proves nothing; GET /api/v1/key needs the key and answers 401 for a bad one.
  openrouter: {
    via: 'key',
    source: 'https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key',
  },
  mistral: { via: 'list', source: 'https://docs.mistral.ai/api/endpoint/models' },
  groq: { via: 'list', source: 'https://console.groq.com/docs/api-reference#models-list' },
  moonshot: { via: 'list', source: 'https://platform.kimi.ai/docs/api/list-models' },
  // Not shown with a key in the docs' list page, so not trusted to refuse a bad one.
  deepseek: { via: 'call', source: 'https://api-docs.deepseek.com/api/list-models' },
  xai: { via: 'call', source: 'https://docs.x.ai/docs/models' },
  // No list endpoint is documented.
  minimax: { via: 'call', source: 'https://platform.minimax.io/docs/api-reference/text-openai-api' },
  // Z.ai publishes no model list (modelsPath is null in the profile).
  zai: { via: 'call', source: 'https://docs.z.ai/guides/llm/glm-5' },
  // Not confirmed against the provider's docs to refuse a bad key (source left empty): one token it is.
  qwen: { via: 'call', source: 'https://www.alibabacloud.com/help/en/model-studio/models' },
  together: { via: 'call', source: '' },
  fireworks: { via: 'call', source: '' },
  cerebras: { via: 'call', source: '' },
  cloudflare: { via: 'call', source: '' },
  perplexity: { via: 'call', source: '' },
  cohere: { via: 'call', source: '' },
};

/** How to test a provider's key; anything not in the table is tested with one token. */
export const keyCheckFor = (provider: string): KeyCheckPlan =>
  KEY_CHECKS[provider] ?? { via: 'call', source: '' };

/** The form two spellings of one model id share: lower case, dots as dashes, no snapshot date. */
const same = (providerModel: string) => normaliseForMatch(providerModel.replace(/^models\//, ''));

/**
 * Split configured models by what the provider's list offered. With no list (or
 * an empty one) every model counts as offered: nothing is known to be missing.
 */
export function offeredBy<T extends Pick<ModelConfig, 'provider_model'>>(
  models: readonly T[],
  offered: readonly string[] | undefined,
): { offered: T[]; missing: T[] } {
  if (!offered || offered.length === 0) return { offered: [...models], missing: [] };
  const have = new Set(offered.map(same));
  const out: { offered: T[]; missing: T[] } = { offered: [], missing: [] };
  for (const m of models) (have.has(same(m.provider_model)) ? out.offered : out.missing).push(m);
  return out;
}

/**
 * Which of a provider's models a first key switches on: its lineup (the registry's, MD2), narrowed to
 * what the key is offered. A line's preview stays off while another model of that line is stable.
 * With no lineup to go by (an endpoint you made up), every stable model, or all of them when only
 * previews are left.
 */
export function switchedOnByKey<
  T extends Pick<ModelConfig, 'id' | 'provider' | 'provider_model' | 'base_url'> & {
    line?: ModelConfig['line'];
  },
>(lineup: { lineup(provider: string): { id: string }[] }, provider: string, models: readonly T[]): T[] {
  const ids = new Set(lineup.lineup(provider).map((m) => m.id));
  const chosen = models.filter((m) => ids.has(m.id));
  if (chosen.length) return chosen;
  const stable = models.filter((m) => !lineOfModel(m)?.preview);
  return stable.length ? stable : [...models];
}
