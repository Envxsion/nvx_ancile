/**
 * ------------------------------------------------------------------
 *  Title    |  Model-choosing assistant
 *  Ref      |  docs/openrouter.md (Choosing a model)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  From a sentence or a job type and a few constraints,
 *           |  recommend two or three models across OpenRouter, this
 *           |  computer (Ollama), RunPod and Claude Code, each with
 *           |  plain reasons and the routing preset to use.
 *  How      |  advise() is pure and deterministic: every candidate
 *           |  gets a score from what the job needs (tools, window,
 *           |  reasoning), the budget, privacy and speed, and how it
 *           |  has done for this person (usage history). The top
 *           |  three are kept, one per place where possible.
 *  Note     |  Never calls a paid model. An optional short
 *           |  explanation comes from a local model (service, not here).
 * ------------------------------------------------------------------
 */

import type {
  AdvisorOption,
  AdvisorRequest,
  AdvisorResult,
  JobKind,
  ModelInfo,
  RoutingPreset,
  UsageHistory,
} from '@nvx/contracts';

export interface Candidate {
  id: string;
  name: string;
  provider: string;
  via: 'direct' | 'controller';
  context: number;
  capabilities: string[];
  /** USD per million tokens; 0 for local and plan models. */
  input: number;
  output: number;
  /** Not yet on this computer: a suggestion to download. */
  suggestion?: boolean;
}

/** What a job looks like: typical turn size and what it needs. */
const JOBS: Record<
  JobKind,
  {
    input: number;
    output: number;
    tools: boolean;
    context: number;
    reasoning: boolean;
    preset: RoutingPreset;
  }
> = {
  agent_tools: {
    input: 12_000,
    output: 1_500,
    tools: true,
    context: 64_000,
    reasoning: false,
    preset: 'recommended',
  },
  long_documents: {
    input: 80_000,
    output: 2_000,
    tools: false,
    context: 128_000,
    reasoning: false,
    preset: 'best_quality',
  },
  chat: { input: 3_000, output: 600, tools: false, context: 16_000, reasoning: false, preset: 'recommended' },
  coding: {
    input: 20_000,
    output: 3_000,
    tools: true,
    context: 100_000,
    reasoning: false,
    preset: 'recommended',
  },
  reasoning: {
    input: 4_000,
    output: 12_000,
    tools: false,
    context: 32_000,
    reasoning: true,
    preset: 'best_quality',
  },
  cheap_bulk: {
    input: 1_500,
    output: 300,
    tools: false,
    context: 8_000,
    reasoning: false,
    preset: 'lowest_cost',
  },
};

/** A job type from a sentence, by plain keywords; chat when nothing matches. */
export function guessKind(text: string): JobKind {
  const t = text.toLowerCase();
  if (/\b(tool|agent|browse|search the web|api calls?|automat)/.test(t)) return 'agent_tools';
  if (/\b(code|coding|refactor|bug|repo|program|typescript|python)/.test(t)) return 'coding';
  if (/\b(pdf|document|book|contract|long|report|transcript|papers?)\b/.test(t)) return 'long_documents';
  if (/\b(maths?|math|proof|reason|logic|puzzle|plan|think)/.test(t)) return 'reasoning';
  if (/\b(bulk|thousands|classif|tag|label|cheap|batch|extract)/.test(t)) return 'cheap_bulk';
  return 'chat';
}

export const whereOf = (c: Pick<Candidate, 'provider' | 'via'>): AdvisorOption['where'] => {
  if (c.via === 'controller' || c.provider === 'node') return 'runpod';
  if (c.provider === 'ollama') return 'local';
  if (c.provider === 'openrouter') return 'openrouter';
  if (c.provider === 'claude-code' || c.provider === 'claudecode') return 'claude_code';
  return 'direct';
};

export function fromInfo(m: ModelInfo): Candidate {
  return {
    id: m.id,
    name: m.display_name,
    provider: m.provider,
    via: m.via,
    context: m.context_window,
    capabilities: m.capabilities,
    input: m.price.input_per_mtok,
    output: m.price.output_per_mtok,
  };
}

