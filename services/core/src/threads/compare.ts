/**
 * ------------------------------------------------------------------
 *  Title    |  Compare two branches
 *  Ref      |  DESIGN.md §8.3, prompts/threads/compare.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Two paths through one thread, from where they diverge:
 *           |  what each side contains, what it cost, and a short
 *           |  model-written account of how they differ.
 *  How      |  Lowest common ancestor of the two root-to-head paths,
 *           |  then per-side metrics from stored usage. The summary is
 *           |  a utility call; when no model can write it, or its JSON
 *           |  does not parse, a plain computed comparison stands in.
 * ------------------------------------------------------------------
 */

import {
  BranchComparison,
  type BranchComparison as BranchComparisonT,
  type CompareResult,
} from '@nvx/contracts';
import type { SummaryRecord } from './branches';
import { compactedPath, transcript } from './compact';
import { ancestorPath, lowestCommonAncestor } from './path';
import { asTree, type MessageRecord, type TreeRecord, textOf } from './repo';
import { readJson, runUtility, type UtilityDeps } from './utility';

export function sideMetrics(msgs: MessageRecord[]) {
  const replies = msgs.filter((m) => m.role === 'assistant');
  const confidences = replies
    .map((m) => (m.provenance as { factcheck?: { confidence?: number } }).factcheck?.confidence)
    .filter((c): c is number => typeof c === 'number');
  return {
    messages: msgs.length,
    models: [...new Set(replies.flatMap((m) => (m.model_id ? [m.model_id] : [])))],
    input_tokens: replies.reduce((n, m) => n + (m.usage?.input_tokens ?? 0), 0),
    output_tokens: replies.reduce((n, m) => n + (m.usage?.output_tokens ?? 0), 0),
    cost_usd: replies.reduce((n, m) => n + (m.usage?.cost_usd ?? 0), 0),
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
  };
}

const words = (msgs: MessageRecord[]) =>
  msgs.reduce((n, m) => n + (textOf(m.parts).match(/\S+/g)?.length ?? 0), 0);

/** Without a model: say what can be counted, and nothing more. */
export function computedComparison(a: MessageRecord[], b: MessageRecord[]): BranchComparisonT {
  const ma = sideMetrics(a);
  const mb = sideMetrics(b);
  const differences = [
    {
      aspect: 'Length',
      a: `${words(a)} words in ${a.length} messages`,
      b: `${words(b)} words in ${b.length} messages`,
    },
  ];
  if (ma.models.join() !== mb.models.join())
    differences.push({
      aspect: 'Models',
      a: ma.models.join(', ') || 'none',
      b: mb.models.join(', ') || 'none',
    });
  return {
    summary: 'No model was available to read both branches, so this compares only what can be counted.',
    differences,
    better_for: { a: 'Read it to judge.', b: 'Read it to judge.' },
  };
}

const FALLBACK =
  'Compare two branches of a conversation.\n\nShared context:\n{{shared_context_summary}}\n\nBranch A ({{model_a}}):\n{{branch_a}}\n\nBranch B ({{model_b}}):\n{{branch_b}}\n\nReturn JSON: {"summary": "...", "differences": [{"aspect": "...", "a": "...", "b": "..."}], "better_for": {"a": "...", "b": "..."}}';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[…cut]` : s);

export async function compareBranches(
  deps: UtilityDeps,
  opts: {
    threadId: string;
    messages: MessageRecord[];
    summaries: SummaryRecord[];
    a: string;
    b: string;
    signal?: AbortSignal;
  },
): Promise<CompareResult> {
  const byId = new Map(asTree(opts.messages).map((m) => [m.id, m] as const));
  const pa = ancestorPath(byId, opts.a);
  const pb = ancestorPath(byId, opts.b);
  const { lca, aRest, bRest } = lowestCommonAncestor<TreeRecord>(pa, pb);
  const shared = lca ? pa.slice(0, pa.findIndex((m) => m.id === lca.id) + 1) : [];

  let comparison: BranchComparisonT | null = null;
  let model: string | null = null;
  if (aRest.length || bRest.length) {
    const sharedView = compactedPath(shared, opts.summaries, 2);
    const sharedText = [
      ...(sharedView.summary ? [sharedView.summary.content] : []),
      transcript(sharedView.messages.slice(-6)),
    ].join('\n\n');
    const ma = sideMetrics(aRest);
    const mb = sideMetrics(bRest);
    const res = await runUtility(deps, {
      promptId: 'threads.compare',
      fallback: FALLBACK,
      vars: {
        shared_context_summary: clip(
          sharedText || '(none: the branches differ from the first message)',
          6_000,
        ),
        branch_a: clip(transcript(aRest), 12_000),
        branch_b: clip(transcript(bRest), 12_000),
        model_a: ma.models.join(', ') || 'no model',
        model_b: mb.models.join(', ') || 'no model',
      },
      ...(opts.signal && { signal: opts.signal }),
      maxOutputTokens: 1_200,
    }).catch(() => null);
    const parsed = res ? readJson(res.text, BranchComparison) : null;
    comparison = parsed ?? computedComparison(aRest, bRest);
    model = parsed ? (res?.modelId ?? null) : null;
  }

  return {
    thread_id: opts.threadId,
    lca_id: lca?.id ?? null,
    shared: shared.length,
    a: { head_id: opts.a, message_ids: aRest.map((m) => m.id), metrics: sideMetrics(aRest) },
    b: { head_id: opts.b, message_ids: bRest.map((m) => m.id), metrics: sideMetrics(bRest) },
    comparison,
    comparison_model: model,
  };
}
