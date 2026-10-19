/**
 * ------------------------------------------------------------------
 *  Title    |  The fact-check card
 *  Ref      |  roadmap FC3, FC4 · guard rail GR24 · DESIGN.md §10
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A calm card beside a highlighted claim: a one-line
 *           |  verdict, the corrected claim, three to five evidence
 *           |  lines with their sources, one line on what would change,
 *           |  and what the check cost.
 *  How      |  Opened by the bar, the F key or the context menu. It asks
 *           |  Core once (a click is the only thing that costs money),
 *           |  shows a quiet "Checking" state, then the result. It keeps
 *           |  the words marked while you read it (the CSS highlight
 *           |  API where the browser has it), follows them as the page
 *           |  scrolls, and sits at the foot of the screen on a phone.
 *           |  Copy, Open in Evidence and Use the corrected claim are
 *           |  buttons; the last one writes a follow-up in the message
 *           |  box and never sends it. Escape closes it and puts focus
 *           |  back where it was. When no model of another family can
 *           |  check (GR24), it says so and nothing runs.
 *  Note     |  Loads on first use (Message.tsx lazyHost).
 * ------------------------------------------------------------------
 */

import type { ApiError, StartSelectionCheckResponse } from '@nvx/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiCallError } from '../lib/api';
import { runSelectionCheck } from '../lib/factcheck';
import { copyText, costLine, followUpDraft, insertIntoComposer } from '../lib/selectionWords';
import { notify } from '../state/notify';
import { type OpenCard, useSelectionCheck } from '../state/selectionCheck';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { SelectionBody } from './SelectionBody';

type State =
  | { status: 'running' }
  | { status: 'done'; res: StartSelectionCheckResponse }
  | { status: 'error'; error: ApiError['error'] };

/** One ask per opening, however often the effect runs (React's strict mode runs it twice). */
const asks = new Map<number, Promise<StartSelectionCheckResponse>>();

function ask(open: OpenCard): Promise<StartSelectionCheckResponse> {
  const known = asks.get(open.nonce);
  if (known) return known;
  const p = runSelectionCheck(open.messageId, {
    text: open.text,
    ...(open.kind && { kind: open.kind }),
    ...(open.web && { web: true }),
    ...(open.again && { again: true }),
  });
  asks.set(open.nonce, p);
  void p.catch(() => undefined).finally(() => setTimeout(() => asks.delete(open.nonce), 5_000));
  return p;
}

/** Keep the highlighted words marked while the card is read; a no-op where the browser has no such thing. */
function useAnchorMark(range: Range | null) {
  useEffect(() => {
    const reg = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
    const Mark = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!reg || !Mark || !range) return;
    reg.set('fc-anchor', new Mark(range));
    return () => void reg.delete('fc-anchor');
  }, [range]);
}

const GAP = 10;
const WIDTH = 420;

export function placeCard(
  box: { left: number; top: number; right: number; bottom: number },
  size: { w: number; h: number },
  view: { w: number; h: number },
): { left: number; top: number } {
  const left = Math.max(GAP, Math.min(box.left, view.w - size.w - GAP));
  const below = box.bottom + GAP;
  const fitsBelow = below + size.h <= view.h - GAP;
  const above = box.top - GAP - size.h;
  return { left, top: fitsBelow ? below : above >= GAP ? above : Math.max(GAP, view.h - size.h - GAP) };
}

function toModels() {
  void import('../router').then(({ router }) =>
    router.navigate({ to: '/admin/$section', params: { section: 'models' } }),
  );
}

const NEEDS_MODELS = new Set([
  'factcheck.no_other_family',
  'factcheck.no_model',
  'factcheck.judge_not_allowed',
  'model.chain_exhausted',
]);

