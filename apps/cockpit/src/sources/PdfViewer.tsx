/**
 * ------------------------------------------------------------------
 *  Title    |  PDF viewer
 *  Ref      |  ROADMAP.md "Final run before v1" (B) · sources/pdf.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Read a PDF source as the original pages, and land on
 *           |  the exact words an answer cited: the cited page, the
 *           |  passage highlighted on it. Move by page, zoom, and
 *           |  find across the whole document.
 *  How      |  pdf.js (Apache-2.0) is loaded on first use, in its own
 *           |  chunk, with its own worker. The file comes from
 *           |  /sources/:id/file as bytes. Pages are drawn only near
 *           |  the view (canvas at the screen's pixel ratio, plus
 *           |  pdf.js's text layer for selection and highlights) and
 *           |  dropped again when far away. Matching the cited passage
 *           |  and searches against the text runs is in pdf.ts.
 *  Note     |  The cited passage is found on the cited page, then the
 *           |  page after and before (extracted page numbers can be
 *           |  off by one). Not found: the page is marked and the
 *           |  viewer says so, rather than guessing.
 *           |  TODO(phase-6): standard font data and the JPEG 2000
 *           |  decoder (pdf.js standardFontDataUrl, wasmUrl) are not
 *           |  shipped; PDFs relying on them fall back to system fonts
 *           |  or show such images blank.
 * ------------------------------------------------------------------
 */

import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { countMatches, findAll, locatePassage, type Match, pagesToTry, zoomStep } from './pdf';

type Pdfjs = typeof import('pdfjs-dist');
type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

let loader: Promise<Pdfjs> | null = null;

/** pdf.js and its worker, once per session. */
function loadPdfjs(): Promise<Pdfjs> {
  loader ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
    .then(([m, worker]) => {
      m.GlobalWorkerOptions.workerSrc = worker.default;
      return m;
    })
    .catch((err: unknown) => {
      loader = null;
      throw err;
    });
  return loader;
}

interface Problem {
  title: string;
  hint: string;
  detail?: string;
}

type Load =
  | { state: 'loading'; progress: number | null }
  | { state: 'ready'; doc: PDFDocumentProxy; pdfjs: Pdfjs }
  | { state: 'error'; problem: Problem };

function problemOf(err: unknown): Problem {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'PasswordException')
    return {
      title: 'This PDF is protected by a password',
      hint: 'Open the original file to enter the password, or read the text NVX Ancile extracted.',
    };
  if (name === 'InvalidPDFException')
    return {
      title: 'This file is not a readable PDF',
      hint: 'It may be damaged. Read the extracted text instead, or add the file again.',
    };
  return {
    title: 'This PDF could not be shown',
    hint: 'Try again, read the text NVX Ancile extracted, or open the original file.',
    detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
  };
}

