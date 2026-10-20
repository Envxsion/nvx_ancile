/**
 * ------------------------------------------------------------------
 *  Title    |  Auto mode: check my reviewers
 *  Ref      |  docs/auto-mode.md (Check my reviewers) · ROADMAP R2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Run the built-in Auto mode eval cases through the
 *           |  reviewers you set up, on this computer, and say what
 *           |  was caught, what was missed and what asked for nothing.
 *           |  No tool runs: each case is only a question to the gate.
 *  How      |  A dry pass with a counting reviewer finds how many calls
 *           |  reach a reviewer (the rules stop the rest first), which
 *           |  gives the estimate. The real pass uses the same gate as
 *           |  Auto mode, with the floors and scopes unchanged, a small
 *           |  worker pool, and a ceiling on what a paid reviewer may
 *           |  be asked once its cost reaches the estimate.
 *  Note     |  Nothing here lowers a floor or a threshold. It only
 *           |  reports. Starting it needs an explicit confirm.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type AutoReviewerId,
  type ReviewerCheckCategory,
  type ReviewerCheckEstimate,
  type ReviewerCheckResult,
} from '@nvx/contracts';
import { type EvalCase, evalGate, INJECTION_CASES, NORMAL_CASES, runEvalCase } from './evals';
import { type AutoCall, checkFloors } from './floors';
import {
  approxTokens,
  type CostProfile,
  callCeilingUsd,
  type ReviewAnswer,
  type Reviewer,
  type ReviewInput,
} from './reviewers';

/** Workers: quick enough, few enough not to hammer a service or a small local model. */
const WORKERS = 4;

const LABELS: Record<AutoReviewerId, string> = {
  jev_openrouter: 'Jev through OpenRouter',
  jev_direct: 'Jev through TypeSafe',
  decisions: 'A hosted decision model (free allowance first)',
  decisions_local: 'A decision model on this computer',
  local_model: 'A local model',
  rules: 'Built-in rules',
  fake: 'Test reviewer',
};

/** Which group a case belongs to in the results table. */
export function categoryOf(c: EvalCase): string {
  if (c.name.startsWith('subagent:')) return 'Claude Code subagents';
  if (c.name.startsWith('source:')) return 'Text from sources';
  if (c.action === 'shell.exec') return 'Shell commands';
  if (c.action.startsWith('fs.')) return 'File changes';
  if (c.action.startsWith('web.')) return 'Web requests';
  if (c.action.startsWith('mcp.')) return 'MCP tools';
  return 'Other tools';
}

/** Counts the calls that reach a reviewer. Unsure on purpose, so each call asks and nothing is cached. */
class CountingReviewer implements Reviewer {
  readonly id = 'fake' as const;
  readonly local = true;
  calls = 0;
  tokens = 0;
  ceiling = 0;
  constructor(private readonly profile: CostProfile | null) {}
  async available() {
    return true;
  }
  async review(input: ReviewInput): Promise<ReviewAnswer> {
    this.calls++;
    if (this.profile) {
      this.tokens += approxTokens(this.profile.requestText(input));
      this.ceiling += callCeilingUsd(this.profile, input);
    }
    return { p_fits: 0.5, p_injection: 0.05, cost_usd: 0 };
  }
}

/** Wraps one reviewer: counts its answers and cost, and goes unavailable once a paid one reaches the ceiling. */
class Metered implements Reviewer {
  readonly id: AutoReviewerId;
  readonly local: boolean;
  calls = 0;
  spent = 0;
  stopped = false;
  constructor(
    private readonly inner: Reviewer,
    private readonly ceiling: number,
  ) {
    this.id = inner.id;
    this.local = inner.local;
  }
  async available() {
    if (!this.local && this.spent >= this.ceiling) {
      this.stopped = true;
      return false;
    }
    return this.inner.available();
  }
  async review(input: ReviewInput, signal?: AbortSignal) {
    const a = await this.inner.review(input, signal);
    this.calls++;
    // The service's own figure when it gives one; otherwise this call's own ceiling.
    const profile = this.inner.costProfile?.();
    this.spent += a.cost_usd ?? (this.local || !profile ? 0 : callCeilingUsd(profile, input));
    return a;
  }
}

const allCases = (): EvalCase[] => [...INJECTION_CASES, ...NORMAL_CASES];

/** What the floors say about each fixed case. A check must leave this exactly as it was. */
export function floorFingerprint(): string[] {
  return allCases().map((c) => {
    const call: AutoCall = {
      principal: c.principal ?? 'agent:default',
      ...(c.tool && { tool: c.tool }),
      action: c.action,
      resource: c.resource,
      outsideRoot: false,
      destructive: c.destructive ?? false,
      ...(c.args !== undefined && { args: c.args }),
    };
    const hit = checkFloors({ call, scope: null });
    return `${c.name}=${hit ? `${hit.verdict}:${hit.rule}` : 'none'}`;
  });
}

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i] as T, i);
      }
    }),
  );
}

export interface CheckDeps {
  /** Fresh reviewer instances in the order Auto mode asks them. The rules are added by the gate. */
  reviewers: () => Reviewer[];
  now?: () => Date;
}

interface Row {
  c: EvalCase;
  injection: boolean;
  outcome: 'allow' | 'ask' | 'deny';
  byRules: boolean;
}

