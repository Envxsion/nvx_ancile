/**
 * ------------------------------------------------------------------
 *  Title    |  Export a thread
 *  Ref      |  roadmap EX3 (extends SH1)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Write the branch on screen as Markdown or as a page
 *           |  that prints cleanly to PDF, with sources as footnotes,
 *           |  tool steps as folded details, and thinking and receipts
 *           |  only when asked for. The whole tree comes from Core as
 *           |  JSON.
 *  How      |  exportMarkdown builds the document; exportHtml turns
 *           |  that same Markdown into a page, so the two never
 *           |  disagree. Tool input and output is cut to a few hundred
 *           |  characters and a thread with hundreds of steps lists the
 *           |  first ones and counts the rest. A source that has been
 *           |  removed is named from the title kept with the answer.
 *  Note     |  Pro adds DOCX, a PDF with an evidence appendix and a
 *           |  branch comparison. TODO(phase-0.1.1): Pro export formats
 *           |  join at pro/ through the Pro seam. Images are named, not
 *           |  embedded: their links only work on this machine.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';
import { citationsOf, escapeHtml, markdownToHtml, withFootnotes } from './answerText';
import { modelName } from './format';
import type { MessageView, ThreadView } from './types';

export type ExportFormat = 'markdown' | 'html' | 'json';

export interface ExportOptions {
  /** Include what the model thought. Off by default: it is not part of the answer. */
  thinking: boolean;
  /** Include tool steps as folded details. */
  steps: boolean;
  /** Include a line per answer: model, tokens, cost, time. */
  receipts: boolean;
  /** Footnote the sources an answer cites. */
  sources: boolean;
}

export const DEFAULT_EXPORT: ExportOptions = { thinking: false, steps: true, receipts: false, sources: true };

/** Most tool steps listed in full across one export; the rest are counted. */
export const MAX_STEPS = 60;
const CUT = 600;

const cut = (s: string, n = CUT): string =>
  s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s;

function show(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2) ?? '';
  } catch {
    return String(v);
  }
}

/** A fence long enough that nothing inside can close it. */
function fenced(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const bar = '`'.repeat(longest + 1);
  return `${bar}${lang}\n${text}\n${bar}`;
}

function textOfParts(parts: Part[] | undefined): string {
  return (parts ?? [])
    .flatMap((p) => {
      if (p.type === 'text') return [p.text];
      if (p.type === 'image') return [`\n*(image: ${p.alt || p.caption || 'no description'})*\n`];
      if (p.type === 'file') return [`\n*(file: ${p.name})*\n`];
      return [];
    })
    .join('')
    .trim();
}

