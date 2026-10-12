/**
 * ------------------------------------------------------------------
 *  Title    |  PDF text matching
 *  Ref      |  sources/PdfViewer.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Find a cited passage, or a search, in a PDF page's text
 *           |  runs, so the viewer can highlight the very words on
 *           |  the rendered page.
 *  How      |  pdf.js gives a page as runs of text (one per span in
 *           |  its text layer). Matching happens on a folded stream:
 *           |  letters and digits only, lower case, accents removed.
 *           |  That makes it blind to spacing, line breaks, hyphens
 *           |  at line ends, punctuation and markdown marks, which is
 *           |  how extracted text and the page differ. Each folded
 *           |  character remembers its run and offset, so a match maps
 *           |  back to [start, end) ranges inside the runs.
 *  Note     |  Pure functions, no pdf.js import: tested in
 *           |  test/pdfMatch.test.ts.
 * ------------------------------------------------------------------
 */

/** A slice of one text run: run index, [start, end) in that run's string. */
export interface RunRange {
  item: number;
  start: number;
  end: number;
}

/** One match: the ranges it covers, in reading order. */
export type Match = RunRange[];

interface Folded {
  text: string;
  /** For each folded character: its run and offset in the run. */
  at: { item: number; offset: number }[];
}

const KEEP = /[\p{L}\p{N}]/u;

/** One character folded: accents off, lower case, letters and digits only (may be 0 to 3 characters). */
function foldChar(ch: string): string {
  let out = '';
  for (const c of ch.normalize('NFKD').toLowerCase()) if (KEEP.test(c) && !/\p{M}/u.test(c)) out += c;
  return out;
}

/** A plain string folded the same way runs are. */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) out += foldChar(ch);
  return out;
}

function foldRuns(items: readonly string[]): Folded {
  let text = '';
  const at: Folded['at'] = [];
  items.forEach((s, item) => {
    let offset = 0;
    for (const ch of s) {
      const f = foldChar(ch);
      for (const c of f) {
        text += c;
        at.push({ item, offset });
      }
      offset += ch.length;
    }
  });
  return { text, at };
}

/** Folded positions [from, to) → ranges inside runs, merged per run. */
function toRanges(f: Folded, from: number, to: number, items: readonly string[]): Match {
  const out: Match = [];
  for (let k = from; k < to; k++) {
    const p = f.at[k];
    if (!p) continue;
    const ch = items[p.item]?.codePointAt(p.offset) ?? 0;
    const end = p.offset + (ch > 0xffff ? 2 : 1);
    const last = out[out.length - 1];
    // Same run: one range, spanning the spaces and marks the fold skipped.
    if (last && last.item === p.item) last.end = Math.max(last.end, end);
    else out.push({ item: p.item, start: p.offset, end });
  }
  return out;
}

/** Every match of `query` in the runs (non-overlapping, in order). Fewer than 2 folded characters finds nothing. */
export function findAll(items: readonly string[], query: string, limit = 2_000): Match[] {
  const q = fold(query);
  if (q.length < 2) return [];
  const f = foldRuns(items);
  const out: Match[] = [];
  for (let i = f.text.indexOf(q); i !== -1 && out.length < limit; i = f.text.indexOf(q, i + q.length))
    out.push(toRanges(f, i, i + q.length, items));
  return out;
}

/** How many times `query` occurs in a page's runs. */
export function countMatches(items: readonly string[], query: string): number {
  const q = fold(query);
  if (q.length < 2) return 0;
  const t = foldRuns(items).text;
  let n = 0;
  for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + q.length)) n++;
  return n;
}

function words(s: string): string[] {
  return s.split(/\s+/).filter((w) => fold(w).length > 0);
}

export interface PassageHit {
  /** The text that was found: the whole passage, or the part of it that matched. */
  needle: string;
  kind: 'full' | 'partial';
}

/**
 * Where a cited passage is on one page: the whole of it, else the longest
 * run of its first (then last) twelve words that the page contains, down to
 * four words. Null when not even that matches.
 */
export function locatePassage(items: readonly string[], passage: string): PassageHit | null {
  const page = foldRuns(items).text;
  const whole = fold(passage);
  if (whole.length >= 2 && page.includes(whole)) return { needle: passage, kind: 'full' };
  const w = words(passage);
  const heads = [w.slice(0, 12), w.slice(-12)];
  for (const part of heads)
    for (let n = part.length; n >= 4; n--) {
      for (let s = 0; s + n <= part.length; s++) {
        const needle = part.slice(s, s + n).join(' ');
        const f = fold(needle);
        if (f.length >= 8 && page.includes(f)) return { needle, kind: 'partial' };
      }
    }
  return null;
}

/**
 * The page to look on first, then its neighbours: the cited page, then one
 * after and one before (extracted page numbers can be off by one).
 */
export function pagesToTry(page: number, count: number): number[] {
  return [page, page + 1, page - 1].filter((p) => p >= 1 && p <= count);
}

/** Next zoom step up or down from `scale`. */
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
export function zoomStep(scale: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_STEPS.find((z) => z > scale + 0.01) ?? (ZOOM_STEPS.at(-1) as number);
  return [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.01) ?? (ZOOM_STEPS[0] as number);
}

/** Is this source a PDF (by type, else by its file name)? */
export function isPdf(s: {
  kind: string;
  mime?: string | null;
  uri?: string | null;
  title?: string;
}): boolean {
  if (s.kind !== 'file') return false;
  if (s.mime) return s.mime.toLowerCase() === 'application/pdf';
  return /\.pdf$/i.test(s.uri ?? '') || /\.pdf$/i.test(s.title ?? '');
}

/** Is this source markdown (so its text view renders by default)? */
export function isMarkdown(s: {
  kind: string;
  mime?: string | null;
  uri?: string | null;
  title?: string;
}): boolean {
  if (s.kind === 'text') return true;
  if (s.mime && /markdown/i.test(s.mime)) return true;
  return /\.(md|markdown|mdx)$/i.test(s.uri ?? '') || /\.(md|markdown|mdx)$/i.test(s.title ?? '');
}
