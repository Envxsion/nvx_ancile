/**
 * ------------------------------------------------------------------
 *  Title    |  Retrieval
 *  Ref      |  DESIGN.md §1.3 (stage: retrieval) · ROADMAP.md Phase 3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Before a model answers a question asked in a notebook,
 *           |  find the passages in that notebook's sources that best
 *           |  match it, and hand them to the model numbered, so its
 *           |  answer can cite them.
 *  How      |  One hybrid search per turn through the knowledge
 *           |  service (vector + text, fused, reranked), scoped to the
 *           |  notebook; its context levels decide what is eligible.
 *           |  A short follow-up ("and in 2023?") is searched together
 *           |  with the question before it, so it is not searched
 *           |  alone and meaningless. The block is capped so sources
 *           |  can never crowd out the conversation, and so is each
 *           |  source's share (per_source_max in config/retrieval.yaml),
 *           |  so one huge source cannot crowd out the others.
 *  Note     |  A knowledge service that is down does not stop the
 *           |  answer: the turn goes on ungrounded and says so in its
 *           |  provenance.
 * ------------------------------------------------------------------
 */

import type { RetrievalTrace, SearchResponse } from '@nvx/contracts';
import type { KnowledgeClient } from '../knowledge/client';

export interface Retriever {
  search(input: {
    workspaceId: string;
    notebookId: string;
    query: string;
    k: number;
    /** Only these sources (the user @-mentioned them). */
    sourceIds?: string[];
  }): Promise<SearchResponse>;
}

/** How many passages a turn is given, and how many of them one source may give (config/retrieval.yaml). */
export interface RetrievalLimits {
  k: number;
  perSource: number;
}

export const DEFAULT_K = 8;
export const DEFAULT_LIMITS: RetrievalLimits = { k: DEFAULT_K, perSource: 4 };

/** How many to ask the search for, so that k can still be filled after the per-source cap. */
export function fetchK(k: number, perSource: number): number {
  return perSource >= k ? k : Math.min(100, k * 3);
}

/**
 * Keep the ranking, but let no source give more than `perSource` passages,
 * and stop at k. A 2,000-page PDF matches almost anything; without this it
 * would fill every turn and crowd out the notebook's other sources.
 */
export function capPerSource<T extends { source_id: string }>(hits: T[], k: number, perSource: number): T[] {
  const taken = new Map<string, number>();
  const out: T[] = [];
  for (const h of hits) {
    if (out.length >= k) break;
    const n = taken.get(h.source_id) ?? 0;
    if (n >= perSource) continue;
    taken.set(h.source_id, n + 1);
    out.push(h);
  }
  return out;
}

export function knowledgeRetriever(
  kn: KnowledgeClient,
  limits: Pick<RetrievalLimits, 'perSource'> = DEFAULT_LIMITS,
): Retriever {
  return {
    search: async ({ workspaceId, notebookId, query, k, sourceIds }) => {
      const res = await kn.post<SearchResponse>('/search', {
        workspace_id: workspaceId,
        notebook_id: notebookId,
        ...(sourceIds?.length && { source_ids: sourceIds }),
        query,
        k: fetchK(k, limits.perSource),
        mode: 'hybrid',
        rerank: true,
      });
      return { ...res, hits: capPerSource(res.hits, k, limits.perSource) };
    },
  };
}

/** The total size of the sources block, in characters (about 4,000 tokens). */
export const BLOCK_CHARS = 16_000;
const PASSAGE_CHARS = 1_800;

/** What to search for: the question, plus the one before it when it is a short follow-up. */
export function queryFor(questions: string[]): string {
  const last = (questions.at(-1) ?? '').trim();
  const prev = (questions.at(-2) ?? '').trim();
  const words = last.split(/\s+/).filter(Boolean).length;
  if (prev && words > 0 && words < 8) return `${prev}\n${last}`.slice(0, 4_000);
  return last.slice(0, 4_000);
}

export interface Grounding {
  trace: RetrievalTrace;
  /** The passages as the model sees them; empty when nothing was found. */
  block: string;
  /** Where each numbered passage sits in its source, for citation_ref parts. */
  spans: [number, { char_start: number; char_end: number; text: string }][];
}

/** Number the hits and write them as the model will read them. */
export function groundingFrom(
  res: SearchResponse,
  meta: {
    query: string;
    notebookId: string | null;
    notebookTitle: string | null;
    /** Passages read through a context link, by chunk id (conductor/links.ts). */
    via?: ReadonlyMap<string, { link_id: string; notebook_id: string; notebook_title: string }>;
  },
): Grounding {
  let used = 0;
  const hits: RetrievalTrace['hits'] = [];
  const spans: Grounding['spans'] = [];
  const lines: string[] = [];
  for (const h of res.hits) {
    const text = h.text.length > PASSAGE_CHARS ? `${h.text.slice(0, PASSAGE_CHARS)}…` : h.text;
    if (used + text.length > BLOCK_CHARS && hits.length > 0) break;
    used += text.length;
    const marker = hits.length + 1;
    const via = meta.via?.get(h.chunk_id);
    hits.push({
      marker,
      kind: h.kind,
      chunk_id: h.chunk_id,
      source_id: h.source_id,
      source_title: h.source_title,
      page: h.page,
      score: h.score,
      rerank_score: h.rerank_score,
      ranks: h.ranks,
      cited: false,
      ...(via && { via }),
    });
    const where = [
      h.source_title,
      via ? `from the linked notebook "${via.notebook_title}"` : null,
      h.page != null ? `page ${h.page}` : null,
      h.heading_path.length ? h.heading_path.join(' › ') : null,
      h.kind === 'insight' ? 'summary' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    spans.push([marker, { char_start: h.char_start, char_end: h.char_end, text: h.text }]);
    lines.push(`[${marker}] ${where}\n"""\n${text.replace(/"""/g, '"​""')}\n"""`);
  }
  const trace: RetrievalTrace = {
    query: meta.query,
    notebook_id: meta.notebookId,
    mode: res.mode,
    embedder: res.embedder,
    ms: res.ms,
    hits,
    invalid_markers: 0,
    grounded: false,
  };
  if (!hits.length) return { trace, block: '', spans };
  const name = !meta.notebookId
    ? null
    : meta.notebookTitle
      ? `the notebook "${meta.notebookTitle}"`
      : 'this notebook';
  const linked = hits.some((h) => h.via);
  const block = [
    name
      ? `You are answering inside ${name}. Numbered passages from its sources follow.`
      : 'Numbered passages from the notebooks linked to this thread follow.',
    ...(linked && name
      ? ['Some come from notebooks linked to this one; each of those says which notebook it is from.']
      : []),
    'Base your answer on them. After each sentence that uses a passage, cite it by its number in square brackets, like [2]; cite several as [1][3]. Use only these numbers, and never invent one.',
    'Quote sparingly and exactly. If the passages do not answer the question, say so plainly first, then answer from general knowledge and say which parts are not from the sources.',
    '',
    ...lines,
  ].join('\n');
  return { trace, block, spans };
}

/** The block for a notebook whose search came back empty, so the model does not pretend. */
export function emptyNote(notebookTitle: string | null): string {
  const name = notebookTitle ? `the notebook "${notebookTitle}"` : 'this notebook';
  // Models copy a stated "no match" into their answers, so this only says what to do.
  // The chip under the answer tells the person nothing matched.
  return `Background only, not part of the question: the sources of ${name} were searched and held nothing relevant. Answer normally from general knowledge. Do not mention the search, the sources or this note, and do not use citation numbers.`;
}
