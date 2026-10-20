/**
 * ------------------------------------------------------------------
 *  Title    |  Auto mode: the decision-model reviewers
 *  Ref      |  docs/auto-mode.md (How the reviewer works) · docs/decisions.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Ask Auto mode's two questions (does it fit, is it an
 *           |  injection) through the shared decision-model layer, so
 *           |  the reviewer uses the same free allowances, caps,
 *           |  privacy rules and fallbacks as everything else.
 *  How      |  Two reviewers over one DecisionRouter: `decisions`
 *           |  (hosted routes: Clef on a free allowance first, then Jev
 *           |  and the others by price) and `decisions_local` (a
 *           |  decision server on this computer or your GPU node,
 *           |  which counts as private). The chain filters hosted ones
 *           |  out when nothing may leave the machine, as before.
 *  Note     |  Behaviour is unchanged for the caller: two probabilities
 *           |  come back, and a failure moves Auto mode to the next
 *           |  reviewer, ending at the rules. A review is a reasoning
 *           |  task, so Jev or Clef is preferred over a flash model
 *           |  when both are free.
 * ------------------------------------------------------------------
 */

import type { DecisionRequest } from '@nvx/contracts';
import { ClassifiedError } from '@nvx/resilience';
import type { DecisionRouter } from '../../decisions/router';
import {
  type CostProfile,
  JEV_LISTED_RATES,
  QUESTIONS,
  type ReviewAnswer,
  type Reviewer,
  type ReviewInput,
  reviewState,
} from './reviewers';

export class DecisionReviewer implements Reviewer {
  readonly id: 'decisions' | 'decisions_local';
  readonly local: boolean;

  constructor(
    private readonly router: Pick<DecisionRouter, 'decide' | 'hasHosted' | 'localAvailable'>,
    kind: 'hosted' | 'local',
  ) {
    this.local = kind === 'local';
    this.id = this.local ? 'decisions_local' : 'decisions';
  }

  available(): Promise<boolean> {
    return this.local ? this.router.localAvailable() : this.router.hasHosted();
  }

  /** The ceiling for "Check my reviewers": Jev's listed price, the dearest route a review is likely to use. */
  costProfile(): CostProfile {
    return {
      rates: this.local ? null : JEV_LISTED_RATES,
      maxOutputTokens: 64,
      requestText: (input) => JSON.stringify({ state: reviewState(input), questions: QUESTIONS }),
      basis: this.local ? 'free' : 'listed',
    };
  }

  async review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewAnswer> {
    const request: DecisionRequest = {
      state: reviewState(input),
      questions: { fits: QUESTIONS.fits, injection: QUESTIONS.injection },
    };
    const res = await this.router.decide('auto_review', request, {
      only: this.local ? 'local' : 'hosted',
      // The scope already decided whether anything may leave; a private scope only reaches the local reviewer.
      private: input.scope?.private ?? false,
      ...(this.local && { local: true }),
      ...(signal && { signal }),
    });
    if (!res.ok) throw new ClassifiedError('permanent', `${this.id}: ${res.note}`);
    const fits = res.answers.fits;
    const injection = res.answers.injection;
    if (fits?.type !== 'noul' || injection?.type !== 'noul')
      throw new ClassifiedError('permanent', `${this.id} gave no answer to both questions`);
    return { p_fits: fits.noul, p_injection: injection.noul, cost_usd: res.receipt.cost_usd };
  }
}
