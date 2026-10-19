/**
 * ------------------------------------------------------------------
 *  Title    |  Showing a find match on the page
 *  Ref      |  roadmap TS2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Open the thinking or tool step that holds a match,
 *           |  mark the words, and bring the match into view.
 *  How      |  Works on the message's row once the thread has
 *           |  scrolled to it. A fold that has not been opened draws
 *           |  nothing inside, so opening it takes a frame or two:
 *           |  revealHit says whether the words are on the page yet.
 *           |  Marks use the CSS Custom Highlight API (no DOM is
 *           |  changed, so nothing the thread renders is disturbed);
 *           |  a browser without it still gets the scroll and the
 *           |  open fold.
 * ------------------------------------------------------------------
 */

import type { FindHit } from '../lib/threadFind';

const rowFor = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-mid="${typeof CSS !== 'undefined' ? CSS.escape(id) : id}"]`);

/** Text nodes under `root` that hold `needle`, as ranges, in reading order. */
export function rangesIn(root: Node, needle: string): Range[] {
  const low = needle.toLowerCase();
  const out: Range[] = [];
  if (!low) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase();
    for (let i = text.indexOf(low); i !== -1; i = text.indexOf(low, i + low.length)) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + low.length);
      out.push(r);
    }
  }
  return out;
}

function foldFor(row: HTMLElement, hit: FindHit): HTMLDetailsElement[] {
  if (hit.where === 'thinking') return [...row.querySelectorAll<HTMLDetailsElement>('details.thinking')];
  if (hit.where === 'tool' && hit.callId) {
    const step = row.querySelector<HTMLDetailsElement>(
      `details.tool-step[data-call-id="${CSS.escape(hit.callId)}"]`,
    );
    return step ? [step] : [];
  }
  return [];
}

/**
 * Open what holds the match. True once the match's words are on the page (or there is nothing
 * to wait for), false while a fold is still drawing its contents.
 */
export function revealHit(hit: FindHit, needle: string): boolean {
  const row = rowFor(hit.messageId);
  if (!row) return false;
  for (const d of foldFor(row, hit)) {
    if (!d.open) d.open = true;
    // Inside a step, the input and output are folds of their own.
    for (const inner of d.querySelectorAll<HTMLDetailsElement>('details')) if (!inner.open) inner.open = true;
  }
  if (hit.where === 'text') return true;
  const folds = foldFor(row, hit);
  return folds.length > 0 && folds.some((d) => rangesIn(d, needle).length > 0);
}

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
const marks = (): Highlights | null => {
  const h = (CSS as unknown as { highlights?: Highlights }).highlights;
  return h && typeof Highlight !== 'undefined' ? h : null;
};

export function clearFindMarks(): void {
  const h = marks();
  h?.delete('find-match');
  h?.delete('find-active');
}

/** Mark every match in the message, the one you are on more strongly, and scroll it into view. */
export function applyFindMarks(hit: FindHit, needle: string): void {
  const row = rowFor(hit.messageId);
  clearFindMarks();
  if (!row) return;
  const body = row.querySelector('.msg__body') ?? row;
  const folds = foldFor(row, hit);
  // The answer's own words are the ones outside every fold; a fold's words are inside it.
  const all =
    hit.where === 'text'
      ? rangesIn(body, needle).filter((r) => !r.startContainer.parentElement?.closest('details'))
      : folds.flatMap((d) => rangesIn(d, needle));
  const k = Math.min(hit.nth, Math.max(0, all.length - 1));
  const current = all[k];
  const h = marks();
  if (h && current) {
    h.set('find-match', new Highlight(...all.filter((_, i) => i !== k)));
    h.set('find-active', new Highlight(current));
  }
  const target = current?.startContainer.parentElement ?? row;
  // Instant: moving to a match is not an animation, so reduced motion needs no special case.
  target.scrollIntoView({ block: 'center', behavior: 'auto' });
}

/** Open the step a timeline click names, bring it into view and let it show it was found. */
export function revealStep(hit: FindHit, tries = 0): void {
  const row = rowFor(hit.messageId);
  const folds = row ? foldFor(row, hit) : [];
  for (const d of folds) if (!d.open) d.open = true;
  const target = folds[0] ?? row;
  if (!target) {
    if (tries < 20) requestAnimationFrame(() => revealStep(hit, tries + 1));
    return;
  }
  target.scrollIntoView({ block: 'center', behavior: 'auto' });
  target.setAttribute('data-found', '');
  setTimeout(() => target.removeAttribute('data-found'), 1_600);
}
