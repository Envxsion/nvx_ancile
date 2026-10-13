/**
 * ------------------------------------------------------------------
 *  Title    |  Cost calculator
 *  Ref      |  docs/openrouter.md (Cost calculator)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What a turn, a day and a month cost on each endpoint
 *           |  of a model, ranked by the real invoice (cache reads
 *           |  and writes included) rather than list price; with
 *           |  Claude Code's plan headroom and a RunPod break-even
 *           |  beside it.
 *  How      |  estimateCost() is pure. The hit rate is the one given,
 *           |  else this person's own for the model (usage history),
 *           |  else none. A month is 30 days.
 * ------------------------------------------------------------------
 */

import type { CostEstimate, CostEstimateRequest, EndpointsReport, UsageHistory } from '@nvx/contracts';
import { turnCostUsd } from './routing';

const money = (n: number) => Math.round(n * 1e6) / 1e6;

/** Hit rate and input share for a model from history: the provider's row if given, else all rows. */
export function mixFor(
  history: UsageHistory | null,
  model: string,
  provider?: string | null,
): { cacheHitRate: number; inputShare: number } | null {
  const rows = (history?.rows ?? []).filter(
    (r) => r.model_id === model && (provider === undefined || r.provider === provider),
  );
  const input = rows.reduce((a, r) => a + r.input_tokens, 0);
  const output = rows.reduce((a, r) => a + r.output_tokens, 0);
  const cached = rows.reduce((a, r) => a + r.cached_tokens, 0);
  if (input + output === 0) return null;
  return { cacheHitRate: input ? Math.min(1, cached / input) : 0, inputShare: input / (input + output) };
}

export function estimateCost(
  req: CostEstimateRequest,
  report: EndpointsReport,
  opts: {
    history: UsageHistory | null;
    /** The ancile model id the history is recorded under, when it differs from the slug. */
    modelId?: string;
    planUsedPercent?: number | null;
    planKnown?: boolean;
  },
): CostEstimate {
  const mix = mixFor(opts.history, opts.modelId ?? req.model);
  const hit = req.cache_hit_rate ?? mix?.cacheHitRate ?? 0;
  const from: CostEstimate['cache_hit_from'] =
    req.cache_hit_rate !== null ? 'given' : mix ? 'history' : 'none';
  const t = {
    input: req.input_tokens,
    output: req.output_tokens,
    cacheWrite: req.cache_write_tokens,
    hitRate: hit,
  };
  const rows = report.endpoints
    .map((e) => {
      const turn = turnCostUsd(e.price, t);
      return {
        provider: e.provider,
        per_turn: money(turn),
        per_day: money(turn * req.messages_per_day),
        per_month: money(turn * req.messages_per_day * 30),
        list_per_turn: money((req.input_tokens * e.price.input + req.output_tokens * e.price.output) / 1e6),
        fits:
          (e.context === null || req.input_tokens + req.output_tokens <= e.context) &&
          (e.max_output === null || req.output_tokens <= e.max_output),
      };
    })
    .sort((a, b) => Number(b.fits) - Number(a.fits) || a.per_turn - b.per_turn);

  let runpod: CostEstimate['runpod'] = null;
  if (req.gpu_usd_per_hour !== null) {
    const cheapest = rows.find((r) => r.fits) ?? rows[0];
    const tokensPerTurn = req.input_tokens + req.output_tokens;
    const perToken = cheapest && tokensPerTurn ? cheapest.per_turn / tokensPerTurn : 0;
    const gpuMonth = req.gpu_usd_per_hour * 24 * 30;
    runpod = {
      usd_per_hour: req.gpu_usd_per_hour,
      break_even_tokens_per_month: perToken > 0 ? Math.round(gpuMonth / perToken) : null,
      hours_needed_per_month:
        req.gpu_tokens_per_second !== null
          ? Math.round(
              ((req.output_tokens * req.messages_per_day * 30) / req.gpu_tokens_per_second / 3600) * 10,
            ) / 10
          : null,
    };
  }
  const claude_code: CostEstimate['claude_code'] = opts.planKnown
    ? {
        used_percent: opts.planUsedPercent ?? null,
        note:
          opts.planUsedPercent === null || opts.planUsedPercent === undefined
            ? 'Claude Code is on a plan: turns cost no money, but count against its limits.'
            : `Claude Code's plan is ${Math.round(opts.planUsedPercent)}% used in its busiest window. Turns there cost no money until it runs out.`,
      }
    : null;
  return { model: report.model, cache_hit_rate: hit, cache_hit_from: from, rows, runpod, claude_code };
}