function stepsMarkdown(parts: Part[] | undefined, budget: { left: number; skipped: number }): string {
  const calls = (parts ?? []).filter(
    (p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call',
  );
  if (!calls.length) return '';
  const results = new Map(
    (parts ?? []).flatMap((p) => (p.type === 'tool_result' ? [[p.call_id, p] as const] : [])),
  );
  const out: string[] = [];
  let listed = 0;
  for (const c of calls) {
    if (budget.left <= 0) {
      budget.skipped++;
      continue;
    }
    budget.left--;
    listed++;
    const r = results.get(c.call_id);
    const state = !r ? 'no result' : r.declined_reason !== undefined ? 'declined' : r.ok ? 'ok' : 'failed';
    out.push(`- **${c.tool}** (${state})`);
    const args = cut(show(c.args));
    if (args) out.push('', fenced(args, 'json').replace(/^/gm, '  '), '');
    const res = r ? cut(show(r.declined_reason ?? r.result)) : '';
    if (res) out.push('  Result:', '', fenced(res).replace(/^/gm, '  '), '');
  }
  if (!listed) return '';
  return `<details>\n<summary>Tool steps (${listed})</summary>\n\n${out.join('\n')}\n\n</details>`;
}

function receiptLine(m: MessageView): string {
  const bits: string[] = [m.modelName ?? modelName(m.modelId)];
  if (m.usage?.tokens) bits.push(`${m.usage.tokens.toLocaleString('en-GB')} tokens`);
  if (m.usage && m.usage.costUsd > 0) bits.push(`$${m.usage.costUsd.toFixed(4)}`);
  if (m.usage?.ms) bits.push(`${(m.usage.ms / 1000).toFixed(1)} s`);
  return `*Receipt: ${bits.join(', ')}*`;
}

/** The branch on screen as Markdown. */
export function exportMarkdown(
  t: Pick<ThreadView, 'title' | 'messages'>,
  o: ExportOptions = DEFAULT_EXPORT,
): string {
  const lines = [`# ${t.title}`, ''];
  const budget = { left: MAX_STEPS, skipped: 0 };
  let n = 0;
  for (const m of t.messages) {
    if (m.folded || m.cc) continue;
    n++;
    const who = m.role === 'user' ? 'You' : (m.modelName ?? modelName(m.modelId));
    lines.push(`## ${who}`, '');
    if (o.thinking && m.role === 'assistant') {
      const thought = (m.parts ?? [])
        .flatMap((p) => (p.type === 'reasoning' && p.text.trim() ? [p.text.trim()] : []))
        .join('\n\n');
      if (thought) lines.push(`<details>\n<summary>Thinking</summary>\n\n${thought}\n\n</details>`, '');
    }
    if (o.steps && m.role === 'assistant') {
      const steps = stepsMarkdown(m.parts, budget);
      if (steps) lines.push(steps, '');
    }
    const body = m.parts ? textOfParts(m.parts) : blocksText(m);
    const text = o.sources && m.role === 'assistant' ? withFootnotes(body, citationsOf(m), `a${n}-`) : body;
    lines.push(text.trim() || '(no text)', '');
    if (o.sources && m.role === 'assistant') {
      // A marker the text never used still names a source the answer drew on.
      const cited = new Set([...text.matchAll(/\[\^a\d+-(\d+)\]/g)].map((x) => Number(x[1])));
      const spare = citationsOf(m).filter((c) => !cited.has(c.marker));
      if (spare.length)
        lines.push(
          `Also drawn on: ${spare.map((c) => c.title || 'a source that has since been removed').join('; ')}`,
          '',
        );
    }
    if (o.receipts && m.role === 'assistant') lines.push(receiptLine(m), '');
  }
  if (budget.skipped) lines.push(`*${budget.skipped} more tool steps are not listed.*`, '');
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

function blocksText(m: MessageView): string {
  return m.blocks
    .map((b) =>
      b.kind === 'h'
        ? b.text
        : b.kind === 'p'
          ? b.spans.map((s) => s.text).join('')
          : b.items.map((i) => `- ${i.map((s) => s.text).join('')}`).join('\n'),
    )
    .join('\n\n');
}

const PAGE_CSS = `
:root{color-scheme:light dark}
body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1b1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e8e8ec;background:#141418}pre{background:#1f1f25}}
h1{font-size:1.6rem}h2{font-size:1.1rem;margin-top:2rem;border-top:1px solid #8884;padding-top:1rem}
pre{background:#f3f3f6;padding:.75rem;border-radius:6px;overflow:auto;white-space:pre-wrap}
code{font:0.9em ui-monospace,monospace}details{margin:.5rem 0}summary{cursor:pointer}
.note{font-size:.9rem;opacity:.85}
@media print{body{margin:0;max-width:none;color:#000;background:#fff}pre{background:#f3f3f3}
details>*{display:block}h2{break-after:avoid}pre,blockquote{break-inside:avoid}}
`;

/** `<details>` blocks in the Markdown become real details elements in the page. */
function detailsToHtml(md: string): string {
  const parts = md.split(/(<details>\n<summary>[^\n]*<\/summary>\n\n[\s\S]*?\n\n<\/details>)/g);
  return parts
    .map((chunk) => {
      const m = /^<details>\n<summary>([^\n]*)<\/summary>\n\n([\s\S]*?)\n\n<\/details>$/.exec(chunk);
      if (!m) return markdownToHtml(chunk);
      return `<details open><summary>${escapeHtml((m[1] ?? '').replace(/<[^>]*>/g, ''))}</summary>\n${markdownToHtml(m[2] ?? '')}\n</details>`;
    })
    .join('\n');
}

/** A self-contained page: no scripts, no outside files, a print stylesheet for PDF. */
export function exportHtml(
  t: Pick<ThreadView, 'title' | 'messages'>,
  o: ExportOptions = DEFAULT_EXPORT,
): string {
  const md = exportMarkdown(t, o).replace(/^# .*\n/, '');
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(t.title)}</title><style>${PAGE_CSS}</style></head>
<body><h1>${escapeHtml(t.title)}</h1>
${detailsToHtml(md)}
</body></html>
`;
}

/** A file name from a title: letters, numbers, dashes. */
export function exportName(title: string, ext: string): string {
  return `${
    title
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .slice(0, 80) || 'thread'
  }.${ext}`;
}
