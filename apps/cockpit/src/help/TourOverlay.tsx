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
 * ------------------------------------------------------------------
 */

import { spring } from '@nvx/aperture';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { useHelp } from './store';
import { TOURS, type TourStep } from './tours';

type Rect = { x: number; y: number; w: number; h: number };
const PAD = 6;
const CARD_W = 320;

function find(target: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
}

function place(r: Rect | null, step: TourStep, cardH: number): { left: number; top: number } {
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

export function TourOverlay() {
  const tour = useHelp((s) => s.tour);
  const stepTour = useHelp((s) => s.stepTour);
  const endTour = useHelp((s) => s.endTour);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const def = tour ? TOURS[tour.id] : undefined;
  const step = def && tour ? def.steps[tour.step] : undefined;
  const last = !!def && !!tour && tour.step === def.steps.length - 1;
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(160);

  // Take the person where the step needs them.
  useEffect(() => {
    if (step?.route && pathname !== step.route) void navigate({ to: step.route });
  }, [step, pathname, navigate]);

  // Follow the target every frame: layouts move (rails slide, panels open).
  useEffect(() => {
    if (!step) return;
    let raf = 0;
    const tick = () => {
      const el = find(step.target);
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
    find(step.target)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return () => cancelAnimationFrame(raf);
  }, [step]);

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
    if (!step?.waitFor) return;
    const name = `ancile:tour:${step.waitFor}`;
    const on = () => setTimeout(next, 450);
    window.addEventListener(name, on);
    return () => window.removeEventListener(name, on);
  }, [step]);

  useEffect(() => {
    if (!tour) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        endTour('skipped');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tour, endTour]);

  const pos = step ? place(rect, step, cardH) : { left: 0, top: 0 };

  return (
    <AnimatePresence>
      {def && tour && step ? (
        <div className="tour" key={def.id}>
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
            key={`${def.id}-${tour.step}`}
          >
            <div className="tour__meta">
              <span className="tour__name">{def.title}</span>
              <span
                className="tour__dots"
                role="img"
                aria-label={`Step ${tour.step + 1} of ${def.steps.length}`}
              >
                {def.steps.map((s, i) => (
                  <i key={s.target + s.title} data-on={i <= tour.step || undefined} />
                ))}
              </span>
            </div>
            <h2 id="tour-title" className="tour__title">
              {step.title}
            </h2>
            <p className="tour__body">{step.body}</p>
            {!rect ? (
              <p className="tour__missing">
                This part is not on screen yet. Carry on, or come back to it later.
              </p>
            ) : null}
            <div className="tour__actions">
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => endTour('skipped')}>
                Skip tour
              </button>
              <span className="tour__spacer" />
              {tour.step > 0 ? (
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
      ) : null}
    </AnimatePresence>
  );
}
