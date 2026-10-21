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
 *           |            disagree (the claim states a number that the
 *           |            passage, stating numbers of its own, does not),
 *           |            in which case it contradicts it.
 *           |            tests/eval/factcheck measures both.
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
/** A number as written ("8,849" or "8,848.86") as a value and its decimal places. */
const parsed = (n: string) => {
  const plain = n.replace(/,(?=\d{3}\b)/g, '');
  const dot = plain.indexOf('.');
  return { value: Number(plain.replace(',', '.')), places: dot < 0 ? 0 : plain.length - dot - 1 };
};
/** The claim's number is the passage's rounded to the claim's own precision: 8,849 for 8,848.86. */
const roundedFrom = (claimNum: string, theirs: Set<string>): boolean => {
  const c = parsed(claimNum);
  return [...theirs].some((t) => {
    const p = parsed(t);
    return p.places > c.places && Number(p.value.toFixed(c.places)) === c.value;
  });
};
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
  for (const s of text.match(/[^\n]+?(?:[.!?]+(?=\s|$)|$)/g) ?? []) {
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
  const judged: { ref: string; quote: string; stance: 'supports' | 'contradicts'; rounded?: boolean }[] = [];
  for (const e of evidence) {
    const quote = bestSentence(e.text, terms);
    const words = terms.filter((t) => !/^\d/.test(t));
    if (overlap(words.length ? words : terms, quote) < 0.6) continue;
    const theirs = numbers(quote);
    // A number the claim states that the passage, stating numbers of its own,
    // does not: "1933" against "14 June 1932" clashes though "14" is shared.
    const off = nums.size > 0 && theirs.size > 0 ? [...nums].filter((n) => !theirs.has(n)) : [];
    // Off only by rounding: the passage is more precise, and the claim is it rounded. Partly, not wrong.
    const rounded = off.length > 0 && off.every((n) => roundedFrom(n, theirs));
    const numberClash = off.length > 0 && !rounded;
    const negationClash = negated !== NEGATION.test(quote);
    judged.push({
      ref: e.ref,
      quote,
      stance: numberClash || negationClash ? 'contradicts' : 'supports',
      ...(rounded && !negationClash && { rounded: true }),
    });
  }
  const against = judged.filter((j) => j.stance === 'contradicts');
  const roundedOnly = !against.length && judged.length > 0 && judged.every((j) => j.rounded);
  const stance = against.length
    ? 'contradicted'
    : roundedOnly
      ? 'partly'
      : judged.length
        ? 'supported'
        : 'insufficient';
  const nuance =
    stance === 'partly' ? `${judged[0]?.ref} gives a more precise figure; the claim rounds it.` : '';
  const rationale =
    stance === 'partly'
      ? `${judged[0]?.ref} agrees apart from rounding. (Offline test model: word overlap, not understanding.)`
      : stance === 'contradicted'
        ? `${against[0]?.ref} says otherwise: its numbers or its negation differ from the claim. (Offline test model: word overlap, not understanding.)`
        : stance === 'supported'
          ? `${judged[0]?.ref} states this in nearly the same words. (Offline test model: word overlap, not understanding.)`
          : 'No passage shares enough of the claim to settle it. (Offline test model: word overlap, not understanding.)';
  return {
    stance,
    evidence: judged.map(({ rounded: _r, ...e }) => e),
    rationale,
    nuance,
  };
}

/* ---- Dispatch -------------------------------------------------------------- */

/**
 * Like a real model, the offline one only knows the fields the prompt names. A prompt that says "Return
 * JSON matching ClaimVerdict" and never names stance, evidence, rationale and confidence gets a reply
 * no reader can use: that is how a live check once failed on every model while the tests passed.
 */
export const FIELDS = {
  ClaimList: ['claims', 'text', 'char_start', 'char_end', 'importance', 'checkable'],
  ClaimVerdict: [
    'stance',
    'evidence',
    'rationale',
    'confidence',
    'supported',
    'partly',
    'contradicted',
    'insufficient',
    'nuance',
  ],
  SelectionCheck: ['verdict', 'headline', 'corrected', 'evidence', 'closing'],
} as const;
const named = (prompt: string, fields: readonly string[]) => fields.every((f) => prompt.includes(f));
const UNTOLD = JSON.stringify({ result: 'done', note: 'The prompt did not say which fields to fill.' });

/** A structured reply for a fact-check prompt, or undefined when the prompt is something else. */
export function factcheckReply(prompt: string): string | undefined {
  if (/Return JSON matching ClaimList/.test(prompt)) {
    if (!named(prompt, FIELDS.ClaimList)) return UNTOLD;
    const answer = /\nAnswer:\n([\s\S]*?)\n+Return JSON matching ClaimList/.exec(prompt)?.[1] ?? '';
    return JSON.stringify({ claims: fakeClaims(answer) });
  }
  if (/Return JSON matching ClaimVerdict/.test(prompt)) {
    if (!named(prompt, FIELDS.ClaimVerdict)) return UNTOLD;
    const claim = /Claim:\n([\s\S]*?)\n+Evidence:\n/.exec(prompt)?.[1]?.trim() ?? '';
    const evidence = [...prompt.matchAll(/\[(E\d+)\][^\n]*\n"""\n([\s\S]*?)\n"""/g)].map((m) => ({
      ref: m[1] ?? '',
      text: m[2] ?? '',
    }));
    return JSON.stringify(fakeVerdict(claim, evidence));
  }
  if (/Return JSON matching SelectionCheck/.test(prompt))
    return named(prompt, FIELDS.SelectionCheck) ? selectionReply(prompt) : UNTOLD;
  return undefined;
}

/** A card for a highlighted claim, worked out by the same word-overlap rules (offline test model). */
function selectionReply(prompt: string): string {
  const claim =
    /The highlighted text:\n<untrusted[^>]*>\n([\s\S]*?)\n<\/untrusted/.exec(prompt)?.[1]?.trim() ?? '';
  const evidence = [...prompt.matchAll(/\[(E\d+)\][^\n]*\n"""\n([\s\S]*?)\n"""/g)].map((m) => ({
    ref: m[1] ?? '',
    text: m[2] ?? '',
  }));
  const v = fakeVerdict(claim, evidence);
  const lines = v.evidence.map((e) => ({ text: e.quote, ref: e.ref, stance: e.stance }));
  if (!lines.length)
    lines.push({ text: 'Nothing in the evidence settles this.', ref: '', stance: 'neutral' as never });
  const against = v.evidence.find((e) => e.stance === 'contradicts');
  const verdict =
    v.stance === 'contradicted'
      ? 'doesnt_hold'
      : v.stance === 'supported'
        ? 'holds'
        : v.stance === 'partly'
          ? 'partly'
          : 'cant_tell';
  return JSON.stringify({
    verdict,
    headline: v.rationale,
    corrected: against ? against.quote : null,
    evidence: lines,
    closing:
      verdict === 'doesnt_hold'
        ? 'The surrounding answer would need to start from the corrected claim.'
        : 'The surrounding answer stands as written.',
  });
}