/** The source's original file, with download progress. */
async function fetchPdf(sourceId: string, signal: AbortSignal, onProgress: (p: number) => void) {
  const res = await fetch(`/api/v1/sources/${encodeURIComponent(sourceId)}/file`, {
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok) {
    let title = `NVX Ancile answered ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { title?: string } };
      if (body.error?.title) title = body.error.title;
    } catch {
      // Not JSON: keep the status.
    }
    throw new Error(title);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function usePdf(sourceId: string, attempt: number): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading', progress: null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry button
  useEffect(() => {
    const abort = new AbortController();
    let task: PDFDocumentLoadingTask | null = null;
    setLoad({ state: 'loading', progress: null });
    (async () => {
      const [pdfjs, data] = await Promise.all([
        loadPdfjs(),
        fetchPdf(sourceId, abort.signal, (p) => setLoad({ state: 'loading', progress: p })),
      ]);
      task = pdfjs.getDocument({ data, enableXfa: false, isEvalSupported: false } as Parameters<
        Pdfjs['getDocument']
      >[0]);
      const doc = await task.promise;
      if (!abort.signal.aborted) setLoad({ state: 'ready', doc, pdfjs });
    })().catch((err: unknown) => {
      if (!abort.signal.aborted) setLoad({ state: 'error', problem: problemOf(err) });
    });
    return () => {
      abort.abort();
      void task?.destroy();
    };
  }, [sourceId, attempt]);
  return load;
}

interface PageText {
  content: TextContent;
  items: string[];
}

/** Marks one page shows: the cited passage, find matches, and which one is current. */
interface PageMarks {
  cite: string | null;
  citeMissing: boolean;
  find: string;
  current: number | null;
  /** Bumped to scroll the cite or current match into view once drawn. */
  focus: { what: 'cite' | 'find'; token: number } | null;
}

const NO_MARKS: PageMarks = { cite: null, citeMissing: false, find: '', current: null, focus: null };

interface Range {
  start: number;
  end: number;
  kind: 'cite' | 'find';
  current: boolean;
}

/**
 * Find matches win where they overlap the cited words (you are looking for
 * them now); the cite keeps the characters on either side.
 */
function withoutOverlap(ranges: Range[]): Range[] {
  const finds = ranges.filter((r) => r.kind === 'find');
  if (!finds.length) return ranges;
  const out: Range[] = [...finds];
  for (const c of ranges.filter((r) => r.kind === 'cite')) {
    let pieces = [{ start: c.start, end: c.end }];
    for (const f of finds)
      pieces = pieces.flatMap((p) =>
        f.end <= p.start || f.start >= p.end
          ? [p]
          : [
              ...(f.start > p.start ? [{ start: p.start, end: f.start }] : []),
              ...(f.end < p.end ? [{ start: f.end, end: p.end }] : []),
            ],
      );
    for (const p of pieces) out.push({ ...c, ...p });
  }
  return out;
}

/** Put a run's text back, with its marked ranges wrapped. */
function paint(div: HTMLElement, text: string, ranges: Range[]) {
  if (!ranges.length) {
    if (div.childElementCount || div.textContent !== text) div.textContent = text;
    return;
  }
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.start < at) continue;
    if (r.start > at) frag.append(text.slice(at, r.start));
    const m = document.createElement('mark');
    m.className = r.kind === 'cite' ? 'pdf__mark pdf__mark--cite' : 'pdf__mark pdf__mark--find';
    if (r.current) m.dataset.current = 'true';
    m.textContent = text.slice(r.start, r.end);
    frag.append(m);
    at = r.end;
  }
  if (at < text.length) frag.append(text.slice(at));
  div.replaceChildren(frag);
}

function PageView({
  doc,
  pdfjs,
  n,
  count,
  scale,
  base,
  near,
  text,
  marks,
  register,
}: {
  doc: PDFDocumentProxy;
  pdfjs: Pdfjs;
  n: number;
  count: number;
  scale: number;
  base: { w: number; h: number };
  near: boolean;
  text: (n: number) => Promise<PageText>;
  marks: PageMarks;
  register: (n: number, el: HTMLElement | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const runs = useRef<{ divs: HTMLElement[]; items: string[] } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [drawn, setDrawn] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!near) {
      runs.current = null;
      setDrawn(0);
      return;
    }
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let layer: { cancel: () => void } | null = null;
    (async () => {
      const page = await doc.getPage(n);
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      setSize({ w: vp.width, h: vp.height });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      task = page.render({
        canvasContext: ctx,
        canvas,
        viewport: vp,
        ...(dpr !== 1 && { transform: [dpr, 0, 0, dpr, 0, 0] }),
      });
      await task.promise;
      const { content } = await text(n);
      const box = layerRef.current;
      if (cancelled || !box) return;
      box.replaceChildren();
      const tl = new pdfjs.TextLayer({ textContentSource: content, container: box, viewport: vp });
      layer = tl;
      await tl.render();
      if (cancelled) return;
      runs.current = { divs: tl.textDivs, items: tl.textContentItemsStr };
      setFailed(false);
      setDrawn((d) => d + 1);
    })().catch((err: unknown) => {
      if (cancelled || (err as { name?: string })?.name === 'RenderingCancelledException') return;
      setFailed(true);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [doc, pdfjs, n, scale, near, text]);

  // Highlights: repainted whenever the page is drawn or the marks change.
  useEffect(() => {
    const r = runs.current;
    if (!drawn || !r) return;
    const per = new Map<number, Range[]>();
    const add = (m: Match | undefined, kind: Range['kind'], current: boolean) => {
      for (const x of m ?? []) {
        const list = per.get(x.item) ?? [];
        list.push({ start: x.start, end: x.end, kind, current });
        per.set(x.item, list);
      }
    };
    if (marks.cite) add(findAll(r.items, marks.cite, 1)[0], 'cite', false);
    if (marks.find)
      for (const [i, m] of findAll(r.items, marks.find).entries()) add(m, 'find', i === marks.current);
    r.divs.forEach((div, i) => {
      paint(div, r.items[i] ?? '', withoutOverlap(per.get(i) ?? []));
    });
  }, [drawn, marks.cite, marks.find, marks.current]);

  // Bring the cited words, or the current match, to the middle of the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when asked (token) and once drawn
  useEffect(() => {
    if (!marks.focus || !drawn) return;
    const sel = marks.focus.what === 'cite' ? '.pdf__mark--cite' : '.pdf__mark--find[data-current]';
    const el = layerRef.current?.querySelector<HTMLElement>(sel);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (marks.focus.what === 'cite')
      for (const m of layerRef.current?.querySelectorAll('.pdf__mark--cite') ?? [])
        m.classList.add('pdf__mark--land');
  }, [marks.focus?.token, drawn]);

  const w = size?.w ?? base.w * scale;
  const h = size?.h ?? base.h * scale;
  return (
    <section
      ref={(el) => register(n, el)}
      className="pdf__page"
      data-page={n}
      data-cited={marks.citeMissing || undefined}
      aria-label={`Page ${n} of ${count}`}
      style={{ width: w, height: h, ['--total-scale-factor' as string]: String(scale) }}
    >
      {near ? (
        <>
          <canvas ref={canvasRef} className="pdf__canvas" style={{ width: w, height: h }} />
          <div ref={layerRef} className="textLayer pdf__text" />
        </>
      ) : null}
      {!drawn ? (
        <p className="pdf__placeholder mute" data-num>
          {failed ? `Page ${n} could not be drawn` : `Rendering page ${n} of ${count}`}
        </p>
      ) : null}
    </section>
  );
}

type Cite =
  | { state: 'none' }
  | { state: 'looking'; page: number }
  | { state: 'found'; page: number; needle: string; partial: boolean }
  | { state: 'missing'; page: number };

/** Session memory: the zoom chosen per source. */
const zoomMemory = new Map<string, number | 'fit'>();

export function PdfViewer({
  sourceId,
  citePage,
  citeText,
  onShowText,
}: {
  sourceId: string;
  /** The page the citation is on (from the source's page table). */
  citePage?: number | null;
  /** The cited passage as extracted (markdown); found on the page by its words. */
  citeText?: string | null;
  /** "Show text": back to the extracted text view. */
  onShowText: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const load = usePdf(sourceId, attempt);
  const doc = load.state === 'ready' ? load.doc : null;
  const pdfjs = load.state === 'ready' ? load.pdfjs : null;
  const count = doc?.numPages ?? 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<number, HTMLElement>());
  const texts = useRef(new Map<number, Promise<PageText>>());
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoomState] = useState<number | 'fit'>(() => zoomMemory.get(sourceId) ?? 'fit');
  const [near, setNear] = useState<Set<number>>(() => new Set([1]));
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [counts, setCounts] = useState<{ query: string; per: number[]; done: number } | null>(null);
  const [hit, setHit] = useState(0);
  const [focus, setFocus] = useState<PageMarks['focus']>(null);
  const [cite, setCite] = useState<Cite>({ state: 'none' });

  const setZoom = (z: number | 'fit') => {
    zoomMemory.set(sourceId, z);
    setZoomState(z);
  };

  // A new document: forget the old one's text.
  useEffect(() => {
    texts.current = new Map();
    setBase(null);
    if (!doc) return;
    void doc.getPage(1).then((p) => {
      const vp = p.getViewport({ scale: 1 });
      setBase({ w: vp.width, h: vp.height });
    });
  }, [doc]);

  const text = useCallback(
    (n: number): Promise<PageText> => {
      if (!doc) return Promise.reject(new Error('No document'));
      let t = texts.current.get(n);
      if (!t) {
        t = doc
          .getPage(n)
          .then((p) => p.getTextContent())
          .then((content) => ({
            content,
            // One string per text run, as the text layer draws them (marked-content entries draw none).
            items: content.items.flatMap((it) => ('str' in it ? [it.str] : [])),
          }));
        texts.current.set(n, t);
      }
      return t;
    },
    [doc],
  );

  // Fit to width: follow the panel's width.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (zoom !== 'fit') return zoom;
    if (!base || !width) return 1;
    return Math.max(0.25, Math.min(4, (width - 24) / base.w));
  }, [zoom, base, width]);

  // Which pages are near the view (drawn), and which one you are on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observed when pages are laid out
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !count || !base) return;
    const io = new IntersectionObserver(
      (entries) =>
        setNear((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        }),
      { root, rootMargin: '900px 0px' },
    );
    for (const el of pages.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [count, base, scale]);

  const onScroll = () => {
    const root = scrollRef.current;
    if (!root) return;
    const line = root.scrollTop + root.clientHeight / 3;
    let best = 1;
    for (const [n, el] of pages.current) if (el.offsetTop <= line && n > best) best = n;
    if (best !== current) {
      setCurrent(best);
      setPageInput(String(best));
    }
  };

  const goTo = useCallback(
    (n: number, behavior: ScrollBehavior = 'smooth') => {
      const p = Math.max(1, Math.min(count || 1, n));
      const el = pages.current.get(p);
      const root = scrollRef.current;
      if (el && root) root.scrollTo({ top: el.offsetTop - 8, behavior });
      setCurrent(p);
      setPageInput(String(p));
    },
    [count],
  );

  // Keep your page when the zoom changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on a new scale
  useEffect(() => {
    if (base) goTo(current, 'auto');
  }, [scale]);

  // The citation: find the passage on its page (or a neighbour), then land there.
  useEffect(() => {
    if (!doc || !base || !citePage) {
      setCite({ state: 'none' });
      return;
    }
    let cancelled = false;
    const page = Math.min(Math.max(1, citePage), doc.numPages);
    setCite({ state: 'looking', page });
    (async () => {
      if (citeText?.trim())
        for (const p of pagesToTry(page, doc.numPages)) {
          const { items } = await text(p);
          if (cancelled) return;
          const found = locatePassage(items, citeText);
          if (found) {
            setCite({ state: 'found', page: p, needle: found.needle, partial: found.kind === 'partial' });
            goTo(p, 'auto');
            setFocus({ what: 'cite', token: Date.now() });
            return;
          }
        }
      if (cancelled) return;
      setCite({ state: 'missing', page });
      goTo(page, 'auto');
    })().catch(() => {
      if (!cancelled) setCite({ state: 'missing', page });
    });
    return () => {
      cancelled = true;
    };
  }, [doc, base, citePage, citeText, text, goTo]);

  // Find: count matches on every page, in the background, a page at a time.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (!doc || debounced.length < 2) {
      setCounts(null);
      return;
    }
    let cancelled = false;
    const per: number[] = [];
    setHit(0);
    setCounts({ query: debounced, per: [], done: 0 });
    (async () => {
      for (let p = 1; p <= doc.numPages; p++) {
        const { items } = await text(p);
        if (cancelled) return;
        per.push(countMatches(items, debounced));
        if (p % 10 === 0 || p === doc.numPages) setCounts({ query: debounced, per: [...per], done: p });
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, debounced, text]);

  const total = counts?.per.reduce((a, b) => a + b, 0) ?? 0;
  const searching = counts !== null && counts.done < count;

  /** The page and ordinal on it of match number `i` (0-based, document order). */
  const locate = (i: number): { page: number; ordinal: number } | null => {
    if (!counts) return null;
    let k = i;
    for (const [idx, c] of counts.per.entries()) {
      if (k < c) return { page: idx + 1, ordinal: k };
      k -= c;
    }
    return null;
  };
  const at = total ? locate(Math.min(hit, total - 1)) : null;

  const step = (d: 1 | -1) => {
    if (!total) return;
    const next = (hit + d + total) % total;
    setHit(next);
    const where = locate(next);
    if (where) {
      goTo(where.page);
      setFocus({ what: 'find', token: Date.now() });
    }
  };

  const marksFor = (n: number): PageMarks => {
    const citeHere = cite.state === 'found' && cite.page === n ? cite.needle : null;
    const missing = cite.state === 'missing' && cite.page === n;
    const find = counts && counts.query === debounced ? debounced : '';
    if (!citeHere && !missing && !find) return NO_MARKS;
    return {
      cite: citeHere,
      citeMissing: missing,
      find,
      current: at && at.page === n ? at.ordinal : null,
      focus:
        focus && ((focus.what === 'cite' && citeHere) || (focus.what === 'find' && at?.page === n))
          ? focus
          : null,
    };
  };

  const register = useCallback((n: number, el: HTMLElement | null) => {
    if (el) pages.current.set(n, el);
    else pages.current.delete(n);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      goTo(current + (e.key === 'PageDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      goTo(e.key === 'Home' ? 1 : count);
    }
  };

  if (load.state === 'error')
    return (
      <div className="pdf pdf--problem" role="alert">
        <span className="pdf__problem-icon">
          <Icon name="alert" size={16} />
        </span>
        <p className="pdf__problem-title">{load.problem.title}</p>
        {load.problem.detail ? <p className="pdf__problem-detail mute">{load.problem.detail}</p> : null}
        <p className="pdf__problem-hint">{load.problem.hint}</p>
        <div className="pdf__problem-actions">
          <button type="button" className="btn btn--sm" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onShowText}>
            Show text
          </button>
        </div>
      </div>
    );

  const citeLine =
    cite.state === 'looking'
      ? `Finding the cited passage on page ${cite.page}`
      : cite.state === 'found'
        ? cite.partial
          ? `Cited on page ${cite.page}, the closest words are highlighted`
          : `Cited on page ${cite.page}`
        : cite.state === 'missing'
          ? `Cited on page ${cite.page}, passage not found in the page text`
          : '';

  return (
    <div className="pdf" data-ready={load.state === 'ready' || undefined}>
      <div className="pdf__bar" role="toolbar" aria-label="PDF controls">
        <div className="pdf__group">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Previous page"
            disabled={!doc || current <= 1}
            onClick={() => goTo(current - 1)}
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <label className="pdf__pageno" data-num>
            <span className="sr-only">Page number</span>
            <input
              inputMode="numeric"
              value={pageInput}
              disabled={!doc}
              aria-label="Page number"
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, '').slice(0, 5))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') goTo(Number(pageInput) || 1);
                if (e.key === 'Escape') setPageInput(String(current));
              }}
              onBlur={() => setPageInput(String(current))}
            />
            <span className="mute">of {count || '…'}</span>
          </label>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Next page"
            disabled={!doc || current >= count}
            onClick={() => goTo(current + 1)}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
        <div className="pdf__group">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Zoom out"
            disabled={!doc}
            onClick={() => setZoom(zoomStep(scale, -1))}
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            type="button"
            className="pdf__zoom"
            aria-label={zoom === 'fit' ? 'Fit to width, choose to reset to 100%' : 'Fit to width'}
            aria-pressed={zoom === 'fit'}
            disabled={!doc}
            onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')}
            data-num={zoom === 'fit' ? undefined : true}
          >
            {zoom === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Zoom in"
            disabled={!doc}
            onClick={() => setZoom(zoomStep(scale, 1))}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Find in this PDF"
            aria-pressed={findOpen}
            disabled={!doc}
            onClick={() => setFindOpen((o) => !o)}
          >
            <Icon name="search" size={14} />
          </button>
        </div>
      </div>

      {findOpen ? (
        <div className="viewer__find-bar pdf__find">
          <Icon name="search" size={13} />
          <input
            // biome-ignore lint/a11y/noAutofocus: the person just asked to find
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                setFindOpen(false);
                setQuery('');
              }
            }}
            placeholder="Find in this PDF"
            aria-label="Find in this PDF"
          />
          <span className="mute" data-num aria-live="polite">
            {debounced.length >= 2
              ? total
                ? `${Math.min(hit, total - 1) + 1} of ${total}${searching ? '+' : ''}`
                : searching
                  ? `Searching page ${counts?.done ?? 0} of ${count}`
                  : 'None'
              : ''}
          </span>
          <button
            type="button"
            className="icon-btn icon-btn--xs"
            aria-label="Previous match"
            disabled={!total}
            onClick={() => step(-1)}
          >
            <Icon name="arrowUp" size={12} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--xs"
            aria-label="Next match"
            disabled={!total}
            onClick={() => step(1)}
          >
            <Icon name="arrowDown" size={12} />
          </button>
        </div>
      ) : null}

      {citeLine ? (
        <p className="pdf__cite-line" data-state={cite.state} aria-live="polite">
          <Icon name={cite.state === 'missing' ? 'warn' : 'quote'} size={12} />
          {citeLine}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        role="region"
        className="pdf__scroll"
        data-scrollable
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the page column scrolls by keyboard (PgUp, PgDn, Home, End)
        tabIndex={0}
        aria-label="PDF pages"
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        {load.state === 'loading' || !base || !doc || !pdfjs ? (
          <div className="pdf__loading">
            <Skeleton
              lines={10}
              label={
                load.state === 'loading' && load.progress !== null
                  ? `Loading the PDF, ${Math.round(load.progress * 100)}%`
                  : 'Loading the PDF'
              }
            />
            <p className="mute pdf__loading-note" data-num>
              {load.state === 'loading' && load.progress !== null
                ? `Loading the PDF · ${Math.round(load.progress * 100)}%`
                : 'Loading the PDF'}
            </p>
          </div>
        ) : count === 0 ? (
          <p className="viewer__error">This PDF has no pages.</p>
        ) : (
          Array.from({ length: count }, (_, i) => i + 1).map((n) => (
            <PageView
              key={n}
              doc={doc}
              pdfjs={pdfjs}
              n={n}
              count={count}
              scale={scale}
              base={base}
              near={near.has(n)}
              text={text}
              marks={marksFor(n)}
              register={register}
            />
          ))
        )}
      </div>
    </div>
  );
}
