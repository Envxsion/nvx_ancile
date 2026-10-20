/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check: which models the scope lets judge
 *  Ref      |  docs/scopes.md · roadmap FC3/FC4 (keep-local rules)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A fact-check sends the claim and its evidence to a model,
 *           |  so it follows the same keep-local rules as an answer:
 *           |  a private notebook, or one where nothing may leave this
 *           |  machine, is only ever judged by a local model.
 *  How      |  scopeAllow turns the thread's effective scope into the
 *           |  `allow` filter judgeChain takes, using the one rule every
 *           |  turn uses (scopes/checkEngineAllowed). No scope, no filter.
 * ------------------------------------------------------------------
 */

import { type EffectiveScope, isClaudeCodeModel, type ModelConfig } from '@nvx/contracts';
import { isLocalModel } from '../engines/select';
import type { ModelRegistry } from '../gateway/registry';
import { checkEngineAllowed } from '../scopes';
import { verifierPlan } from './steps';

export function scopeAllow(
  scope: EffectiveScope | null | undefined,
): ((m: ModelConfig) => string | null) | undefined {
  if (!scope) return undefined;
  return (m) => {
    const check = checkEngineAllowed(scope, {
      engine: isClaudeCodeModel(m.id) ? 'claude_code' : 'gateway',
      modelId: m.id,
      local: isLocalModel(m),
    });
    return check.ok ? null : check.reason;
  };
}

/**
 * Before a check is started: is there any model the scope lets answer? Routing finds one by need
 * (TR1), so this throws only routing.no_chat_model (add a key) or factcheck.judge_not_allowed
 * (the scope refuses every ready model), and the check does not start.
 */
export async function preflightJudge(
  deps: {
    registry: Pick<ModelRegistry, 'resolveWant'>;
    scopeOf?: (ref: { threadId: string }) => Promise<EffectiveScope>;
  },
  a: { threadId: string; generatorFamily: string | null },
): Promise<void> {
  const scope = (await deps.scopeOf?.({ threadId: a.threadId }).catch(() => null)) ?? null;
  verifierPlan(deps.registry, { tier: 'fast', generatorFamily: a.generatorFamily, allow: scopeAllow(scope) });
}
