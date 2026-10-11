/**
 * ------------------------------------------------------------------
 *  Title    |  Reading answers aloud
 *  Ref      |  Settings → Accessibility · "Read answers aloud as they arrive"
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Decide what a screen reader hears while an answer is
 *           |  written: each finished sentence, or each finished
 *           |  paragraph, or nothing until it is done.
 *  How      |  Pure: given the text so far and how much was already
 *           |  said, return the next whole piece and where it ends.
 *           |  ThreadView puts the piece in its polite live region.
 *  Note     |  Markdown marks are dropped so they are not read out.
 * ------------------------------------------------------------------
 */

export type AnnounceMode = 'sentences' | 'paragraphs' | 'off';

/** The end of the last whole sentence or paragraph in `text`, or -1. */
function lastBreak(text: string, mode: 'sentences' | 'paragraphs'): number {
  const re = mode === 'paragraphs' ? /\n\s*\n/g : /[.!?…](?=\s)|\n\s*\n/g;
  let end = -1;
  for (const m of text.matchAll(re)) end = (m.index ?? 0) + m[0].length;
  return end;
}

function speakable(s: string): string {
  return s
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/[*_`#>|]+/g, '')
    .replace(/\[(\d+)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The next piece to read aloud. `from` is how much of `text` was already
 * read; `done` reads whatever is left. Returns an empty `say` when there is
 * nothing whole to read yet.
 */
export function nextAnnouncement(
  text: string,
  from: number,
  mode: AnnounceMode,
  done: boolean,
): { say: string; upTo: number } {
  if (mode === 'off' || from >= text.length) return { say: '', upTo: Math.max(from, 0) };
  const rest = text.slice(from);
  const cut = done ? rest.length : lastBreak(rest, mode);
  if (cut <= 0) return { say: '', upTo: from };
  return { say: speakable(rest.slice(0, cut)), upTo: from + cut };
}
