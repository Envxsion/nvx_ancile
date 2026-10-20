/**
 * ------------------------------------------------------------------
 *  Title    |  Auto mode: the reviewer chain as Core runs it
 *  Ref      |  docs/auto-mode.md (How the reviewer works)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Build the real reviewers in their order of preference:
 *           |  Jev through OpenRouter (the saved OpenRouter key), Jev
 *           |  directly (the saved TypeSafe key), then a local model
 *           |  through the gateway. Rules are added by AutoReview.
 *  How      |  Keys are read from the secret store per review, so a
 *           |  key added in Settings → API keys is used at once. The
 *           |  local reviewer uses the first local model on the utility
 *           |  chain, else the smallest ready local chat model of at
 *           |  most 14B (an Ollama model you pulled): it never leaves
 *           |  this machine, so it fits every scope.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import type { DecisionRouter } from '../../decisions/router';
import type { Gateway } from '../../gateway/gateway';
import { canChat, type ModelRegistry } from '../../gateway/registry';
import { DecisionReviewer } from './decision-reviewer';
import { LocalModelReviewer, type Reviewer } from './reviewers';

/** The secret store name for the TypeSafe key (credentials/routes.ts uses it too). */
export const TYPESAFE_KEY_SECRET = 'typesafe.api_key';
/** The OpenRouter key's secret name (gateway/providers.ts DEFAULT_SECRET). */
export const OPENROUTER_KEY_SECRET = 'OPENROUTER_API_KEY';

const isLocal = (m: { provider: string; via?: string }) =>
  (m.provider === 'ollama' || m.provider === 'local') && m.via !== 'controller';

/** Largest local model the reviewer falls back to (billions of parameters). */
export const REVIEWER_MAX_B = 14;

/** Billions of parameters a model's name gives ("llama3.2:3b", "qwen3-14b"), or null. */
export function paramsOf(name: string): number | null {
  const m = /(?:^|[:_/-])(\d+(?:\.\d+)?)b\b/i.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * The model the local reviewer asks: the utility chain's first local model,
 * else the smallest ready local chat model that says its size, up to
 * REVIEWER_MAX_B. Null when there is none (Auto mode falls back to rules).
 */
export function reviewerModel(registry: Pick<ModelRegistry, 'chain' | 'all' | 'status'>): ModelConfig | null {
  let fromChain: ModelConfig | undefined;
  try {
    fromChain = registry.chain('utility').find(isLocal);
  } catch {
    // No utility model at all (NoRouteError): look for a local one below.
  }
  if (fromChain) return fromChain;
  const sized = registry
    .all()
    .filter((m) => isLocal(m) && canChat(m) && registry.status(m) === 'ready')
    .map((m) => ({ m, b: paramsOf(m.provider_model) }))
    .filter((x): x is { m: ModelConfig; b: number } => x.b !== null && x.b <= REVIEWER_MAX_B)
    .sort((a, b) => a.b - b.b);
  return sized[0] ? { ...sized[0].m, enabled: true } : null;
}

export function coreReviewers(deps: {
  decisions: DecisionRouter;
  gateway: Gateway;
  registry: ModelRegistry;
}): Reviewer[] {
  return [
    // Hosted decision models (Clef on a free allowance, Jev, Perplexity...), then one on this machine.
    new DecisionReviewer(deps.decisions, 'hosted'),
    new DecisionReviewer(deps.decisions, 'local'),
    new LocalModelReviewer({
      available: async () => reviewerModel(deps.registry) !== null,
      complete: async (prompt, signal) => {
        const model = reviewerModel(deps.registry);
        if (!model) return null;
        const chain = [model];
        let text = '';
        for await (const ev of deps.gateway.stream(
          chain,
          {
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
            temperature: 0,
            maxOutputTokens: 60,
          },
          signal,
        )) {
          if (ev.type === 'chunk' && ev.chunk.type === 'text') text += ev.chunk.delta;
        }
        return text;
      },
    }),
  ];
}
