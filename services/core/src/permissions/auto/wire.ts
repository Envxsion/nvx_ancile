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
 *           |  local reviewer uses the first enabled Ollama or local
 *           |  model on the utility chain, and nothing else.
 * ------------------------------------------------------------------
 */

import type { Gateway } from '../../gateway/gateway';
import type { ModelRegistry } from '../../gateway/registry';
import type { SecretStore } from '../../secrets';
import {
  JEV_DIRECT_MODELS,
  JEV_OPENROUTER_MODELS,
  JevReviewer,
  LocalModelReviewer,
  OPENROUTER_DECISIONS_URL,
  type Reviewer,
  TYPESAFE_SYSTEMONE_URL,
} from './reviewers';

/** The secret store name for the TypeSafe key (credentials/routes.ts uses it too). */
export const TYPESAFE_KEY_SECRET = 'typesafe.api_key';
/** The OpenRouter key's secret name (gateway/providers.ts DEFAULT_SECRET). */
export const OPENROUTER_KEY_SECRET = 'OPENROUTER_API_KEY';

const isLocal = (m: { provider: string; via?: string }) => m.provider === 'ollama' || m.provider === 'local';

export function coreReviewers(deps: {
  secrets: SecretStore;
  gateway: Gateway;
  registry: ModelRegistry;
}): Reviewer[] {
  const localChain = () => deps.registry.chain('utility').filter(isLocal);
  return [
    new JevReviewer({
      id: 'jev_openrouter',
      url: OPENROUTER_DECISIONS_URL,
      models: JEV_OPENROUTER_MODELS,
      key: () => deps.secrets.get(OPENROUTER_KEY_SECRET),
    }),
    new JevReviewer({
      id: 'jev_direct',
      url: TYPESAFE_SYSTEMONE_URL,
      models: JEV_DIRECT_MODELS,
      key: () => deps.secrets.get(TYPESAFE_KEY_SECRET),
    }),
    new LocalModelReviewer({
      available: async () => localChain().length > 0,
      complete: async (prompt, signal) => {
        const chain = localChain().slice(0, 1);
        if (!chain.length) return null;
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
