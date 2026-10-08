/**
 * ------------------------------------------------------------------
 *  Title    |  Citations
 *  Ref      |  ROADMAP.md Phase 3 ("invalid markers are stripped and
 *           |  counted") · DESIGN.md §10
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Hold an answer to the passages it was given: every [n]
 *           |  must name one of them. A number that names nothing was
 *           |  made up, and is removed before anyone reads it.
 *  How      |  Markers are found in text parts, outside code. Valid
 *           |  ones mark their passage cited and become citation_ref
 *           |  parts carrying the exact span, so the Cockpit can open
 *           |  it. An answer is "grounded" when every paragraph that
 *           |  states something carries at least one valid citation.
 * ------------------------------------------------------------------
 */

import type { Part, RetrievalTrace, SearchHit } from '@nvx/contracts';

/** [3], [1][4], [2, 5], [2-4] */
const MARKER = /\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\](?!\()/g;

function numbersIn(group: string): number[] {
  const out: number[] = [];
  for (const piece of group.split(',')) {
    const range = piece.split(/[–-]/).map((n) => Number(n.trim()));
    const [a, b] = range;
    if (a === undefined || Number.isNaN(a)) continue;
    if (b !== undefined && !Number.isNaN(b) && b >= a && b - a <= 20)
      for (let n = a; n <= b; n++) out.push(n);
    else out.push(a);
  }
  return out;
}

/** Split text into code and prose, so markers inside code are left alone. */
function segments(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) });
    out.push({ code: true, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) });
  return out;
}

export interface CitationResult {
  parts: Part[];
  trace: RetrievalTrace;
  /** Distinct valid markers, in the order they first appear. */
  cited: number[];
}

/**
 * Check every marker against the passages; strip the invented ones; add a
 * citation_ref part for each passage actually cited.
 */
export function applyCitations(
  parts: Part[],
  trace: RetrievalTrace,
  spans: Map<number, Pick<SearchHit, 'char_start' | 'char_end' | 'text'>>,
): CitationResult {
  const valid = new Set(trace.hits.map((h) => h.marker));
  const cited: number[] = [];
  let invalid = 0;

  const cleaned = parts
    .filter((p) => p.type !== 'citation_ref')
    .map((p): Part => {
      if (p.type !== 'text') return p;
      const text = segments(p.text)
        .map((s) =>
          s.code
            ? s.text
            : s.text.replace(MARKER, (_all, group: string) => {
                const nums = numbersIn(group);
                const keep = nums.filter((n) => valid.has(n));
                invalid += nums.length - keep.length;
                for (const n of keep) if (!cited.includes(n)) cited.push(n);
                return keep.map((n) => `[${n}]`).join('');
              }),
        )
        .join('')
        // Removing a marker can leave "word ." or doubled spaces behind.
        .replace(/[ \t]+([.,;:!?])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ');
      return { ...p, text };
    });

  const refs: Part[] = cited.flatMap((marker) => {
    const hit = trace.hits.find((h) => h.marker === marker);
    const span = spans.get(marker);
    if (!hit || !span) return [];
    const quote = span.text.length > 300 ? `${span.text.slice(0, 300)}…` : span.text;
    return [
      {
        type: 'citation_ref' as const,
        marker,
        chunk_id: hit.chunk_id,
        source_id: hit.source_id,
        char_start: span.char_start,
        char_end: span.char_end,
        quote,
      },
    ];
  });

  const prose = cleaned
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('')
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter((para) => para.length >= 40 && !para.startsWith('```') && !/^#{1,6}\s/.test(para));
  const grounded = cited.length > 0 && prose.length > 0 && prose.every((para) => /\[\d+\]/.test(para));

  return {
    parts: [...cleaned, ...refs],
    cited,
    trace: {
      ...trace,
      hits: trace.hits.map((h) => ({ ...h, cited: cited.includes(h.marker) })),
      invalid_markers: trace.invalid_markers + invalid,
      grounded,
    },
  };
}
