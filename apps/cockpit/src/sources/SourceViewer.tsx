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
 *           |  A PDF opens on its original pages (PdfViewer), with
 *           |  "Text" one click away. The text view is Raw (the
 *           |  blocks above, exactly as stored) or Rendered (the
 *           |  answer's markdown pipeline); a citation opens Raw so the
 *           |  exact span stays highlighted.
 *  Note     |  The choices last for the session, per source.
 * ------------------------------------------------------------------
 */

import type { SourceContent } from '@nvx/contracts';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { useSource, useSourceContent } from '../lib/data';
import { scrollBehavior } from '../lib/motion';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { MD_COMPONENTS } from '../thread/Citations';
import { REMARK_PLUGINS } from '../thread/mdPlugins';
import { Segmented } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { isMarkdown, isPdf } from './pdf';
import { KIND_ICON } from './SourceCard';

// pdf.js is large: its viewer (and pdf.js itself) load only when a PDF is opened.
const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })));

type Mode = 'original' | 'text';
type TextView = 'rendered' | 'raw';
/** The session's choices per source (cleared on reload). */
const modeMemory = new Map<string, Mode>();
const viewMemory = new Map<string, TextView>();
/** Longer than this, the rendered view would be slow: raw only. */
const RENDER_MAX = 400_000;

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
  const [modeChoice, setModeChoice] = useState<Mode | null>(() => modeMemory.get(sourceId) ?? null);
  const [viewChoice, setViewChoice] = useState<TextView | null>(() => viewMemory.get(sourceId) ?? null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hi: [number, number] | null = start != null && end != null && end > start ? [start, end] : null;
  const blocks = useMemo(() => (content.data ? blocksOf(content.data) : []), [content.data]);

  const s = source.data;
  const citePage = hi
    ? content.data?.pages.find((p) => hi[0] >= p.char_start && hi[0] < p.char_end)?.page
    : undefined;

  // A PDF opens on its pages, unless a citation has no page to land on.
  const pdf = s ? isPdf(s) : false;
  const mode: Mode = pdf ? (modeChoice ?? (hi && content.data && !citePage ? 'text' : 'original')) : 'text';
  const tooLong = (content.data?.markdown.length ?? 0) > RENDER_MAX;
  // A citation shows the exact characters (raw); markdown files read rendered.
  const view: TextView = tooLong
    ? 'raw'
    : hi
      ? (viewChoice ?? 'raw')
      : (viewChoice ?? (s && isMarkdown(s) ? 'rendered' : 'raw'));
  const raw = mode === 'text' && view === 'raw';

  const chooseMode = (m: Mode) => {
    modeMemory.set(sourceId, m);
    setModeChoice(m);
  };
  const chooseView = (v: TextView) => {
    viewMemory.set(sourceId, v);
    setViewChoice(v);
  };

  // Land on the cited passage, centred, once the text is in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs when the text, span or view changes; the DOM holds the target
  useEffect(() => {
    if (!blocks.length || !raw) return;
    const el = bodyRef.current?.querySelector<HTMLElement>('[data-cite]');
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
      el.classList.add('viewer__cite--land');
    } else bodyRef.current?.scrollTo({ top: 0 });
  }, [blocks, start, end, raw]);

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

  const jump = (offset: number) => {
    const target = blocks.find((b) => b.start >= offset) ?? blocks[blocks.length - 1];
    if (!target) return;
    bodyRef.current
      ?.querySelector(`[data-start="${target.start}"]`)
      ?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    setOutline(false);
  };

  const citeText = hi && content.data ? content.data.markdown.slice(hi[0], hi[1]) : null;

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
          {raw && content.data?.outline.length ? (
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
          {mode === 'text' ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Find in this source"
              aria-pressed={findOpen}
              onClick={() => {
                // Find walks the raw text, where every match can be marked.
                if (!findOpen && view === 'rendered') chooseView('raw');
                setFindOpen((o) => !o);
              }}
            >
              <Icon name="search" size={14} />
            </button>
          ) : null}
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

      {pdf || (content.data && !tooLong) ? (
        <div className="viewer__modes">
          {pdf ? (
            <Segmented<Mode>
              size="sm"
              label="Show the source as"
              value={mode}
              onChange={chooseMode}
              options={[
                { value: 'original', label: 'Original', icon: 'file' },
                { value: 'text', label: 'Text', icon: 'text' },
              ]}
            />
          ) : null}
          {mode === 'text' && content.data && !tooLong ? (
            <Segmented<TextView>
              size="sm"
              label="Show the text as"
              value={view}
              onChange={(v) => {
                chooseView(v);
                if (v === 'rendered') {
                  setFindOpen(false);
                  setFind('');
                  setOutline(false);
                }
              }}
              options={[
                { value: 'rendered', label: 'Rendered' },
                { value: 'raw', label: 'Raw' },
              ]}
            />
          ) : null}
        </div>
      ) : null}

      {mode === 'original' ? (
        <Suspense
          fallback={
            <div className="viewer__body">
              <Skeleton lines={10} label="Loading the PDF viewer" />
            </div>
          }
        >
          <PdfViewer
            key={sourceId}
            sourceId={sourceId}
            citePage={citePage ?? null}
            citeText={citeText}
            onShowText={() => chooseMode('text')}
          />
        </Suspense>
      ) : (
        <>
          {findOpen && raw ? (
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

          {outline && raw && content.data ? (
            <nav className="viewer__outline" aria-label="Contents">
              <ul>
                {content.data.outline.map((o) => (
                  <li key={o.char_start} style={{ paddingLeft: `${(o.level - 1) * 12}px` }}>
                    <button
                      type="button"
                      className="link-btn link-btn--quiet"
                      onClick={() => jump(o.char_start)}
                    >
                      {o.title}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <div className="viewer__body" ref={bodyRef} data-scrollable data-view={view}>
            {content.isPending ? (
              <Skeleton lines={14} label="Loading the source" />
            ) : content.isError ? (
              <p className="viewer__error">
                This source's text could not be loaded. It may still be being read; try again in a moment.
              </p>
            ) : !content.data?.markdown.trim() ? (
              <p className="viewer__error">
                No text was found in this source.{pdf ? ' Choose Original to see its pages.' : ''}
              </p>
            ) : view === 'rendered' ? (
              <Streamdown
                className="md viewer__md"
                mode="static"
                controls={false}
                components={MD_COMPONENTS}
                remarkPlugins={REMARK_PLUGINS}
              >
                {content.data.markdown}
              </Streamdown>
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
        </>
      )}
    </section>
  );
}
