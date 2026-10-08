/**
 * ------------------------------------------------------------------
 *  Title    |  Refusal detection
 *  Ref      |  DESIGN.md §7.1 (class `refusal`)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  When a model declines a reasonable request, the next
 *           |  model in the chain gets a chance before the user sees
 *           |  the refusal. Detected from the provider's finish reason
 *           |  or from how the answer opens.
 *  Note     |  Deliberately narrow: a false positive throws away a
 *           |  good answer, so only unambiguous openings count.
 * ------------------------------------------------------------------
 */

const OPENINGS = [
  /^(?:i'?m|i am) (?:sorry|afraid),? (?:but )?i (?:can(?:'|no)?t|won'?t|am unable to|'m unable to) (?:help|assist|provide|do|comply)/i,
  /^i (?:can(?:'|no)?t|won'?t|am unable to) (?:help|assist|provide|comply) with (?:that|this)/i,
  /^(?:sorry|unfortunately),? (?:but )?i (?:can(?:'|no)?t|am not able to) (?:help|assist) with (?:that|this)/i,
  /^as an ai(?: language model)?,? i (?:can(?:'|no)?t|am not able to|won'?t)/i,
];

export function looksLikeRefusal(opening: string): boolean {
  const text = opening.trim().replace(/[‘’]/g, "'");
  return OPENINGS.some((re) => re.test(text));
}

/** Every refusal opening starts with one of these words. */
const REFUSAL_START = /^(?:i|i'm|sorry,?|unfortunately,?|as)$/i;

/**
 * True once the opening is long enough to show it is not a refusal: its
 * first word is complete and is not one a refusal starts with. Lets the
 * gateway stream at once instead of holding the whole refusal probe.
 */
export function cannotBeRefusal(opening: string): boolean {
  const text = opening.trimStart().replace(/[‘’]/g, "'");
  const first = /^(\S+)\s/.exec(text)?.[1];
  if (!first) return false;
  return !REFUSAL_START.test(first);
}

export function isRefusalFinish(finishReason: string): boolean {
  return /content[-_]filter|refus|safety/i.test(finishReason);
}
