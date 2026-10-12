/**
 * ------------------------------------------------------------------
 *  Title    |  Retrieval across context links
 *  Ref      |  docs/notebooks.md (Context links) · retrieval.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A turn reads its own notebook's sources and, through
 *           |  links, other notebooks' sources: one numbered set of
 *           |  passages, where each linked passage says which notebook
 *           |  it came from, so its citation names that notebook.
 *  How      |  One search per notebook (the thread's own, then each
 *           |  linked one, limited to what that notebook's scope lets
 *           |  retrieval read), run side by side. The hits are ranked
 *           |  together by their reranked score, then capped per
 *           |  source and to the turn's k, exactly as one search is.
 *  Note     |  A linked search that fails is left out and logged; the
 *           |  turn's own search failing still fails retrieval as it
 *           |  always did.
 * ------------------------------------------------------------------
 */

import type { ExplainLink, RetrievalTrace, SearchHit, SearchResponse } from '@nvx/contracts';
import type { LinkedNotebook, TurnLinks } from '../links/service';
import { logFor } from '../obs/logger';
import { capPerSource, type RetrievalLimits, type Retriever } from './retrieval';

const log = logFor('conductor');

export interface Via {
  link_id: string;
  notebook_id: string;
  notebook_title: string;
}

const rank = (h: SearchHit) => h.rerank_score ?? h.score;

/** Search the thread's notebook and every linked notebook, as one ranked list. */
export async function searchWithLinks(a: {
  retriever: Retriever;
  workspaceId: string;
  query: string;
  limits: RetrievalLimits;
  own: { notebookId: string; sourceIds?: string[] | undefined } | null;
  linked: LinkedNotebook[];
}): Promise<{ response: SearchResponse; via: Map<string, Via> }> {
  const k = a.limits.k;
  const ownSearch = a.own
    ? a.retriever.search({
        workspaceId: a.workspaceId,
        notebookId: a.own.notebookId,
        query: a.query,
        k,
        ...(a.own.sourceIds?.length && { sourceIds: a.own.sourceIds }),
      })
    : null;
  const linkedSearches = a.linked.map((l) =>
    a.retriever
      .search({
        workspaceId: a.workspaceId,
        notebookId: l.notebookId,
        query: a.query,
        k,
        ...(l.sourceIds?.length && { sourceIds: l.sourceIds }),
      })
      .catch((err: unknown) => {
        log.warn({ err, link: l.linkId }, 'a linked notebook could not be searched; left out');
        return null;
      }),
  );
  const [own, ...others] = await Promise.all([ownSearch, ...linkedSearches]);
  const via = new Map<string, Via>();
  const ownIds = new Set((own?.hits ?? []).map((h) => h.chunk_id));
  const all: SearchHit[] = [...(own?.hits ?? [])];
  others.forEach((res, i) => {
    const l = a.linked[i];
    if (!res || !l) return;
    for (const h of res.hits) {
      // A source in both notebooks is the thread's own: it is cited as such.
      if (ownIds.has(h.chunk_id) || via.has(h.chunk_id)) continue;
      via.set(h.chunk_id, { link_id: l.linkId, notebook_id: l.notebookId, notebook_title: l.title });
      all.push(h);
    }
  });
  // Stable: on a tie the thread's own passage stays first.
  const ranked = all.map((h, i) => ({ h, i })).sort((x, y) => rank(y.h) - rank(x.h) || x.i - y.i);
  const first = own ?? others.find((r): r is SearchResponse => !!r);
  const response: SearchResponse = {
    hits: capPerSource(
      ranked.map((r) => r.h),
      k,
      a.limits.perSource,
    ),
    mode: first?.mode ?? 'hybrid',
    embedder: first?.embedder ?? null,
    ms: Math.max(own?.ms ?? 0, ...others.map((r) => r?.ms ?? 0)),
  };
  return { response, via };
}

/** What the Why view shows for each link (and context pack) the turn considered. */
export function explainLinks(turn: TurnLinks | null, trace: RetrievalTrace | null): ExplainLink[] {
  if (!turn) return [];
  const out: ExplainLink[] = [...turn.skipped];
  const byId = new Map<string, ExplainLink>();
  const entry = (id: string, make: () => ExplainLink): ExplainLink => {
    let e = byId.get(id);
    if (!e) {
      e = make();
      byId.set(id, e);
      out.push(e);
    }
    return e;
  };
  for (const n of turn.notebooks) {
    const e = entry(n.linkId, () => ({
      link_id: n.linkId,
      kind: n.source === 'pack' ? 'pack' : 'sources',
      via: n.via,
      to_kind: n.source === 'pack' ? 'pack' : 'notebook',
      to_id: n.source === 'pack' ? n.linkId : n.notebookId,
      title: n.title,
      state: 'empty',
      passages: 0,
      cited: 0,
      code: null,
      reason: null,
    }));
    const hits = (trace?.hits ?? []).filter(
      (h) => h.via?.link_id === n.linkId && h.via.notebook_id === n.notebookId,
    );
    e.passages += hits.length;
    e.cited += hits.filter((h) => h.cited).length;
  }
  for (const s of turn.summaries) {
    const e = entry(s.linkId, () => ({
      link_id: s.linkId,
      kind: s.source === 'pack' ? 'pack' : 'summary',
      via: s.via,
      to_kind: s.source === 'pack' ? 'pack' : 'thread',
      to_id: s.threadId ?? s.linkId,
      title: s.title,
      state: 'used',
      passages: 0,
      cited: 0,
      code: null,
      reason: null,
    }));
    e.state = 'used';
    if (s.source === 'pack') e.title = s.title;
  }
  for (const e of byId.values()) {
    if (e.passages > 0) e.state = 'used';
    if (e.state === 'empty') e.reason = 'Nothing in it matched this question';
  }
  return out;
}
