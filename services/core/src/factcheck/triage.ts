/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check triage: how much model a claim needs
 *  Ref      |  DESIGN.md D30 · roadmap TR3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Pick the tier of model that checks each claim, so a
 *           |  small obvious claim never spends a frontier model and a
 *           |  claim that matters never rests on a tiny one.
 *  How      |  Pure rules first. An obvious claim (short, no digits, no
 *           |  names) goes to a tiny model. Numbers, dates, citations,
 *           |  legal, medical or financial words, long or multi-part
 *           |  claims, a claim you marked critical, or any claim in a
 *           |  critical notebook go to standard or better. Everything
 *           |  else is small. A TriageProvider (the decision models)
 *           |  may be set; it can raise a tier or demote nothing below
 *           |  the rules, and any failure falls back to the rules.
 *           |  escalation: up one tier on low confidence, on
 *           |  disagreement with the writer, or when the claim is
 *           |  critical and was checked below standard; at most twice.
 *  Note     |  A tiny model may be the only checker only for an
 *           |  obvious claim, never in a critical notebook (D30).
 * ------------------------------------------------------------------
 */

import { type ModelTier, TIER_RANK } from '@nvx/contracts';
import { tierUp } from '../gateway/tiers';

export interface Triage {
  /** The tier to start at. */
  tier: ModelTier;
  /** Never check below this tier. */
  floor: ModelTier;
  /** Obvious: a tiny model may check it alone, from common knowledge when no source covers it. */
  obvious: boolean;
  /** Matters enough for a second look at standard tier or better. */
  critical: boolean;
  /** One line of why, for the trace. */
  reason: string;
}

export interface TriageContext {
  /** The notebook (or the message) is in mission-critical mode. */
  critical: boolean;
  /** The notebook, so the decision layer applies its privacy rules. */
  notebookId?: string | null;
  /** The thread, whose own limits count when it has left a private notebook. */
  threadId?: string | null;
}

/** What a decision model may be asked (DM1). It sees the claim text only. */
export interface TriageProvider {
  triage(
    claims: string[],
    ctx: TriageContext,
  ): Promise<(Partial<Pick<Triage, 'tier' | 'critical'>> | null)[] | null>;
}

let provider: TriageProvider | null = null;

/** The labels the decision layer sorts claims into, and the tier each one asks for (tiers ascend). */
export const DECISION_TRIAGE_TIERS: Record<string, string> = {
  obvious: 'A short, widely known, stable fact that anyone would agree with, with no numbers or names.',
  ordinary: 'An ordinary factual claim that one reliable source settles.',
  careful:
    'Specific, numerical, legal, medical, financial, recent or contested: a mistake would matter, so it needs a strong model.',
};
const LABEL_TIER: Record<string, Partial<Pick<Triage, 'tier' | 'critical'>>> = {
  obvious: { tier: 'tiny' },
  ordinary: { tier: 'fast' },
  careful: { tier: 'balanced', critical: true },
};

/** What the decision layer's claim sorter offers (decisions/ask.ts decisionTriage, built per call). */
export type ClaimSorter = (ctx: { notebookId?: string | null; threadId?: string | null }) => {
  classify(claims: string[]): Promise<string[]>;
};

/**
 * A TriageProvider over the decision layer. A claim the decision layer did not sort (no decision model,
 * a private notebook it may not reach, an answer that does not fit) comes back as the label `rules`,
 * which maps to nothing, so the rules decide. It never blocks and, like every provider, only raises a tier.
 */
export function fromDecisions(sorter: ClaimSorter): TriageProvider {
  return {
    async triage(claims, ctx) {
      const labels = await sorter({
        notebookId: ctx.notebookId ?? null,
        threadId: ctx.threadId ?? null,
      }).classify(claims);
      return labels.map((l) => LABEL_TIER[l] ?? null);
    },
  };
}

/** Hand the decision layer in (or null to go back to rules only). */
export function setTriageProvider(p: TriageProvider | null): void {
  provider = p;
}

