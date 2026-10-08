/**
 * ------------------------------------------------------------------
 *  Title    |  The offline test model's structured answers
 *  Ref      |  gateway/fake-structured.ts · prompts/factcheck/*
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let fact-checking be tried with no provider key: the
 *           |  offline models answer the claim-extraction and
 *           |  claim-verification prompts with real, deterministic JSON.
 *  How      |  extract   every sentence of four words or more is a
 *           |            claim, at its exact offsets (citation markers
 *           |            and list bullets left outside the span); hedged
 *           |            or forward-looking sentences are not checkable.
 *           |  verify    a passage sharing at least 60% of the claim's
 *           |            content words bears on it. It supports the
 *           |            claim, unless their numbers or their negation
 *           |            disagree, in which case it contradicts it.
 *  Note     |  Word overlap, not understanding: good enough to show the
 *           |  three verdicts end to end, and says so in its rationale.
 * ------------------------------------------------------------------
 */

const STOP = new Set(
  `a an and are as at be been being but by can could did do does for from had has have he her his how i if in into is it its may might more most must no not of on or our she should so some such than that the their them then there these they this those to too very was we were what when where which while who whom why will with would you your also about after before between both each few other over same through under until up down out off again further once only own just`.split(
    /\s+/,
  ),
);

export function contentTerms(text: string): string[] {
  const out: string[] = [];
  for (const w of text.match(/[A-Za-z][A-Za-z'-]*|\d+(?:[.,]\d+)*/g) ?? []) {
    const t = w.toLowerCase().replace(/^['-]+|['-]+$/g, '');
    if (!t || STOP.has(t)) continue;
    if (!/^\d/.test(t) && t.length < 3) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const stem = (t: string) => {
  let s = t;
  for (const suf of ['ing', 'ed', 'es', 's'])
    if (s.length > suf.length + 3 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  return s.length > 4 && s.endsWith('e') ? s.slice(0, -1) : s;
};

function overlap(claim: string[], text: string): number {
  if (!claim.length) return 0;
  const have = new Set(contentTerms(text).map(stem));
  return claim.filter((t) => have.has(stem(t))).length / claim.length;
}

const numbers = (s: string) => new Set(s.match(/\d+(?:[.,]\d+)*/g) ?? []);
const NEGATION = /\b(not|never|no|none|cannot|can't|isn't|aren't|doesn't|don't|won't|without)\b/i;
const HEDGE =
  /\b(I think|I believe|in my opinion|should|might|may|probably|perhaps|could|will|would|recommend|suggest|consider)\b/i;

/* ---- Extract ------------------------------------------------------------- */

interface FakeClaim {
  text: string;
  char_start: number;
  char_end: number;
  importance: number;
  checkable: boolean;
}

export function fakeClaims(answer: string): FakeClaim[] {
  const out: FakeClaim[] = [];
  let offset = 0;
  let fenced = false;
  for (const line of answer.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !trimmed || /^(#|_|>|\||From your sources)/.test(trimmed)) continue;
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line)?.[0].length ?? 0;
    const re = /[^.!?]+[.!?]*/g;
    for (let m = re.exec(line.slice(bullet)); m; m = re.exec(line.slice(bullet))) {
      let start = lineStart + bullet + m.index;
      let end = start + m[0].length;
      // Citation markers stay outside the underline.
      let span = answer.slice(start, end);
      const cite = /\s*(\[\d+\])+\s*$/.exec(span);
      if (cite) end -= cite[0].length;
      const lead = /^\s*(?:\[\d+\]\s*)*/.exec(answer.slice(start, end))?.[0].length ?? 0;
      start += lead;
      span = answer.slice(start, end).trim();
      end = start + span.length;
      const words = span.split(/\s+/).filter(Boolean).length;
      if (words < 4) continue;
      const text = span.replace(/\*\*|__|`/g, '');
      out.push({
        text,
        char_start: start,
        char_end: end,
        importance: out.length === 0 || /\d/.test(text) ? 1 : 0.5,
        checkable: !HEDGE.test(text),
      });
      if (out.length >= 25) return out;
    }
  }
  return out;
}

/* ---- Verify -------------------------------------------------------------- */

function bestSentence(text: string, claim: string[]): string {
  let best = '';
  let score = -1;
  for (const s of text.match(/[^.!?\n]+[.!?]*/g) ?? []) {
    const t = s.trim();
    if (t.length < 3 || t.startsWith('#')) continue;
    const o = overlap(claim, t);
    if (o > score) {
      score = o;
      best = t;
    }
  }
  return best || text.trim().slice(0, 200);
}

export function fakeVerdict(claim: string, evidence: { ref: string; text: string }[]) {
  const terms = contentTerms(claim);
  const nums = numbers(claim);
  const negated = NEGATION.test(claim);
  const judged: { ref: string; quote: string; stance: 'supports' | 'contradicts' }[] = [];
  for (const e of evidence) {
    const quote = bestSentence(e.text, terms);
    const words = terms.filter((t) => !/^\d/.test(t));
    if (overlap(words.length ? words : terms, quote) < 0.6) continue;
    const theirs = numbers(quote);
    const numberClash = nums.size > 0 && theirs.size > 0 && ![...nums].some((n) => theirs.has(n));
    const negationClash = negated !== NEGATION.test(quote);
    judged.push({ ref: e.ref, quote, stance: numberClash || negationClash ? 'contradicts' : 'supports' });
  }
  const against = judged.filter((j) => j.stance === 'contradicts');
  const stance = against.length ? 'contradicted' : judged.length ? 'supported' : 'insufficient';
  const rationale =
    stance === 'contradicted'
      ? `${against[0]?.ref} says otherwise: its numbers or its negation differ from the claim. (Offline test model: word overlap, not understanding.)`
      : stance === 'supported'
        ? `${judged[0]?.ref} states this in nearly the same words. (Offline test model: word overlap, not understanding.)`
        : 'No passage shares enough of the claim to settle it. (Offline test model: word overlap, not understanding.)';
  return { stance, evidence: judged, rationale };
}

/* ---- Dispatch -------------------------------------------------------------- */

/** A structured reply for a fact-check prompt, or undefined when the prompt is something else. */
export function factcheckReply(prompt: string): string | undefined {
  if (/Return JSON matching ClaimList/.test(prompt)) {
    const answer = /\nAnswer:\n([\s\S]*?)\n+Return JSON matching ClaimList/.exec(prompt)?.[1] ?? '';
    return JSON.stringify({ claims: fakeClaims(answer) });
  }
  if (/Return JSON matching ClaimVerdict/.test(prompt)) {
    const claim = /Claim:\n([\s\S]*?)\n+Evidence:\n/.exec(prompt)?.[1]?.trim() ?? '';
    const evidence = [...prompt.matchAll(/\[(E\d+)\][^\n]*\n"""\n([\s\S]*?)\n"""/g)].map((m) => ({
      ref: m[1] ?? '',
      text: m[2] ?? '',
    }));
    return JSON.stringify(fakeVerdict(claim, evidence));
  }
  return undefined;
}
