/**
 * ------------------------------------------------------------------
 *  Title    |  Who pays for a model
 *  Ref      |  docs/claude-code.md (Plan or key) · roadmap MD3
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  How answers from a model are paid for. Kept apart from
 *           |  api.ts so a message's usage can record it as it was when
 *           |  the answer was written (roadmap WY1).
 * ------------------------------------------------------------------
 */
import { z } from 'zod';

/** The payer of a `credit` billing: spend comes off the plan's monthly API credit (CR1). */
export const PLAN_CREDIT_PAYER = "Your plan's monthly API credit";

/** How answers from a model are paid for (MD3). */
export const ModelBilling = z
  .object({
    /** plan: a subscription you are signed in to (counted against its limits); key: pay per use on an API key or cloud account; credit: an Anthropic key whose organisation holds your plan's monthly API credit, spent before anything is charged (CR1); local: your own computer or network; rented: a GPU node you pay for by the hour; none: offline test models. */
    kind: z.enum(['plan', 'key', 'credit', 'local', 'rented', 'none']),
    /** Who bills. plan: the plan name as Claude Code reports it ('max', 'pro', 'team', 'enterprise'…), null if unknown. key: the provider id ('anthropic', 'openai', 'openrouter'…) or the cloud ('bedrock', 'vertex', 'foundry') when Claude Code bills one. credit: PLAN_CREDIT_PAYER. Otherwise null. */
    payer: z.string().max(60).nullable(),
  })
  .strict();
export type ModelBilling = z.infer<typeof ModelBilling>;

/**
 * CR1: an Anthropic key may draw on the monthly API credit that comes with a
 * Max or Team plan. The credit lands in one Claude Console organisation; any
 * key from it spends it. Ancile keeps its own count (receipts, not Anthropic's
 * balance, which needs an Admin key).
 */
export const PlanCredit = z
  .object({
    enabled: z.boolean(),
    /** The credit in US dollars each cycle: Max 5x 100, Max 20x 200, Team 20 or 100 a seat (pooled, capped at 500). */
    monthly_usd: z.number().positive().max(10_000),
    /** The day of the month the credit renews, 1 to 31 (a short month renews on its last day). */
    resets_on_day: z.number().int().min(1).max(31),
    /** The person's time zone (IANA name) the cycle is cut in; the browser's, sent when saving. Absent: this computer's. */
    tz: z.string().max(64).optional(),
  })
  .strict();
export type PlanCredit = z.infer<typeof PlanCredit>;

/** PUT /credentials/anthropic/plan-credit. */
export const SavePlanCreditRequest = PlanCredit;
export type SavePlanCreditRequest = PlanCredit;

/** GET /providers/anthropic/credit: Ancile's own count of this cycle's credit spend. */
export const CreditStatus = z.object({
  enabled: z.boolean(),
  monthly_usd: z.number().nonnegative(),
  spent_usd: z.number().nonnegative(),
  left_usd: z.number().nonnegative(),
  /** Share of the credit spent, 0 upwards (can pass 1 when Ancile's count runs behind). */
  used: z.number().nonnegative(),
  cycle_start: z.string(),
  /** When the credit renews (the start of the next cycle), an ISO instant. */
  cycle_ends: z.string(),
  days_left: z.number().int().nonnegative(),
  /** Anthropic refused a call for lack of credit this cycle. */
  exhausted: z.boolean(),
  /** Always true: the figures are Ancile's count from receipts, not Anthropic's balance (that needs an Admin key). */
  counted_by_ancile: z.literal(true),
  /** The zone the cycle is cut in. */
  tz: z.string(),
});
export type CreditStatus = z.infer<typeof CreditStatus>;

/** Anthropic's own explanation of the credit, linked from Settings. */
export const PLAN_CREDIT_ARTICLE = 'https://support.claude.com/en/articles/17154008';

/**
 * CR1 + RT1: the routing goal "Spend expiring credit first". In the last
 * `last_days` of a cycle, with credit left, a model paid from the monthly
 * credit goes ahead of an equal one on another bill. Off by default.
 */
export const CreditRouting = z
  .object({
    spend_credit_first: z.boolean(),
    last_days: z.number().int().min(1).max(31),
  })
  .strict();
export type CreditRouting = z.infer<typeof CreditRouting>;
export const DEFAULT_CREDIT_ROUTING: CreditRouting = { spend_credit_first: false, last_days: 5 };
