/**
 * ------------------------------------------------------------------
 *  Title    |  Explicit memory requests
 *  Ref      |  ROADMAP M2 · DESIGN.md §6.3 · guard rail GR3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Spot the person asking, in their own words, for something
 *           |  to be kept: "remember that I use metric", "never add a
 *           |  summary", "from now on answer in French". Those are saved
 *           |  as a preference or a restriction with high confidence.
 *  How      |  Pure text rules, no model. Only the person's own words are
 *           |  read (ownWords drops quotes, pasted blocks and code). A
 *           |  request has to open a sentence, so a sentence that only
 *           |  mentions one ("he said never do that") never counts.
 *           |  Questions, "never mind", "don't remember that", "if I say
 *           |  remember" and sarcasm are turned away.
 *  Note     |  GR3: this decides only that the person asked. Saving is
 *           |  the memory module's job (applyPolicy honours `explicit`
 *           |  only for provenance user_message), with a visible note in
 *           |  the thread and Undo. Text from a source, a tool or another
 *           |  model never reaches this file: capture hands it the user's
 *           |  message and nothing else.
 * ------------------------------------------------------------------
 */

import { ownWords } from './capture';

export interface ExplicitMemory {
  /** A rule to follow ("never...") or something to keep in mind. */
  kind: 'preference' | 'restriction';
  /** The entry, one sentence, in the person's words. */
  statement: string;
  /** The person said it is about this notebook or project. */
  scope: 'user' | 'notebook';
}

/** Words that open a sentence without changing what follows. */
const LEAD = String.raw`(?:(?:ok|okay|also|and|so|please|hey|btw|just|oh and|one more thing|note to self)[,:]?\s+)*`;

const REMEMBER = new RegExp(
  String.raw`^${LEAD}(?:always\s+)?remember(?:\s+(?:to|that|this))?[,:]?\s+(?<rest>.+)$`,
  'i',
);
const NEVER = new RegExp(
  String.raw`^${LEAD}(?:you\s+(?:must|should|shall)\s+)?never\s+(?!mind\b)(?<rest>.+)$`,
  'i',
);
const DONT_EVER = new RegExp(
  String.raw`^${LEAD}(?:please\s+)?(?:do\s+not|don'?t)\s+ever\s+(?<rest>.+)$`,
  'i',
);
const FROM_NOW_ON = new RegExp(
  String.raw`^${LEAD}(?:from now on|going forward|in future|in the future)[,:]?\s+(?<rest>.+)$`,
  'i',
);

/** Said as a joke or a jab, not as an instruction. */
const SARCASM =
  /(?:\/s\b|\byeah,?\s+right\b|\boh,?\s+sure\b|\bas if\b|\bsure,?\s+whatever\b|\bhow could i forget\b|\blol\b|\blmao\b|\bsarcas|🙄|😂)/i;

const RESTRICTING = /^(?:never|don'?t|do not|must not|should not|shouldn'?t|avoid|stop|no longer)\b/i;

const NOTEBOOK_SCOPE = /\b(?:in|for|on)\s+(?:this|the)\s+(?:notebook|project)\b/i;

const MAX_STATEMENT = 300;

const sentences = (text: string): string[] =>
  text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=\S)/))
    .map((s) => s.trim())
    .filter(Boolean);

const cap = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);
const tidy = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:]+$/, '')
    .trim();

/** What the person asked to keep, if they asked. Null for anything else. */
export function detectExplicit(userText: string): ExplicitMemory | null {
  const own = ownWords(userText);
  if (!own || own.length > 2_000 || SARCASM.test(own)) return null;

  for (const raw of sentences(own)) {
    // A question is not an instruction; neither is a sentence that opens with a quote mark.
    if (/\?\s*$/.test(raw) || /^["'“‘`]/.test(raw)) continue;
    const sentence = raw.replace(/[.!]+$/, '');

    let statement: string | null = null;
    const rem = REMEMBER.exec(sentence);
    if (rem?.groups) {
      statement = tidy(rem.groups.rest ?? '');
    } else {
      const never = NEVER.exec(sentence);
      const dont = never ? null : DONT_EVER.exec(sentence);
      const now = never || dont ? null : FROM_NOW_ON.exec(sentence);
      if (never?.groups) statement = `Never ${tidy(never.groups.rest ?? '')}`;
      else if (dont?.groups) statement = `Never ${tidy(dont.groups.rest ?? '')}`;
      else if (now?.groups) statement = tidy(now.groups.rest ?? '');
    }
    if (!statement) continue;

    // "Never remember that...", "never forget" is fine but "remember that" alone refers to nothing.
    if (/^never\s+remember\b/i.test(statement)) continue;
    if (statement.split(/\s+/).length < 2 || statement.length > MAX_STATEMENT) continue;
    // "remember it", "remember this one": points at something said elsewhere.
    if (/^(?:it|this|that|these|those|them|him|her)(?:\s+one)?$/i.test(statement)) continue;

    const restriction = RESTRICTING.test(statement);
    return {
      kind: restriction ? 'restriction' : 'preference',
      statement: `${cap(statement)}.`,
      scope: NOTEBOOK_SCOPE.test(statement) ? 'notebook' : 'user',
    };
  }
  return null;
}
