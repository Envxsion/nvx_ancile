/**
 * ------------------------------------------------------------------
 *  Title    |  An answer as text, in the form you paste
 *  Ref      |  roadmap AN1 · EX3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Turn an answer into Markdown, plain text, rich text
 *           |  (HTML) or Markdown with its sources as footnotes, and
 *           |  say which of them was used last.
 *  How      |  Pure functions over the stored markdown. The HTML is
 *           |  built by escaping first and adding tags second, so
 *           |  nothing in an answer can become markup. Rich copy
 *           |  writes text/html and text/plain together; where the
 *           |  browser will not write HTML it writes the Markdown.
 *  Note     |  Loaded on first use (a dynamic import), never in the
 *           |  first-load path.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';
import type { CitationView } from './types';

export type CopyFormat = 'markdown' | 'plain' | 'rich' | 'sources';

export const COPY_FORMATS: { id: CopyFormat; label: string; hint: string }[] = [
  { id: 'markdown', label: 'Markdown', hint: 'Headings, lists and code as written' },
  { id: 'plain', label: 'Plain text', hint: 'No formatting marks' },
  { id: 'rich', label: 'Rich text', hint: 'Keeps formatting in Docs, Slack and email' },
  { id: 'sources', label: 'Markdown with sources', hint: 'Sources added as footnotes' },
];

const KEY = 'ancile.copyFormat';

/** The format used last, or Markdown. */
export function lastCopyFormat(): CopyFormat {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'markdown' || v === 'plain' || v === 'rich' || v === 'sources') return v;
  } catch {
    /* storage can be blocked; the default is fine */
  }
  return 'markdown';
}

export function rememberCopyFormat(f: CopyFormat): void {
  try {
    localStorage.setItem(KEY, f);
  } catch {
    /* not remembered; nothing is lost */
  }
}

/**
 * The sources an answer cites, from its citation parts: one per marker. A source removed since
 * keeps the title it had when the answer was written; with none, it is named as removed.
 */
export function citationsOf(m: {
  parts?: Part[] | undefined;
  citations?: CitationView[] | undefined;
}): CitationView[] {
  if (m.citations?.length) return m.citations;
  const seen = new Map<number, CitationView>();
  for (const p of m.parts ?? []) {
    if (p.type !== 'citation_ref' || seen.has(p.marker)) continue;
    seen.set(p.marker, {
      marker: p.marker,
      sourceId: p.source_id,
      title: p.source_title ?? 'A source that has since been removed',
      quote: p.quote,
      location: p.notebook_title ? `in ${p.notebook_title}` : '',
    });
  }
  return [...seen.values()];
}

/**
 * Footnote the markers an answer uses: `[2]` becomes `[^2]` and the sources follow as definitions.
 * Markers the answer never uses are left out, so the list matches what was cited.
 */
export function withFootnotes(text: string, citations: CitationView[] | undefined, prefix = ''): string {
  const list = (citations ?? []).filter((c) => c.title || c.quote);
  if (!list.length) return text;
  const used = new Set<number>();
  const body = text.replace(/\[(\d{1,3})\](?!\()/g, (whole, n: string) => {
    const marker = Number(n);
    if (!list.some((c) => c.marker === marker)) return whole;
    used.add(marker);
    return `[^${prefix}${marker}]`;
  });
  const notes = list
    .filter((c) => used.has(c.marker))
    .sort((a, b) => a.marker - b.marker)
    .map((c) => {
      const where = c.location ? `, ${c.location}` : '';
      const quote = c.quote ? ` "${c.quote.replace(/\s+/g, ' ').trim().slice(0, 240)}"` : '';
      return `[^${prefix}${c.marker}]: ${c.title || 'Source'}${where}.${quote}`;
    });
  return notes.length ? `${body.replace(/\s+$/, '')}\n\n${notes.join('\n')}\n` : body;
}

/** Markdown with its marks taken off: what you would read, not how it is written. */
export function markdownToPlain(md: string): string {
  const fences: string[] = [];
  const kept = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_w, code: string) => {
    fences.push(code.replace(/\n$/, ''));
    return `${fences.length - 1}`;
  });
  const plain = kept
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[^\S\n]{0,3}>[^\S\n]?/gm, '')
    .replace(/^[^\S\n]*[-*+][^\S\n]+/gm, '- ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_w, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1')
    .replace(/(?<![\w_])_(?!\s)(.+?)_(?!\w)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^[^\S\n]*([-*_])\1{2,}[^\S\n]*$/gm, '');
  return plain
    .replace(/(\d+)/g, (_w, i: string) => fences[Number(i)] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A link is kept only if it goes somewhere a page may safely send you. */
function safeHref(url: string): string | null {
  return /^(https?:|mailto:)/i.test(url.trim()) ? url.trim() : null;
}

function inline(s: string): string {
  const codes: string[] = [];
  let out = escapeHtml(s).replace(/`([^`\n]+)`/g, (_w, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `${codes.length - 1}`;
  });
  out = out
    .replace(/\[\^(\d{1,3})\]/g, '<sup>$1</sup>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
      // The url was escaped with the rest, so undo only the ampersand to test it.
      const href = safeHref(url.replace(/&amp;/g, '&'));
      return href ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>` : whole;
    })
    .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
    .replace(/(?<![\w*])\*(?!\s)(.+?)\*(?!\w)/g, '<em>$1</em>');
  return out.replace(/(\d+)/g, (_w, i: string) => codes[Number(i)] ?? '');
}

/** The markdown an answer is written in, as HTML: headings, paragraphs, lists, quotes, code. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r/g, '').split('\n');
  const html: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list)
      html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i] ?? ''); i++) code.push(lines[i] ?? '');
      const lang = fence[1] ? ` class="language-${escapeHtml(fence[1].replace(/[^\w+#.-]/g, ''))}"` : '';
      html.push(`<pre><code${lang}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    const note = /^\[\^(\d{1,3})\]:\s*(.*)$/.exec(line);
    if (head) {
      flushPara();
      flushList();
      const level = (head[1] ?? '#').length;
      html.push(`<h${level}>${inline(head[2] ?? '')}</h${level}>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)?.[1] ?? '');
    } else if (quote) {
      flushPara();
      flushList();
      html.push(`<blockquote>${inline(quote[1] ?? '')}</blockquote>`);
    } else if (note) {
      flushPara();
      flushList();
      html.push(`<p class="note"><sup>${note[1]}</sup> ${inline(note[2] ?? '')}</p>`);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return html.join('\n');
}

export interface AnswerSource {
  text: string;
  citations?: CitationView[] | undefined;
}

/** What goes on the clipboard for a format: the text and, for rich text, its HTML too. */
export function clipboardFor(a: AnswerSource, f: CopyFormat): { text: string; html?: string } {
  switch (f) {
    case 'plain':
      return { text: markdownToPlain(a.text) };
    case 'sources':
      return { text: withFootnotes(a.text, a.citations) };
    case 'rich':
      return { text: a.text, html: markdownToHtml(withFootnotes(a.text, a.citations)) };
    default:
      return { text: a.text };
  }
}

/** Put it on the clipboard. Resolves false when the browser refuses (clipboard blocked). */
export async function copyAnswer(a: AnswerSource, f: CopyFormat): Promise<boolean> {
  const { text, html } = clipboardFor(a, f);
  try {
    if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