function Card({ open }: { open: OpenCard }) {
  const [state, setState] = useState<State>({ status: 'running' });
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const showEvidence = useUi((s) => s.showEvidence);
  const close = useSelectionCheck((s) => s.closeCard);
  useAnchorMark(open.range);

  // Ask once for this opening.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one ask per opening (nonce)
  useEffect(() => {
    let live = true;
    ask(open)
      .then((res) => live && setState({ status: 'done', res }))
      .catch((err: unknown) => {
        if (!live) return;
        const error =
          err instanceof ApiCallError
            ? err.body.error
            : {
                code: 'request.failed',
                title: 'The check could not be made',
                hint: 'Check that Core is running, then try again.',
              };
        setState({ status: 'error', error: error as ApiError['error'] });
      });
    return () => {
      live = false;
    };
  }, [open.nonce]);

  // Anchored to the highlight: placed once measured, and again when the page moves or the card grows.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const put = () => {
      const r = open.range?.getBoundingClientRect();
      const box = r && (r.width || r.height) ? r : open.box;
      const s = el.getBoundingClientRect();
      setPos(placeCard(box, { w: s.width, h: s.height }, { w: window.innerWidth, h: window.innerHeight }));
    };
    put();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(put);
    ro?.observe(el);
    window.addEventListener('scroll', put, { capture: true, passive: true });
    window.addEventListener('resize', put);
    return () => {
      ro?.disconnect();
      window.removeEventListener('scroll', put, { capture: true });
      window.removeEventListener('resize', put);
    };
  }, [open.range, open.box]);

  // Focus moves into the card and comes back to the page when it closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [close]);

  const check = state.status === 'done' ? state.res.check : null;
  const again = (opts: { web?: boolean; again?: boolean }) =>
    useSelectionCheck.getState().openCard(open, opts);

  const copy = async () => {
    if (!check) return;
    try {
      await navigator.clipboard.writeText(copyText(check));
      notify({ level: 'success', title: 'Copied' });
    } catch {
      notify({ level: 'warn', title: 'Clipboard is blocked', body: 'Select the text and copy it by hand.' });
    }
  };
  const useCorrected = () => {
    if (!check?.corrected) return;
    insertIntoComposer(open.threadId, followUpDraft(check.corrected));
    notify({
      level: 'info',
      title: 'Added to your message box',
      body: 'Nothing was sent. Edit it, then send when you are ready.',
    });
    close();
  };

  return createPortal(
    <div
      ref={card}
      className="selcard"
      role="dialog"
      aria-modal="false"
      aria-label="Fact-check"
      tabIndex={-1}
      data-state={state.status}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: `min(${WIDTH}px, calc(100vw - ${GAP * 2}px))`,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <button
        type="button"
        className="icon-btn icon-btn--xs selcard__close"
        aria-label="Close"
        onClick={close}
      >
        <Icon name="close" size={12} />
      </button>

      {state.status === 'running' ? (
        <div className="selcard__wait" role="status">
          <span className="selcard__pulse" aria-hidden="true" />
          <p className="selcard__title">Checking this claim</p>
          <blockquote className="selbody__claim">{open.text}</blockquote>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="selcard__error" role="alert">
          <Icon name="warn" size={14} />
          <div>
            <p className="selcard__title">{state.error.title}</p>
            <p className="selcard__hint">{state.error.hint}</p>
            <div className="selcard__actions">
              {NEEDS_MODELS.has(state.error.code) ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    close();
                    toModels();
                  }}
                >
                  Open Models
                </button>
              ) : (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => again({})}>
                  Try again
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {check && state.status === 'done' ? (
        <>
          <SelectionBody c={check} />
          {state.res.cached ? (
            <p className="selbody__note">
              <Icon name="clock" size={12} />
              You checked this before.{' '}
              <button type="button" className="link-btn" onClick={() => again({ again: true })}>
                Check again
              </button>
            </p>
          ) : null}
          {!check.web.used && !check.web.note ? (
            <p className="selbody__note">
              <Icon name="globe" size={12} />
              Checked against your sources only.{' '}
              <button type="button" className="link-btn" onClick={() => again({ web: true, again: true })}>
                Check again with the web
              </button>
            </p>
          ) : null}
          <footer className="selcard__foot">
            <span className="selcard__cost" data-num>
              {costLine(check)}
            </span>
            <span className="selcard__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy()}>
                <Icon name="copy" size={12} />
                Copy
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  showEvidence(open.messageId, check.id);
                  close();
                }}
              >
                Open in Evidence
              </button>
              {check.corrected ? (
                <button type="button" className="btn btn--primary btn--sm" onClick={useCorrected}>
                  Use the corrected claim
                </button>
              ) : null}
            </span>
          </footer>
        </>
      ) : null}
    </div>,
    document.body,
  );
}

/** The one open card, if it belongs to this message. */
export function FactcheckCard({ messageId }: { messageId: string }) {
  const open = useSelectionCheck((s) => (s.card?.messageId === messageId ? s.card : null));
  return open ? <Card key={open.nonce} open={open} /> : null;
}
