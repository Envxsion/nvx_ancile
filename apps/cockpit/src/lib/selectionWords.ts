/**
 * ------------------------------------------------------------------
 *  Title    |  The words around a checked highlight
 *  Ref      |  roadmap FC3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The labels, the cost line, the text Copy puts on the
 *           |  clipboard and the follow-up draft "Use the corrected
 *           |  claim" writes, in one place, so the card, the Evidence
 *           |  tab and the receipt all say the same thing.
 *  How      |  Plain functions over a SelectionCheck. Sentence case,
 *           |  British spelling, no em dashes. The draft is only put
 *           |  in the composer: it is never sent.
 * ------------------------------------------------------------------
 */

import type { SelectionCheck, SelectionEvidence, SelectionVerdict } from '@nvx/contracts';
import { money } from '../receipt/figures';
import type { IconName } from '../ui/Icon';
import { modelName } from './format';

export const VERDICT_WORDS: Record<SelectionVerdict, { label: string; icon: IconName }> = {
  holds: { label: 'Holds', icon: 'check' },
  partly: { label: 'Partly holds', icon: 'minus' },
  doesnt_hold: { label: "Doesn't hold", icon: 'alert' },
  cant_tell: { label: "Can't tell", icon: 'question' },
};

export const ORIGIN_WORDS: Record<SelectionEvidence['origin'], string> = {
  source: 'Source',
  web: 'Web',
  run: 'Sandbox run',
  model: 'Model knowledge',
};

/** Who checked it and what it cost, for the card's footer. */
export function costLine(c: Pick<SelectionCheck, 'checker_model_id' | 'billed' | 'cost_usd'>): string {
  const who = c.checker_model_id ? `Checked by ${modelName(c.checker_model_id)}` : 'Checked';
  const cost =
    c.billed === 'plan'
      ? 'Included in your Claude plan'
      : c.billed === 'free'
        ? 'No charge'
        : money(c.cost_usd);
  return `${who} · ${cost}`;
}

/** What Copy puts on the clipboard: the card as plain text. */
export function copyText(c: SelectionCheck): string {
  const lines = [
    `${VERDICT_WORDS[c.verdict].label}: ${c.headline}`,
    `Claim: “${c.text}”`,
    ...(c.corrected ? [`Corrected claim: ${c.corrected}`] : []),
    ...c.evidence.map((e) => `- ${e.text} (${ORIGIN_WORDS[e.origin]}: ${e.source})`),
    ...(c.closing ? [c.closing] : []),
  ];
  return lines.join('\n');
}

/** The follow-up "Use the corrected claim" drafts. It goes in the composer and waits for you. */
export function followUpDraft(corrected: string): string {
  return `Let's start from this corrected claim: ${corrected}\n\nHow does your answer change?`;
}

/** Put text in the composer of a thread (it adds to a draft, never replaces one, never sends). */
export function insertIntoComposer(threadId: string, text: string): void {
  window.dispatchEvent(new CustomEvent('ancile:composer-insert', { detail: { threadId, text } }));
}