const fmtUsd = (n: number) => (n < 0.01 ? 'under 1 cent' : `$${n.toFixed(2)}`);

export function advise(
  req: AdvisorRequest,
  candidates: Candidate[],
  history: UsageHistory | null,
): Omit<AdvisorResult, 'explanation'> {
  const kind = req.kind ?? guessKind(req.describe);
  const job = JOBS[kind];
  const used = new Map<string, number>();
  for (const r of history?.rows ?? []) used.set(r.model_id, (used.get(r.model_id) ?? 0) + r.answers);
  const budgetCap = { low: 1, medium: 10, high: Number.POSITIVE_INFINITY }[req.budget];

  const scored: AdvisorOption[] = [];
  for (const c of candidates) {
    const where = whereOf(c);
    const reasons: string[] = [];
    if (c.capabilities.includes('embeddings') || c.capabilities.includes('rerank')) continue;
    if (req.privacy === 'local_only' && where !== 'local' && where !== 'runpod') continue;
    if (job.tools && !c.capabilities.includes('tools')) continue;
    let score = 50;
    const perK = ((job.input * c.input + job.output * c.output) / 1e6) * 1_000;
    const priced = where === 'openrouter' || where === 'direct';
    if (c.context >= job.context) {
      score += 15;
      reasons.push(`Reads up to ${c.context.toLocaleString('en-GB')} tokens, enough for this job.`);
    } else {
      score -= 25 * (1 - c.context / job.context);
      reasons.push(`Reads only ${c.context.toLocaleString('en-GB')} tokens; long inputs get trimmed.`);
    }
    if (job.tools) reasons.push('Can call tools.');
    if (job.reasoning) {
      if (c.capabilities.includes('reasoning')) {
        score += 20;
        reasons.push('Thinks before it answers.');
      } else score -= 10;
    }
    if (priced) {
      if (perK > budgetCap) score -= 30;
      score -= Math.min(20, Math.log10(1 + perK) * 8);
      reasons.push(`About ${fmtUsd(perK)} per 1,000 turns of this size.`);
    } else if (where === 'local') {
      score += req.budget === 'low' ? 15 : 5;
      reasons.push('Runs on this computer: nothing to pay, nothing leaves it.');
      if (job.context > 32_000) score -= 10;
    } else if (where === 'runpod') {
      score += req.privacy !== 'any' ? 10 : 0;
      reasons.push('Runs on your own rented GPU: paid by the hour, prompts stay with you.');
    } else if (where === 'claude_code') {
      score += kind === 'coding' ? 20 : 0;
      reasons.push('Uses your Claude plan: no per-token bill, but counts against its limits.');
    }
    if (req.privacy === 'no_training' && where === 'openrouter')
      reasons.push('Use with "Do not allow data collection" on.');
    if (req.speed === 'fast' && where === 'local') score -= 10;
    if (c.suggestion) {
      score -= 8;
      reasons.push('Not downloaded yet.');
    }
    const n = used.get(c.id) ?? 0;
    if (n > 0) {
      score += Math.min(10, Math.log2(1 + n) * 2);
      reasons.push(`You have used it for ${n.toLocaleString('en-GB')} answers this month.`);
    }
    scored.push({
      where,
      model_id: c.id,
      name: c.name,
      score: Math.round(score * 10) / 10,
      reasons,
      preset: where === 'openrouter' ? (req.speed === 'fast' ? 'fastest' : job.preset) : null,
      cost_per_1k_turns: priced ? Math.round(perK * 10_000) / 10_000 : null,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.model_id.localeCompare(b.model_id));
  // One per place first, so the choice is a real choice; then the best of the rest.
  const picked: AdvisorOption[] = [];
  const places = new Set<string>();
  for (const o of scored)
    if (picked.length < 3 && !places.has(o.where)) {
      picked.push(o);
      places.add(o.where);
    }
  for (const o of scored) if (picked.length < 3 && !picked.includes(o)) picked.push(o);
  picked.sort((a, b) => b.score - a.score);
  return { kind, options: picked };
}