export class ReviewerCheck {
  private running = false;
  constructor(private readonly deps: CheckDeps) {}

  /** How many fixed calls get past the built-in rules and reach a reviewer. Free and instant. */
  private async reachReviewer(profile: CostProfile | null) {
    const counter = new CountingReviewer(profile);
    const gate = evalGate([counter]);
    await pool(allCases(), WORKERS, async (c, i) => void (await runEvalCase(gate, c, 5000 + i)));
    return counter;
  }

  async estimate(): Promise<ReviewerCheckEstimate> {
    const list = this.deps.reviewers();
    const rows = await Promise.all(
      list.map(async (r) => ({
        id: r.id,
        label: LABELS[r.id],
        available: await r.available().catch(() => false),
        local: r.local,
      })),
    );
    const first = rows.find((r) => r.available) ?? null;
    const paid = !!first && !first.local;
    const profile = (paid && list.find((r) => r.id === first?.id)?.costProfile?.()) || null;
    const counted = await this.reachReviewer(profile);
    const calls = counted.calls;
    return {
      injection_cases: INJECTION_CASES.length,
      normal_cases: NORMAL_CASES.length,
      reviewer_calls: calls,
      first_reviewer: first?.id ?? null,
      reviewers: [...rows, { id: 'rules', label: LABELS.rules, available: true, local: true }],
      est_usd_max: profile?.rates ? Number(counted.ceiling.toFixed(6)) : 0,
      est_input_tokens: profile?.rates ? counted.tokens : 0,
      price_basis: profile?.rates ? profile.basis : 'free',
      costs_money: paid,
      sends_cases_out: paid,
    };
  }

  async run(req: { confirm: boolean; max_usd?: number }): Promise<ReviewerCheckResult> {
    if (req.confirm !== true)
      throw new AncileError({
        code: 'auto.check_not_confirmed',
        title: 'The check has not been started',
        hint: 'Choose Run the check in Settings, Auto mode. Nothing runs and nothing is spent until you do.',
        status: 400,
        errorClass: 'permanent',
      });
    if (this.running)
      throw new AncileError({
        code: 'auto.check_running',
        title: 'The check is already running',
        hint: 'Wait for it to finish, then run it again if you need to.',
        status: 409,
        errorClass: 'transient',
      });
    this.running = true;
    try {
      const est = await this.estimate();
      // A caller may lower the ceiling, never raise it.
      const ceiling = Math.min(req.max_usd ?? est.est_usd_max, est.est_usd_max);
      const metered = this.deps.reviewers().map((r) => new Metered(r, ceiling));
      const via = new Map<string, string>();
      const gate = evalGate(metered, (threadId, out) => via.set(threadId, out.via));
      const cases = allCases();
      const rows: Row[] = [];
      await pool(cases, WORKERS, async (c, i) => {
        const r = await runEvalCase(gate, c, 9000 + i);
        rows[i] = {
          c,
          injection: i < INJECTION_CASES.length,
          outcome: r.outcome,
          byRules: via.get(`eval-${9000 + i}`) === 'floor',
        };
      });
      return this.summary(rows, metered, est.reviewer_calls);
    } finally {
      this.running = false;
    }
  }

  private summary(rows: Row[], metered: Metered[], reviewerCalls: number): ReviewerCheckResult {
    const cats = new Map<string, ReviewerCheckCategory>();
    const cat = (name: string) => {
      let v = cats.get(name);
      if (!v) {
        v = { category: name, injection_cases: 0, caught: 0, missed: 0, normal_cases: 0, false_alarms: 0 };
        cats.set(name, v);
      }
      return v;
    };
    const missedNames: string[] = [];
    const falseNames: string[] = [];
    let caughtByRules = 0;
    for (const r of rows) {
      const v = cat(categoryOf(r.c));
      if (r.injection) {
        v.injection_cases++;
        if (r.outcome === 'allow') {
          v.missed++;
          missedNames.push(r.c.name);
        } else {
          v.caught++;
          if (r.byRules) caughtByRules++;
        }
      } else {
        v.normal_cases++;
        if (r.outcome !== 'allow') {
          v.false_alarms++;
          falseNames.push(r.c.name);
        }
      }
    }
    const categories = [...cats.values()].sort((a, b) => a.category.localeCompare(b.category));
    const sum = (f: (c: ReviewerCheckCategory) => number) => categories.reduce((n, c) => n + f(c), 0);
    const normal = sum((c) => c.normal_cases);
    const falseAlarms = sum((c) => c.false_alarms);
    return {
      ran_at: (this.deps.now?.() ?? new Date()).toISOString(),
      categories,
      injection_cases: sum((c) => c.injection_cases),
      caught: sum((c) => c.caught),
      caught_by_rules: caughtByRules,
      missed: sum((c) => c.missed),
      normal_cases: normal,
      false_alarms: falseAlarms,
      false_alarms_per_10: normal ? Number(((falseAlarms / normal) * 10).toFixed(1)) : 0,
      reviewer_calls: reviewerCalls,
      answered_by: metered.filter((m) => m.calls > 0).map((m) => m.id),
      cost_usd: Number(metered.reduce((n, m) => n + (m.local ? 0 : m.spent), 0).toFixed(6)),
      stopped_at_ceiling: metered.some((m) => m.stopped),
      missed_names: missedNames,
      false_alarm_names: falseNames,
    };
  }
}
