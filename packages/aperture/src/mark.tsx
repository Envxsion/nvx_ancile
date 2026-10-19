/**
 * ------------------------------------------------------------------
 *  Title    |  The Ancile mark, alive
 *  Ref      |  ancile.css (states), icons/*.svg (same geometry)
 *  ID       |  aperture
 * ------------------------------------------------------------------
 *  Purpose  |  One mark for every surface: the notched shield of the
 *           |  ancile, two open halves around a small broken ring.
 *  How      |  One <svg> per moving part (the two halves, the ring, the
 *           |  core), stacked in a span and animated in CSS. Each part
 *           |  is a box of its own, so its turn, breath or beat runs
 *           |  on the compositor: a transform on a path inside one SVG
 *           |  is redrawn on the main thread every frame, and froze
 *           |  whenever the app was busy (an answer streaming in).
 *           |  State is a data attribute, so the mark can tell you
 *           |  what the AI is doing from the corner of the eye.
 *  Note     |  Geometry is exported so icon generation and the app
 *           |  never drift: the mark in the titlebar is the logo.
 * ------------------------------------------------------------------
 */

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';

export type MarkState = 'idle' | 'thinking' | 'streaming' | 'ask' | 'offline' | 'alarm';

/** Shared geometry on a 34×34 grid. Stroke 2, round caps. */
export const MARK = {
  viewBox: '0 0 34 34',
  stroke: 2,
  left: 'M14.4 3.4 C8.6 3.6 4.8 6.8 4.8 10.8 C4.8 14 9.8 14.4 9.8 17 C9.8 19.6 4.8 20 4.8 23.2 C4.8 27.2 8.6 30.4 14.4 30.6',
  right:
    'M19.6 3.4 C25.4 3.6 29.2 6.8 29.2 10.8 C29.2 14 24.2 14.4 24.2 17 C24.2 19.6 29.2 20 29.2 23.2 C29.2 27.2 25.4 30.4 19.6 30.6',
  inner: 'M17 12.6 A4.4 4.4 0 1 1 13.2 19.2',
  core: { cx: 17, cy: 17, r: 1.5 },
  opacity: { left: 1, right: 0.7, inner: 0.4, core: 1 },
} as const;

export interface AncileMarkProps {
  size?: number;
  state?: MarkState;
  /** Override the tone, e.g. a model's identity hue. Defaults to signal. */
  tone?: string;
  /** Accessible name. Omit when the mark sits next to the wordmark. */
  label?: string;
  className?: string;
}

/** One moving part: the same 34×34 grid as the whole, laid over the others. */
function Part({ className, children }: { className: string; children: ReactNode }) {
  return (
    <svg
      className={`ancile-mark__part ${className}`}
      viewBox={MARK.viewBox}
      fill="none"
      strokeWidth={MARK.stroke}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function AncileMark({ size = 22, state = 'idle', tone, label, className }: AncileMarkProps) {
  const style = { width: size, height: size, ...(tone ? { '--mark-tone': tone } : {}) } as CSSProperties;
  // Entering or leaving a live state plays the arrival once; the first paint does not.
  const live = state === 'thinking' || state === 'streaming';
  const was = useRef(live);
  const [arrive, setArrive] = useState(false);
  useEffect(() => {
    if (was.current === live) return;
    was.current = live;
    setArrive(true);
    const t = setTimeout(() => setArrive(false), 560);
    return () => clearTimeout(t);
  }, [live]);
  return (
    <span
      data-arrive={arrive || undefined}
      className={['ancile-mark', className].filter(Boolean).join(' ')}
      data-state={state}
      style={style}
      // An image with a name, or hidden beside the wordmark.
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <Part className="half half-l">
        <path d={MARK.left} opacity={MARK.opacity.left} />
      </Part>
      <Part className="half half-r">
        <path d={MARK.right} opacity={MARK.opacity.right} />
      </Part>
      <Part className="inner">
        <path d={MARK.inner} opacity={MARK.opacity.inner} />
      </Part>
      <Part className="core">
        <circle {...MARK.core} />
      </Part>
    </span>
  );
}

/**
 * The wordmark lockup, family style: "NVX" set heavy, the product name in
 * the regular weight and a quieter tone. Never "nvx_ancile" in UI; that is
 * the repository name.
 */
export function AncileLockup({ size = 22, state = 'idle' }: { size?: number; state?: MarkState }) {
  return (
    <span className="ancile-lockup" role="img" aria-label="NVX Ancile">
      <AncileMark size={size} state={state} />
      <span className="ancile-lockup__word" aria-hidden="true">
        NVX <span>Ancile</span>
      </span>
    </span>
  );
}
