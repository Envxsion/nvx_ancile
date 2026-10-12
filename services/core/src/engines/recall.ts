/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: recalling older turns by relevance
 *  Ref      |  docs/engines.md (Older turns)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  When a thread's older turns do not all fit a model's
 *           |  budget, bring back the ones that bear on the question
 *           |  being asked, instead of whichever happen to be newest.
 *  How      |  The thread's history is indexed like a small source:
 *           |  each turn (its digested text) is a document, scored
 *           |  against the question with BM25 (k1 1.2, b 0.75) over
 *           |  lower-cased word tokens, stop words left out. Done in
 *           |  process, per turn, over the path being answered.
 *  Note     |  Chosen over Knowledge's hybrid search: a thread's turns
 *           |  are not sources (indexing every message would embed the
 *           |  whole history and add a network call to every turn),
 *           |  and a path rarely holds more than a few hundred turns.
 *           |  TODO(phase-5): embeddings from fastembed when a thread
 *           |  is long enough for words alone to miss.
 * ------------------------------------------------------------------
 */

const STOP = new Set(
  (
    'the and for are but not you all any can had her was one our out has him his how its may new now ' +
    'see two who did get let say she too use that this with have from they will would there their what ' +
    'about which when make like time just know take into year your some could them than then look only ' +
    'come over also back after work first well even want because these give most should does done been ' +
    'were here please thanks thank'
  ).split(' '),
);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter((w) => !STOP.has(w));
}

export interface Scored {
  index: number;
  score: number;
}

/** BM25 scores of each document against the query, highest first; zero scores left out. */
export function rank(query: string, docs: string[], opts: { k1?: number; b?: number } = {}): Scored[] {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const q = [...new Set(tokens(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map(tokens);
  const avg = toks.reduce((n, t) => n + t.length, 0) / toks.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length;
  const out: Scored[] = [];
  toks.forEach((t, index) => {
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w) ?? 0;
      if (!f) continue;
      const d = df.get(w) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * t.length) / avg));
    }
    if (score > 0) out.push({ index, score });
  });
  return out.sort((x, y) => y.score - x.score || x.index - y.index);
}
