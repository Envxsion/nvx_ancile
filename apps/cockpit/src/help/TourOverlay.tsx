/**
 * ------------------------------------------------------------------
 *  Title    |  Tour overlay
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Light one real control, dim the rest, and say what it
 *           |  is for in two sentences, with the way out always one
 *           |  key away (Esc skips).
 *  How      |  The spotlight is a rounded box at the target's rect
 *           |  whose enormous shadow is the scrim, so the control
 *           |  stays fully live underneath and can be used in place.
 *           |  The rect is re-measured every frame while the tour
 *           |  runs; the card flips to whichever side has room.
 *           |  Before a step shows, the overlay goes to the screen
 *           |  the step needs (tourPlace.ts) and waits for its
 *           |  target; if the target never comes, the card says so
 *           |  in the middle of the screen rather than pointing at
 *           |  whatever happens to be open.
 * ------------------------------------------------------------------
 */

import { spring } from '@nvx/aperture';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { AnimatePresence, m as motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFlows } from '../flows/api';
import { useNotebooks, useThreads } from '../lib/data';
import { scrollBehavior } from '../lib/motion';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { useHelp } from './store';
import {
  listPending,
  NEED_LABEL,
  type PlaceLists,
  paramOf,
  pickFor,
  placeOf,
  routeMatches,
} from './tourPlace';
import { TOURS, type Tour, type TourStep } from './tours';

type Rect = { x: number; y: number; w: number; h: number };
const PAD = 6;
const CARD_W = 320;
/** How long a step waits for its target after arriving before it says it is missing. */
export const TARGET_WAIT_MS = 4_000;
const GENERAL_ABSENT = 'This part is not on this screen. Carry on, or come back to it later.';

function find(target: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
}

function placeCard(r: Rect | null, step: TourStep, cardH: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!r) return { left: (vw - CARD_W) / 2, top: vh / 2 - cardH / 2 };
  const gap = 14;
  const order = [step.placement ?? 'bottom', 'bottom', 'top', 'right', 'left'];
  for (const p of order) {
    let left = 0;
    let top = 0;
    if (p === 'bottom') {
      left = r.x + r.w / 2 - CARD_W / 2;
      top = r.y + r.h + PAD + gap;
    } else if (p === 'top') {
      left = r.x + r.w / 2 - CARD_W / 2;
      top = r.y - PAD - gap - cardH;
    } else if (p === 'right') {
      left = r.x + r.w + PAD + gap;
      top = r.y + r.h / 2 - cardH / 2;
    } else {
      left = r.x - PAD - gap - CARD_W;
      top = r.y + r.h / 2 - cardH / 2;
    }
    const fits = left >= 8 && top >= 8 && left + CARD_W <= vw - 8 && top + cardH <= vh - 8;
    if (fits) return { left, top };
  }
  return {
    left: Math.min(Math.max(8, r.x), vw - CARD_W - 8),
    top: Math.min(Math.max(8, r.y + r.h + gap), vh - cardH - 8),
  };
}

type Phase = { key: string; state: 'going' | 'shown' | 'missing'; why?: string };

export function TourOverlay() {
  const tour = useHelp((s) => s.tour);
  const def = tour ? TOURS[tour.id] : undefined;
  // The lists the tour picks from load only while a tour runs.
  return (
    <AnimatePresence>
      {def && tour ? <ActiveTour key={def.id} def={def} index={tour.step} /> : null}
    </AnimatePresence>
  );
}

