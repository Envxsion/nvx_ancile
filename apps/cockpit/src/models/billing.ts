/**
 * ------------------------------------------------------------------
 *  Title    |  Who pays for a model
 *  Ref      |  docs/claude-code.md (Plan or key) · roadmap MD3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The same Claude model can answer on your Claude plan
 *           |  (as Claude Code) or on an API key. These helpers say
 *           |  which, in the same words everywhere a model is listed.
 *  How      |  Pure functions over the `billing` Core sends with every
 *           |  model. A model that exists both ways gets a short
 *           |  suffix on its name so the two can be told apart.
 *  Note     |  Plain words, no price for plans. Provider names come
 *           |  from the one PROVIDER_NAME map in lib/mappers.ts.
 * ------------------------------------------------------------------
 */

import type { ModelBilling } from '@nvx/contracts';
import { isClaudeCodeModel } from '@nvx/contracts/engines';
import { usd } from '../lib/format';
import { PROVIDER_NAME } from '../lib/mappers';
import type { ModelView } from '../lib/types';
import { type OffPeakRates, offPeakLabel } from './offPeak';

/** Claude Code bills these clouds itself; their names in words. */
const CLOUD_NAME: Record<string, string> = {
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

/** "Your Claude Max plan", or "Your Claude plan" when the plan is not known. */
function planWords(payer: string | null): string {
  return payer ? `Your Claude ${cap(payer)} plan` : 'Your Claude plan';
}

/** Who bills, in words: "Your Claude Max plan", "Anthropic API key, pay per use", "Your computer". */
export function billingWords(b: ModelBilling): string {
  switch (b.kind) {
    case 'plan':
      return planWords(b.payer);
    case 'key': {
      const cloud = b.payer ? CLOUD_NAME[b.payer] : undefined;
      if (cloud) return `${cloud}, pay per use`;
      const name = b.payer ? (PROVIDER_NAME[b.payer] ?? cap(b.payer)) : 'API';
      return `${name} API key, pay per use`;
    }
    case 'credit':
      return b.payer ?? "Your plan's monthly API credit";
    case 'local':
      return 'Your computer';
    case 'rented':
      return 'Rented GPU, billed by the hour';
    case 'none':
      return 'Offline test model, no cost';
  }
}

/** The short badge for lists. */
export function billingBadge(b: ModelBilling): string {
  return {
    plan: 'Plan',
    key: 'Key',
    credit: 'Included credit',
    local: 'Local',
    rented: 'Rented',
    none: 'Test',
  }[b.kind];
}

const perMillion = (n: number) => usd(n, Number.isInteger(n) ? 0 : 2);

/** The badge's tooltip: who bills, and the price for a key. */
export function billingTitle(
  b: ModelBilling,
  price?: { in: number; out: number; offPeak?: OffPeakRates } | null,
): string {
  const words = billingWords(b);
  if (b.kind === 'plan') return `${words}, counted against its limits`;
  if (b.kind === 'credit') {
    const base = `${words}, spent before anything is charged`;
    return price && (price.in > 0 || price.out > 0)
      ? `${base}: ${perMillion(price.in)} in, ${perMillion(price.out)} out per million tokens`
      : base;
  }
  if (b.kind === 'key' && price && (price.in > 0 || price.out > 0)) {
    const line = `${words}: ${perMillion(price.in)} in, ${perMillion(price.out)} out per million tokens`;
    return price.offPeak ? `${line}. ${offPeakLabel(price, price.offPeak)}` : line;
  }
  return words;
}

/** A model's badge: a GPU node on your network keeps its own name. Null when Core sent no billing. */
export function modelBadge(m: Pick<ModelView, 'billing' | 'via'>): string | null {
  if (!m.billing) return null;
  return m.billing.kind === 'local' && m.via === 'controller' ? 'GPU node' : billingBadge(m.billing);
}

const LINES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** An Anthropic API model: on a plain key, or on the key that draws on the plan's monthly credit (CR1). */
const anthropicKeyed = (m: Pick<ModelView, 'id' | 'billing'>): boolean =>
  !isClaudeCodeModel(m.id) &&
  !!m.billing &&
  (m.billing.kind === 'credit' || (m.billing.kind === 'key' && m.billing.payer === 'anthropic'));
const ready = (m: ModelView) => m.chat !== false && (m.status === undefined || m.status === 'ready');

/** Which Claude line (opus, sonnet, haiku, fable) a Claude Code or Anthropic model is, or null. */
export function claudeLine(m: Pick<ModelView, 'id'>): string | null {
  const tail = (isClaudeCodeModel(m.id) ? m.id.slice(m.id.indexOf('/') + 1) : m.id).toLowerCase();
  return LINES.find((l) => tail.includes(l)) ?? null;
}

/**
 * Claude lines that can answer both on your plan (Claude Code) and on an
 * Anthropic API key. Returns the ids of both sides, which need a suffix.
 */
export function sameModelBothWays(models: ModelView[]): Set<string> {
  const plan = new Map<string, string[]>();
  const key = new Map<string, string[]>();
  for (const m of models) {
    if (!ready(m) || !m.billing) continue;
    const line = claudeLine(m);
    if (!line) continue;
    if (isClaudeCodeModel(m.id) && m.billing.kind === 'plan')
      plan.set(line, [...(plan.get(line) ?? []), m.id]);
    else if (anthropicKeyed(m)) key.set(line, [...(key.get(line) ?? []), m.id]);
  }
  const out = new Set<string>();
  for (const [line, ids] of plan) {
    const other = key.get(line);
    if (!other) continue;
    for (const id of [...ids, ...other]) out.add(id);
  }
  return out;
}

/** The model's name, with " · Max plan" or " · API key" only when the same model exists both ways. */
export function displayName(
  m: Pick<ModelView, 'id' | 'name' | 'billing'>,
  dupes: ReadonlySet<string>,
): string {
  if (!dupes.has(m.id) || !m.billing) return m.name;
  if (m.billing.kind === 'plan')
    return `${m.name} · ${m.billing.payer ? `${cap(m.billing.payer)} plan` : 'Plan'}`;
  if (m.billing.kind === 'key') return `${m.name} · API key`;
  if (m.billing.kind === 'credit' && !isClaudeCodeModel(m.id)) return `${m.name} · Included credit`;
  return m.name;
}

/**
 * The Claude Code model whose plan could answer this key-billed Anthropic
 * model instead: the same line, ready, on a plan. Null when there is none.
 */
export function planTwinOf(model: ModelView | undefined, models: ModelView[]): ModelView | null {
  if (!model || !anthropicKeyed(model)) return null;
  const line = claudeLine(model);
  if (!line) return null;
  return (
    models.find(
      (m) => isClaudeCodeModel(m.id) && ready(m) && m.billing?.kind === 'plan' && claudeLine(m) === line,
    ) ?? null
  );
}
