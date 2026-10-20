/**
 * ------------------------------------------------------------------
 *  Title    |  Routing: task class → fallback chain
 *  Ref      |  DESIGN.md §7.2, config/routing.yaml
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Decide which models to try, in order. A user's explicit
 *           |  choice goes first; the task class supplies the rest.
 *           |  Disabled and unknown models drop out. For fact-check
 *           |  verifiers, models from the generator's family move to
 *           |  the back, so the second opinion is independent when it
 *           |  can be.
 *           |  A PINNED model (an explicit choice) falls back only to
 *           |  models no dearer than it ("same price or cheaper",
 *           |  DESIGN.md §7.2, owner decision 2026-10-20), never to a
 *           |  subscription engine unless the person's saved chain
 *           |  names it.
 * ------------------------------------------------------------------
 */

import { CLAUDE_CODE_PROVIDER, type ModelConfig } from '@nvx/contracts';

export type ChainSpec = string[] | { chain: string[]; prefer_different_family?: boolean };

export interface ResolveInput {
  taskClass: string;
  explicit?: string | undefined;
  /** Family of the model whose answer is being checked (fact-check). */
  generatorFamily?: string | undefined;
  /** Models the person's own saved chain names; a subscription engine may follow a pinned model only from here. */
  namedByPerson?: ReadonlySet<string> | undefined;
}

/** Engines billed to a plan, not per token: their price reads $0, which would otherwise win every comparison. */
export const isSubscription = (m: Pick<ModelConfig, 'provider'>) => m.provider === CLAUDE_CODE_PROVIDER;

/**
 * Whether `candidate` may stand in for the pinned `pinned`: its input and its
 * output price per million tokens are both no higher. Local and plan models
 * read $0, so they always pass the price test (they must already be enabled and
 * able to chat, which the ready list guarantees); a subscription engine is
 * further held back unless the person's own chain names it.
 */
export function noDearerThan(
  pinned: ModelConfig,
  candidate: ModelConfig,
  namedByPerson: ReadonlySet<string>,
): boolean {
  if (isSubscription(candidate) && !isSubscription(pinned) && !namedByPerson.has(candidate.id)) return false;
  return (
    candidate.price.input_per_mtok <= pinned.price.input_per_mtok &&
    candidate.price.output_per_mtok <= pinned.price.output_per_mtok
  );
}

export class NoRouteError extends Error {
  readonly errorClass = 'permanent' as const;
  constructor(readonly taskClass: string) {
    super(
      `No enabled model can handle "${taskClass}". Add one in Settings → Models, or check its chain in Admin → Routing.`,
    );
    this.name = 'NoRouteError';
  }
}

/** Fall back through dotted parents: chat.deep.long → chat.deep → chat → chat.default */
export function chainFor(taskClasses: Record<string, ChainSpec>, taskClass: string): ChainSpec | undefined {
  let tc = taskClass;
  for (;;) {
    if (taskClasses[tc]) return taskClasses[tc];
    const i = tc.lastIndexOf('.');
    if (i < 0) break;
    tc = tc.slice(0, i);
  }
  return taskClasses[`${taskClass.split('.')[0]}.default`] ?? taskClasses['chat.default'];
}

export function resolveChain(
  input: ResolveInput,
  taskClasses: Record<string, ChainSpec>,
  models: ReadonlyMap<string, ModelConfig>,
): ModelConfig[] {
  const spec = chainFor(taskClasses, input.taskClass);
  const ids = spec ? (Array.isArray(spec) ? spec : spec.chain) : [];
  // A verifier is independent whenever it can be, even when routing.yaml forgot to say so.
  const preferDifferent =
    (!!spec && !Array.isArray(spec) && spec.prefer_different_family === true) ||
    input.taskClass.startsWith('factcheck.');

  const ordered = [...(input.explicit ? [input.explicit] : []), ...ids];
  const seen = new Set<string>();
  let chain: ModelConfig[] = [];
  for (const id of ordered) {
    if (seen.has(id)) continue;
    seen.add(id);
    const m = models.get(id);
    if (m?.enabled) chain.push(m);
  }
  // A pinned model never silently becomes a dearer one.
  const pinned = input.explicit ? chain[0] : undefined;
  if (pinned && pinned.id === input.explicit) {
    const named = input.namedByPerson ?? new Set<string>();
    chain = [pinned, ...chain.slice(1).filter((m) => noDearerThan(pinned, m, named))];
  }
  if (preferDifferent && input.generatorFamily) {
    const other = chain.filter((m) => m.family !== input.generatorFamily);
    const same = chain.filter((m) => m.family === input.generatorFamily);
    chain = [...other, ...same];
  }
  if (chain.length === 0) throw new NoRouteError(input.taskClass);
  return chain;
}