function ActiveTour({ def, index }: { def: Tour; index: number }) {
  const stepTour = useHelp((s) => s.stepTour);
  const endTour = useHelp((s) => s.endTour);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const step = def.steps[index];
  const last = index === def.steps.length - 1;
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(160);
  const stepKey = `${def.id}:${index}`;
  const [phase, setPhase] = useState<Phase>({ key: stepKey, state: 'going' });
  const current: Phase = phase.key === stepKey ? phase : { key: stepKey, state: 'going' };

  const nb = useNotebooks();
  const th = useThreads();
  const fl = useFlows();
  const lists: PlaceLists = {
    notebooks: nb.data ?? (nb.isError ? [] : undefined),
    threads: th.data ?? (th.isError ? [] : undefined),
    flows: fl.data ?? (fl.isError ? [] : undefined),
  };
  const place = placeOf(def, index);
  const onPlace = !place || routeMatches(place.route, pathname);
  const need = place?.needs;
  const pending = !onPlace && !!need && listPending(need, lists);
  const pick = !onPlace && need && !pending ? pickFor(need, lists) : null;

  // 1. Go where the step happens. With nothing to open there, say so.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!place || onPlace || pending) return;
    if (need && !pick) {
      setPhase({
        key: stepKey,
        state: 'missing',
        why: step?.absent ?? `This step needs ${NEED_LABEL[need]}, and there is none yet.`,
      });
      return;
    }
    if (sent.current === stepKey) return;
    sent.current = stepKey;
    const param = paramOf(place.route);
    void navigate(
      param && pick
        ? ({ to: place.route, params: { [param]: pick } } as never)
        : ({ to: place.route } as never),
    );
  }, [place, onPlace, pending, need, pick, stepKey, step, navigate]);

  // 2. On the right screen: open the sidebar if the target lives there, then
  //    wait for the target to draw. Only then does the step show.
  useEffect(() => {
    if (!step || !onPlace) return;
    if (!step.target) {
      setPhase({ key: stepKey, state: 'shown' });
      return;
    }
    if (step.reveal === 'rail' && !useUi.getState().railOpen) useUi.getState().toggleRail();
    const target = step.target;
    const started = Date.now();
    let timer = 0;
    const look = () => {
      const el = find(target);
      if (el) {
        el.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() });
        setPhase({ key: stepKey, state: 'shown' });
      } else if (Date.now() - started > TARGET_WAIT_MS)
        setPhase({ key: stepKey, state: 'missing', why: step.absent ?? GENERAL_ABSENT });
      else timer = window.setTimeout(look, 100);
    };
    look();
    return () => window.clearTimeout(timer);
  }, [step, onPlace, stepKey]);

  // Follow the target every frame: layouts move (rails slide, panels open).
  useEffect(() => {
    if (!step?.target || current.state !== 'shown') {
      setRect(null);
      return;
    }
    const target = step.target;
    let raf = 0;
    const tick = () => {
      const el = find(target);
      if (el) {
        const b = el.getBoundingClientRect();
        setRect((r) =>
          r && r.x === b.x && r.y === b.y && r.w === b.width && r.h === b.height
            ? r
            : { x: b.x, y: b.y, w: b.width, h: b.height },
        );
      } else setRect(null);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step, current.state]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  });

  const finish = () => {
    endTour('done');
    notify({
      level: 'success',
      title: `${def?.title ?? 'Tour'}: done`,
      body: 'Find every tour again in the guide (G H).',
    });
  };
  const next = () => (last ? finish() : stepTour(1));

  // Doing the thing moves the tour on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-armed per step
  useEffect(() => {
    if (!step?.waitFor || current.state === 'going') return;
    const name = `ancile:tour:${step.waitFor}`;
    const on = () => setTimeout(next, 450);
    window.addEventListener(name, on);
    return () => window.removeEventListener(name, on);
  }, [step, current.state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        endTour('skipped');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [endTour]);

  const pos = step ? placeCard(current.state === 'shown' ? rect : null, step, cardH) : { left: 0, top: 0 };
  // Still on the way: nothing floats over the screen being left.
  if (!step || current.state === 'going') return null;

  return (
    <div className="tour" data-phase={current.state}>
      {rect ? (
        <motion.div
          className="tour__spot"
          aria-hidden="true"
          initial={false}
          animate={{
            left: rect.x - PAD,
            top: rect.y - PAD,
            width: rect.w + PAD * 2,
            height: rect.h + PAD * 2,
          }}
          transition={spring.smooth}
        />
      ) : (
        <div className="tour__scrim" aria-hidden="true" />
      )}
      <motion.div
        ref={cardRef}
        className="tour__card"
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1, left: pos.left, top: pos.top }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14 } }}
        transition={spring.smooth}
        key={stepKey}
      >
        <div className="tour__meta">
          <span className="tour__name">{def.title}</span>
          <span className="tour__dots" role="img" aria-label={`Step ${index + 1} of ${def.steps.length}`}>
            {def.steps.map((s, i) => (
              <i key={s.title} data-on={i <= index || undefined} />
            ))}
          </span>
        </div>
        <h2 id="tour-title" className="tour__title">
          {step.title}
        </h2>
        <p className="tour__body">{step.body}</p>
        {current.state === 'missing' ? (
          <p className="tour__missing" role="status">
            {current.why ?? GENERAL_ABSENT}
          </p>
        ) : null}
        <div className="tour__actions">
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => endTour('skipped')}>
            Skip tour
          </button>
          <span className="tour__spacer" />
          {index > 0 ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Previous step"
              onClick={() => stepTour(-1)}
            >
              <Icon name="chevronLeft" size={14} />
            </button>
          ) : null}
          <button type="button" className="btn btn--primary btn--sm" onClick={next}>
            {last ? 'Done' : step.waitFor ? 'Skip this step' : 'Next'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
