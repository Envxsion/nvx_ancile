/**
 * ------------------------------------------------------------------
 *  Title    |  Usage: what NVX Ancile and Claude Code have used
 *  Ref      |  docs/api.md (Usage) · docs/claude-code.md (Usage)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes behind Settings → Usage: Claude Code's plan
 *           |  limits (the 5-hour session and the week), and personal
 *           |  token and cost totals across every engine.
 *  How      |  GET /usage?range=day|week|month&tz=<IANA zone> answers a
 *           |  UsageReport; GET /claude-code/plan-limits answers
 *           |  ClaudeCodePlanLimits (?refresh=1 asks Claude Code now).
 *  Note     |  Costs are what Ancile recorded. Claude Code's are its own
 *           |  estimate at API list prices, never a bill. Nothing here
 *           |  names an account, an email or an organisation.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';
import { CreditStatus } from './billing';

export const UsageRange = z.enum(['day', 'week', 'month']);
export type UsageRange = z.infer<typeof UsageRange>;

/** Where tokens were spent: the model gateway (chat, flows), Claude Code, the lab, or anything else. */
export const UsageEngine = z.enum(['gateway', 'claude_code', 'lab', 'other']);
export type UsageEngine = z.infer<typeof UsageEngine>;

export const UsageTotals = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  /** Recorded cost in US dollars (Claude Code's part is an estimate at API list prices). */
  cost_usd: z.number().nonnegative(),
  /** Chat answers counted; other model calls (a fact-check, a title…) are counted under by_purpose.calls. */
  answers: z.number().int().nonnegative(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const UsageReport = z.object({
  range: UsageRange,
  /** The time zone buckets were cut in. */
  tz: z.string(),
  from: z.string(),
  to: z.string(),
  /** hour for a day, day for a week or a month. */
  bucket: z.enum(['hour', 'day']),
  totals: UsageTotals,
  /** Every bucket in the range, oldest first, empty ones included. */
  series: z.array(
    z.object({
      start: z.string(),
      tokens: z.number().int().nonnegative(),
      cost_usd: z.number().nonnegative(),
      by_engine: z.record(z.string(), z.number().int().nonnegative()),
    }),
  ),
  by_engine: z.array(UsageTotals.extend({ engine: UsageEngine })),
  /** The busiest models by tokens; the rest fold into one "other models" row (model_id null). */
  by_model: z.array(UsageTotals.extend({ model_id: z.string().nullable(), engine: UsageEngine })),
  /**
   * What the spend was for: chat answers, and every other model call Ancile made (factcheck, memory,
   * decision, permission, title, compare, thread, web, knowledge, other). `calls` counts model calls
   * (a chat answer is one call); `answers` stays the chat answers only.
   */
  by_purpose: z
    .array(UsageTotals.extend({ purpose: z.string(), calls: z.number().int().nonnegative() }))
    .default([]),
  /** OpenRouter answers by the provider that served them (GET /usage?provider= narrows the report to one). */
  by_provider: z.array(UsageTotals.extend({ provider: z.string() })).default([]),
  /** Part of cost_usd that is Claude Code's own estimate at API list prices. */
  estimated_cost_usd: z.number().nonnegative(),
  /** CR1: the plan's monthly API credit this cycle (Ancile's own count); absent when it is not set up. */
  credit: CreditStatus.nullable().optional(),
});
export type UsageReport = z.infer<typeof UsageReport>;

/** One plan window, as Claude Code last reported it. */
export const PlanWindow = z.object({
  /** five_hour, seven_day, seven_day_opus, seven_day_sonnet, overage, or model:<label>. */
  id: z.string(),
  /** session: the 5-hour window; week: the weekly one; week_model: a model's weekly one. */
  kind: z.enum(['session', 'week', 'week_model', 'other']),
  /** The server's own label for a model window (e.g. "Opus"); null for the others. */
  label: z.string().nullable(),
  /** Share used, 0 to 100; null when Claude Code did not say. */
  percent: z.number().min(0).max(100).nullable(),
  resets_at: z.string().nullable(),
  /** From a rate_limit_event: allowed, allowed_warning or rejected. */
  status: z.enum(['allowed', 'allowed_warning', 'rejected']).nullable(),
  updated_at: z.string(),
});
export type PlanWindow = z.infer<typeof PlanWindow>;

export const ClaudeCodePlanLimits = z.object({
  /** true: a Claude plan sign-in; false: limits do not apply (API key and the like); null: not known yet. */
  available: z.boolean().nullable(),
  /** The plan's kind ("pro", "max", …) when Claude Code says; never the account. */
  plan: z.string().nullable(),
  windows: z.array(PlanWindow),
  updated_at: z.string().nullable(),
  /** Where the figures came from: Claude Code's usage report, or the limits it reports while working. */
  source: z.enum(['usage', 'event']).nullable(),
  /** Claude Code is installed and verified, so a refresh can ask it. */
  can_refresh: z.boolean(),
});
export type ClaudeCodePlanLimits = z.infer<typeof ClaudeCodePlanLimits>;

/** What NVX Ancile measured of Claude Code on this computer (GET /claude-code/usage). */
export const ClaudeCodeUsage = z.object({
  tz: z.string(),
  today: UsageTotals,
  /** The last 7 days, today included. */
  week: UsageTotals,
  /** Of what Claude Code read over the 7 days, the share its prompt cache served (0 to 1); null with nothing read. */
  cache_hit_rate: z.number().min(0).max(1).nullable(),
  /** The 7 days by local day, oldest first. */
  days: z.array(
    z.object({
      start: z.string(),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cached_tokens: z.number().int().nonnegative(),
    }),
  ),
  /** The busiest Claude Code threads over the 7 days, by tokens. */
  by_thread: z.array(UsageTotals.extend({ thread_id: z.string(), title: z.string().nullable() })),
  /**
   * Of the 7 days, the answers brought in from Claude Code's own transcripts
   * (sessions run in the terminal and imported), already inside `week`; the
   * rest a turn in NVX Ancile wrote. `sessions` counts the sessions they came from.
   */
  imported: UsageTotals.extend({ sessions: z.number().int().nonnegative() }),
});
export type ClaudeCodeUsage = z.infer<typeof ClaudeCodeUsage>;
