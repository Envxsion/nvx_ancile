/**
 * ------------------------------------------------------------------
 *  Title    |  Mission-critical fact-checks: ask, do not guess
 *  Ref      |  DESIGN.md D30 · roadmap TR3 · docs/factcheck.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A critical check needs two independent checkers at
 *           |  standard tier or better. When routing cannot find two
 *           |  by itself, nothing runs: the person is shown every ready
 *           |  chat model and picks, the same provider as the writer
 *           |  included ("Sonnet writes, Opus checks" is fine).
 *  How      |  needsChoice builds the result the Cockpit renders;
 *           |  chosenModels turns the ids sent back into models,
 *           |  refusing any that is not ready or that the scope keeps
 *           |  out of this notebook.
 * ------------------------------------------------------------------
 */

import { AncileError, type FactcheckNeedsChoice, type ModelConfig, TIER_RANK } from '@nvx/contracts';
import type { ModelRegistry } from '../gateway/registry';
import { sameFamily } from '../gateway/tiers';
import type { JudgeOpts } from './steps';

type Reg = Pick<ModelRegistry, 'readyChat' | 'tierOf'>;

/** Every ready chat model the scope allows, strongest first. */
function candidates(registry: Reg, allow: JudgeOpts['allow']): ModelConfig[] {
  return registry
    .readyChat()
    .filter((m) => !allow?.(m))
    .sort(
      (a, b) =>
        TIER_RANK[registry.tierOf(b)] - TIER_RANK[registry.tierOf(a)] ||
        a.display_name.localeCompare(b.display_name),
    );
}

export function needsChoice(
  registry: Reg,
  a: { generatorFamily: string | null; generatorModelId: string | null; allow?: JudgeOpts['allow'] },
): FactcheckNeedsChoice {
  const all = candidates(registry, a.allow);
  const suitable = all.filter(
    (m) => TIER_RANK[registry.tierOf(m)] >= TIER_RANK.balanced && m.id !== a.generatorModelId,
  );
  const first = suitable[0];
  const second = first
    ? (suitable.find((m) => m.id !== first.id && !sameFamily(m.family, first.family)) ??
      suitable.find((m) => m.id !== first.id))
    : undefined;
  return {
    needs_choice: {
      code: 'factcheck.needs_choice',
      title: 'Choose the models to check this with',
      hint: first
        ? 'This is marked critical, and two independent standard or frontier models are not both ready. Pick the models that should check it. The same provider as the writer is fine.'
        : 'This is marked critical, and no standard or frontier model is ready. Pick the models that should check it, or add a key for a stronger one in Settings → Keys.',
      floor: 'balanced',
      models: all.map((m) => ({
        id: m.id,
        name: m.display_name,
        provider: m.provider,
        family: m.family,
        tier: registry.tierOf(m),
        same_family_as_writer: !!a.generatorFamily && sameFamily(m.family, a.generatorFamily),
        suitable: TIER_RANK[registry.tierOf(m)] >= TIER_RANK.balanced,
      })),
      suggested: [first, second].flatMap((m) => (m ? [m.id] : [])),
    },
  };
}

/** The models the person picked, or the error that says which one cannot be used. */
export function chosenModels(registry: Reg, ids: string[], allow: JudgeOpts['allow']): ModelConfig[] {
  const ready = new Map(candidates(registry, allow).map((m) => [m.id, m]));
  return [...new Set(ids)].map((id) => {
    const m = ready.get(id);
    if (!m)
      throw new AncileError({
        code: 'factcheck.model_not_ready',
        title: 'That model cannot check this now',
        hint: 'Pick a model from the list: it must be ready, and this notebook must allow it.',
        status: 422,
        errorClass: 'permanent',
        context: { model: id },
      });
    return m;
  });
}