const WEIGHTY =
  /\b(law|legal|illegal|statute|regulation|liab\w*|contract|court|lawsuit|patent|copyright|tax|taxes|dose|dosage|mg|mcg|medic\w*|drug|diagnos\w*|symptom\w*|treatment|surgery|cancer|dosing|invest\w*|loan|mortgage|interest rate|dividend|securities|bankrupt\w*|compliance|safety|toxic|fatal|lethal)\b/i;
const CITATION = /\[\d+\]|\bet al\b|\bibid\b|§|\bdoi:|\bv\.\s|https?:\/\//i;
const DATE = /\b(1[0-9]{3}|20[0-9]{2})\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i;
const MULTI = /;|,\s*(and|but|while|whereas|which)\b|\b(and|but)\b.*\b(and|but)\b/i;

/** Capitalised words that are not the first word: names, places, products. */
function entities(text: string): number {
  const w = text.trim().split(/\s+/);
  return w.slice(1).filter((x) => /^[A-Z][a-z]/.test(x)).length;
}

/** The rules, on one claim. */
export function triageClaim(
  text: string,
  ctx: TriageContext & { marked?: boolean } = { critical: false },
): Triage {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  const base = (tier: ModelTier, reason: string, over: Partial<Triage> = {}): Triage => ({
    tier,
    floor: 'tiny',
    obvious: false,
    critical: false,
    reason,
    ...over,
  });
  if (ctx.critical || ctx.marked)
    return base('balanced', ctx.marked ? 'you marked this claim critical' : 'critical notebook', {
      floor: 'balanced',
      critical: true,
    });
  if (WEIGHTY.test(t)) return base('balanced', 'legal, medical or financial wording', { critical: true });
  if (/\d/.test(t) || DATE.test(t)) return base('balanced', 'has a number or a date');
  if (CITATION.test(t)) return base('balanced', 'cites something');
  if (words > 40 || t.length > 280 || MULTI.test(t)) return base('balanced', 'long or several claims in one');
  if (words <= 12 && t.length <= 90 && entities(t) === 0 && !/["“”]/.test(t))
    return base('tiny', 'short and obvious', { obvious: true });
  return base('fast', 'ordinary');
}

/** Triage every claim: rules, then the decision layer if it is set, never lowering what the rules said. */
export async function triageClaims(claims: string[], ctx: TriageContext): Promise<Triage[]> {
  const rules = claims.map((c) => triageClaim(c, ctx));
  if (!provider || ctx.critical || claims.length === 0) return rules;
  let said: Awaited<ReturnType<TriageProvider['triage']>> = null;
  try {
    said = await provider.triage(claims, ctx);
  } catch {
    return rules;
  }
  if (!said) return rules;
  return rules.map((r, i) => {
    const s = said?.[i];
    if (!s) return r;
    const tier = s.tier && TIER_RANK[s.tier] > TIER_RANK[r.tier] ? s.tier : r.tier;
    const critical = r.critical || s.critical === true;
    return {
      ...r,
      tier: critical && TIER_RANK[tier] < TIER_RANK.balanced ? 'balanced' : tier,
      critical,
      obvious: r.obvious && tier === r.tier && !critical,
      reason: tier !== r.tier || critical ? 'raised by the decision model' : r.reason,
    };
  });
}

/** How far a claim may climb. */
export const MAX_HOPS = 2;

/** What a verifier said, for deciding whether to ask a stronger model. */
export interface EscalationInput {
  /** The tier it was just checked at. */
  tier: ModelTier;
  hops: number;
  verdict: 'supported' | 'partly' | 'contradicted' | 'insufficient';
  /** The model's own confidence in [0, 1], when it gave one. */
  confidence: number | null;
  critical: boolean;
}

/** The tier to try next, or null to stop: low confidence, disagreement with the writer, or criticality. */
export function escalateTo(i: EscalationInput): ModelTier | null {
  if (i.hops >= MAX_HOPS || i.tier === 'best') return null;
  const disagrees = i.verdict === 'contradicted';
  const unsure = i.confidence !== null && i.confidence < 0.6;
  const underChecked = i.critical && TIER_RANK[i.tier] < TIER_RANK.balanced;
  return disagrees || unsure || underChecked ? tierUp(i.tier) : null;
}
