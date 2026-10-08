/**
 * ------------------------------------------------------------------
 *  Title    |  Sticky-note markdown
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Notes on the flow canvas read as formatted text: bold,
 *           |  italics, inline code, links, headings and lists.
 *  How      |  A tiny renderer that builds React elements, never HTML,
 *           |  so nothing in a note can run or inject markup. Links are
 *           |  http(s) or mailto only and open in a new tab with
 *           |  rel="noopener noreferrer".
 *  Note     |  Deliberately small: a canvas note is not a document.
 * ------------------------------------------------------------------
 */

import type { ReactNode } from 'react';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline spans: `code`, **bold**, *italic* or _italic_, [text](url). */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: the usual exec loop
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else {
      const [, label = '', url = ''] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok) ?? [];
      out.push(
        SAFE_URL.test(url) ? (
          <a key={k} href={url} target="_blank" rel="noopener noreferrer">
            {inline(label, k)}
          </a>
        ) : (
          label
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Block structure: headings, bullet and numbered lists, paragraphs. */
export function NoteMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length)
      blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(' '), `p${blocks.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity but their place
      <li key={i}>{inline(it, `l${blocks.length}-${i}`)}</li>
    ));
    blocks.push(
      list.ordered ? <ol key={`l${blocks.length}`}>{items}</ol> : <ul key={`l${blocks.length}`}>{items}</ul>,
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push(
        <p key={`h${blocks.length}`} className="fnote__h">
          {inline(heading[2] ?? '', `h${blocks.length}`)}
        </p>,
      );
    } else if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(((bullet ?? numbered) as RegExpExecArray)[1] ?? '');
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <>{blocks}</>;
}
