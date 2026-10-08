/**
 * ------------------------------------------------------------------
 *  Title    |  Source viewer
 *  Ref      |  ROADMAP.md Phase 3 ("opens the exact span")
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Read a source as NVX Ancile read it, and land on the
 *           |  exact passage an answer cited, highlighted, with its
 *           |  page for PDFs. Find inside it; jump by its headings.
 *  How      |  The text is split into blocks on blank lines, keeping
 *           |  each block's offset into the markdown Core stores, so
 *           |  [char_start, char_end) from a citation highlights the
 *           |  very characters that were cited. Pages come from the
 *           |  page table and show as quiet dividers.
 *  Note     |  Inline markdown is shown as written: this is the
 *           |  source, not a rendering of it.
 * ------------------------------------------------------------------
 */

import type { SourceContent } from '@nvx/contracts';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useSource, useSourceContent } from '../lib/data';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { KIND_ICON } from './SourceCard';

interface Block {
  start: number;
  end: number;
  text: string;
  kind: 'h1' | 'h2' | 'h3' | 'p' | 'code' | 'li';
  page: number | null;
}

function blocksOf(c: SourceContent): Block[] {
  const md = c.markdown;
  const out: Block[] = [];
  const pageAt = (i: number) => c.pages.find((p) => i >= p.char_start && i < p.char_end)?.page ?? null;
  const re = /\n{2,}/g;
  let last = 0;
  let inFence = false;
  let fenceStart = 0;
  const push = (start: number, end: number) => {
    const raw = md.slice(start, end);
    if (!raw.trim()) return;
    const lead = raw.length - raw.trimStart().length;
    const s = start + lead;
    const text = md.slice(s, end);
    const h = /^(#{1,6})\s/.exec(text);
    const kind: Block['kind'] = text.startsWith('```')
      ? 'code'
      : h
        ? (`h${Math.min(3, h[1]?.length ?? 1)}` as Block['kind'])
        : /^\s*([-*+]|\d+\.)\s/.test(text)
          ? 'li'
          : 'p';
    out.push({ start: s, end, text, kind, page: pageAt(s) });
  };
  for (let m = re.exec(md); m; m = re.exec(md)) {
    const chunk = md.slice(last, m.index);
    const fences = (chunk.match(/```/g) ?? []).length;
    if (!inFence && fences % 2 === 1) {
      inFence = true;
      fenceStart = last;
    } else if (inFence && fences % 2 === 1) {
      inFence = false;
      push(fenceStart, m.index);
    } else if (!inFence) push(last, m.index);
    last = m.index + m[0].length;
  }
  push(inFence ? fenceStart : last, md.length);
  return out;
}

/** Text with the cited span and any find matches marked. */
function marked(b: Block, hi: [number, number] | null, find: string): ReactNode {
  const ranges: { s: number; e: number; kind: 'cite' | 'find' }[] = [];
  if (hi && hi[0] < b.end && hi[1] > b.start)
    ranges.push({ s: Math.max(hi[0], b.start) - b.start, e: Math.min(hi[1], b.end) - b.start, kind: 'cite' });
  if (find.length >= 2) {
    const low = b.text.toLowerCase();
    const q = find.toLowerCase();
    for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, i + q.length))
      ranges.push({ s: i, e: i + q.length, kind: 'find' });
  }
  if (!ranges.length) return b.text;
  ranges.sort((a, z) => a.s - z.s);
  const out: ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.s < at) continue;
    if (r.s > at) out.push(b.text.slice(at, r.s));
    out.push(
      r.kind === 'cite' ? (
        <mark key={`c${r.s}`} className="viewer__cite" data-cite>
          {b.text.slice(r.s, r.e)}
        </mark>
      ) : (
        <mark key={`f${r.s}`} className="viewer__find" data-find>
          {b.text.slice(r.s, r.e)}
        </mark>
      ),
    );
    at = r.e;
  }
  if (at < b.text.length) out.push(b.text.slice(at));
  return out;
}

export function SourceViewer({
  sourceId,
  start,
  end,
  marker,
}: {
  sourceId: string;
  start?: number;
  end?: number;
  marker?: number;
}) {
  const content = useSourceContent(sourceId);
  const source = useSource(sourceId);
  const openViewer = useUi((s) => s.openViewer);
  const [find, setFind] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [hit, setHit] = useState(0);
  const [outline, setOutline] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hi: [number, number] | null = start != null && end != null && end > start ? [start, end] : null;
  const blocks = useMemo(() => (content.data ? blocksOf(content.data) : []), [content.data]);

  // Land on the cited passage, centred, once the text is in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs when the text, span or query changes; the DOM holds the target
  useEffect(() => {
    if (!blocks.length) return;
    const el = bodyRef.current?.querySelector<HTMLElement>('[data-cite]');
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('viewer__cite--land');
    } else bodyRef.current?.scrollTo({ top: 0 });
  }, [blocks, start, end]);

  // Walk find matches.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs when the text, span or query changes; the DOM holds the target
  useEffect(() => {
    const all = bodyRef.current?.querySelectorAll<HTMLElement>('[data-find]') ?? [];
    for (const [i, el] of Array.from(all).entries()) el.dataset.current = i === hit ? 'true' : 'false';
    all[hit]?.scrollIntoView({ block: 'center' });
  }, [hit, find, blocks]);

  const matchCount = useMemo(() => {
    if (find.length < 2 || !content.data) return 0;
    const low = content.data.markdown.toLowerCase();
    const q = find.toLowerCase();
    let n = 0;
    for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, i + q.length)) n++;
    return n;
  }, [find, content.data]);

  const s = source.data;
  const citePage = hi
    ? content.data?.pages.find((p) => hi[0] >= p.char_start && hi[0] < p.char_end)?.page
    : undefined;

  const jump = (offset: number) => {
    const target = blocks.find((b) => b.start >= offset) ?? blocks[blocks.length - 1];
    if (!target) return;
    bodyRef.current
      ?.querySelector(`[data-start="${target.start}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setOutline(false);
  };

  return (
    <section className="viewer" aria-label={`Source: ${s?.title ?? 'loading'}`} data-tour="viewer">
      <header className="viewer__head">
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Back to sources"
          onClick={() => openViewer(null)}
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="viewer__kind">
          <Icon name={s ? KIND_ICON[s.kind] : 'file'} size={14} />
        </span>
        <div className="viewer__titles">
          <h2 className="viewer__title" dir="auto">
            {s?.title ?? 'Source'}
          </h2>
          <p className="viewer__sub mute">
            {marker != null ? `Cited as [${marker}]` : s?.detail}
            {citePage ? ` · page ${citePage}` : ''}
          </p>
        </div>
        <div className="viewer__tools">
          {content.data?.outline.length ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Contents"
              aria-pressed={outline}
              onClick={() => setOutline((o) => !o)}
            >
              <Icon name="cite" size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Find in this source"
            aria-pressed={findOpen}
            onClick={() => setFindOpen((o) => !o)}
          >
            <Icon name="search" size={14} />
          </button>
          {hi && content.data ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Copy the cited passage"
              onClick={() => {
                void navigator.clipboard?.writeText(content.data?.markdown.slice(hi[0], hi[1]) ?? '');
                notify({ level: 'success', title: 'Passage copied' });
              }}
            >
              <Icon name="copy" size={14} />
            </button>
          ) : null}
          {s?.kind === 'url' && s.uri ? (
            <a
              className="icon-btn icon-btn--sm"
              href={s.uri}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open the page"
            >
              <Icon name="ext" size={14} />
            </a>
          ) : s?.kind === 'file' ? (
            <a
              className="icon-btn icon-btn--sm"
              href={`/api/v1/sources/${sourceId}/file`}
              target="_blank"
              rel="noopener"
              aria-label="Open the original file"
            >
              <Icon name="download" size={14} />
            </a>
          ) : null}
        </div>
      </header>

      {findOpen ? (
        <div className="viewer__find-bar">
          <Icon name="search" size={13} />
          <input
            // biome-ignore lint/a11y/noAutofocus: the person just asked to find
            autoFocus
            value={find}
            onChange={(e) => {
              setFind(e.target.value);
              setHit(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter')
                setHit((h) => (matchCount ? (h + (e.shiftKey ? -1 + matchCount : 1)) % matchCount : 0));
              if (e.key === 'Escape') {
                e.stopPropagation();
                setFindOpen(false);
                setFind('');
              }
            }}
            placeholder="Find in this source"
            aria-label="Find in this source"
          />
          <span className="mute" data-num>
            {find.length >= 2 ? (matchCount ? `${hit + 1} of ${matchCount}` : 'None') : ''}
          </span>
        </div>
      ) : null}

      {outline && content.data ? (
        <nav className="viewer__outline" aria-label="Contents">
          <ul>
            {content.data.outline.map((o) => (
              <li key={o.char_start} style={{ paddingLeft: `${(o.level - 1) * 12}px` }}>
                <button type="button" className="link-btn link-btn--quiet" onClick={() => jump(o.char_start)}>
                  {o.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <div className="viewer__body" ref={bodyRef} data-scrollable>
        {content.isPending ? (
          <Skeleton lines={14} label="Loading the source" />
        ) : content.isError ? (
          <p className="viewer__error">
            This source's text could not be loaded. It may still be being read; try again in a moment.
          </p>
        ) : (
          blocks.map((b, i) => {
            const newPage = b.page != null && b.page !== blocks[i - 1]?.page;
            const Tag =
              b.kind === 'h1'
                ? 'h3'
                : b.kind === 'h2'
                  ? 'h4'
                  : b.kind === 'h3'
                    ? 'h5'
                    : b.kind === 'code'
                      ? 'pre'
                      : 'p';
            return (
              <div key={b.start} data-start={b.start}>
                {newPage ? (
                  <div className="viewer__page" data-num>
                    Page {b.page}
                  </div>
                ) : null}
                <Tag className={`viewer__block viewer__block--${b.kind}`} dir="auto">
                  {b.kind.startsWith('h')
                    ? b.text.replace(/^#{1,6}\s+/, '')
                    : marked(b, hi, findOpen ? find : '')}
                </Tag>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
