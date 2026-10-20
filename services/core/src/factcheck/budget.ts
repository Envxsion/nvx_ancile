/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check limits
 *  Ref      |  config/factcheck.yaml (limits) · docs/factcheck.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One fact-check may never run away: a live test once made
 *           |  54 model calls in 5 minutes for one answer. Four hard
 *           |  limits stop it, and a claim that meets one is "Not
 *           |  checked: <reason>", said plainly, never a crash.
 *  How      |  CheckBudget counts every model call (a first ask, a
 *           |  stronger second look, a repair of a bad reply, a model
 *           |  the gateway fell back to) against the claim and against
 *           |  the whole check, adds up what they cost, and watches the
 *           |  clock. take() throws CheckLimit before a call that would
 *           |  go over. The state is plain numbers kept in the run's
 *           |  checkpoint, so a resumed run goes on from where it was.
 *  Note     |  Claude Code's calls count as calls and as time but not as
 *           |  spend: they draw on your plan, not a bill.
 * ------------------------------------------------------------------
 */

export interface CheckLimits {
  /** Model calls for one claim, escalation and repair included. */
  callsPerClaim: number;
  /** Model calls for the whole answer, finding the claims included. */
  callsPerCheck: number;
  /** Minutes the whole check may take. */
  minutes: number;
  /** The most the check may spend on models, in USD. */
  spendUsd: number;
}

export const DEFAULT_LIMITS: CheckLimits = { callsPerClaim: 3, callsPerCheck: 20, minutes: 6, spendUsd: 0.5 };

export type LimitReason = 'claim_calls' | 'check_calls' | 'time' | 'spend';

/** Thrown before a model call that would go past a limit. `words` is what the claim reads. */
export class CheckLimit extends Error {
  readonly errorClass = 'capacity' as const;
  constructor(
    readonly reason: LimitReason,
    readonly words: string,
  ) {
    super(`factcheck.limit.${reason}`);
    this.name = 'CheckLimit';
  }
}

/** What a claim says when a limit stopped it. */
export const notChecked = (why: string): string => `Not checked: ${why}`;

export interface BudgetState {
  startedAt: number;
  calls: number;
  spendUsd: number;
  /** Calls made for each claim, by its index in the answer. */
  perClaim: Record<string, number>;
}

export class CheckBudget {
  readonly state: BudgetState;

  constructor(
    readonly limits: CheckLimits = DEFAULT_LIMITS,
    state?: BudgetState,
    private readonly now: () => number = Date.now,
  ) {
    this.state = state ?? { startedAt: now(), calls: 0, spendUsd: 0, perClaim: {} };
  }

  /** The limit that is already reached, or null. Time and spend are the whole check's. */
  reached(claim: number | null = null): CheckLimit | null {
    const { limits: l, state: s } = this;
    if (this.now() - s.startedAt >= l.minutes * 60_000)
      return new CheckLimit('time', `the check ran out of time (${l.minutes} minutes)`);
    if (s.spendUsd >= l.spendUsd)
      return new CheckLimit('spend', `the check reached its spending limit ($${l.spendUsd.toFixed(2)})`);
    if (s.calls >= l.callsPerCheck)
      return new CheckLimit('check_calls', `the check reached its limit of ${l.callsPerCheck} model calls`);
    if (claim !== null && (s.perClaim[claim] ?? 0) >= l.callsPerClaim)
      return new CheckLimit(
        'claim_calls',
        `${l.callsPerClaim} model calls did not settle it (no checker gave a usable reply)`,
      );
    return null;
  }

  /** Model calls this claim may still make (0 when any limit is reached). */
  remaining(claim: number | null = null): number {
    if (this.reached(claim)) return 0;
    const byCheck = this.limits.callsPerCheck - this.state.calls;
    const byClaim = claim === null ? byCheck : this.limits.callsPerClaim - (this.state.perClaim[claim] ?? 0);
    return Math.max(0, Math.min(byCheck, byClaim));
  }

  /** Count one model call, or throw CheckLimit when it would go over. */
  take(claim: number | null = null): void {
    const hit = this.reached(claim);
    if (hit) throw hit;
    this.charge(1, claim);
  }

  /** Count calls already made (a model the gateway fell back to) without refusing them. */
  charge(n: number, claim: number | null = null): void {
    if (n <= 0) return;
    this.state.calls += n;
    if (claim !== null) this.state.perClaim[claim] = (this.state.perClaim[claim] ?? 0) + n;
  }

  /** Add what a finished call cost. */
  spend(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.state.spendUsd += usd;
  }

  /** The same budget for a call that belongs to no claim (finding the claims). */
  forCheck(): ClaimBudget {
    return new ClaimBudget(this, null);
  }

  /** The same budget, with every call counted against one claim. */
  forClaim(index: number): ClaimBudget {
    return new ClaimBudget(this, index);
  }
}

/** A CheckBudget seen from one claim: what the steps take their calls from. */
export class ClaimBudget {
  constructor(
    private readonly all: CheckBudget,
    private readonly index: number | null,
  ) {}

  take(): void {
    this.all.take(this.index);
  }

  charge(n: number): void {
    this.all.charge(n, this.index);
  }

  remaining(): number {
    return this.all.remaining(this.index);
  }

  spend(usd: number): void {
    this.all.spend(usd);
  }

  reached(): CheckLimit | null {
    return this.all.reached(this.index);
  }
}
