/**
 * ------------------------------------------------------------------
 *  Title    |  Meters
 *  Ref      |  DESIGN.md §8.4, §13.1 · docs/claude-code.md (Usage)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One meter for everything that fills up: a thread's
 *           |  context (Ancile's estimate or Claude Code's own count)
 *           |  and a Claude plan's limits.
 *  How      |  A thin track, its fill scaled with a transform, and a
 *           |  tick where compaction happens. Neutral, then --warn
 *           |  near the line, then --fail at it. ContextGauge is the
 *           |  status bar's and the Claude Code line's: "62%" with a
 *           |  tooltip "62% of context: compacts at 95%".
 *  Note     |  Never violet (that is for live state) and never gold
 *           |  (gold means kept, not a warning).
 * ------------------------------------------------------------------
 */

import { type MeterTone, toneOf } from './api';
import '../styles/usage.css';

export function Meter({
  percent,
  tone,
  mark,
  size = 'small',
  label,
}: {
  percent: number | null;
  tone?: MeterTone;
  /** A tick, as a percent: where compaction happens. */
  mark?: number | null;
  size?: 'small' | 'large';
  label: string;
}) {
  const p = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  // A meter with no value is not a meter: say it is not reported, and leave the empty track decorative.
  if (percent === null)
    return (
      <span className="u-meter" data-size={size} data-tone={tone ?? toneOf(percent)}>
        <span className="sr-only">{label}: not reported</span>
        <span className="u-meter__fill" aria-hidden="true" style={{ transform: 'scaleX(0)' }} />
      </span>
    );
  return (
    <span
      className="u-meter"
      data-size={size}
      data-tone={tone ?? toneOf(percent)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
    >
      <span className="u-meter__fill" style={{ transform: `scaleX(${p / 100})` }} />
      {mark ? <span className="u-meter__mark" style={{ left: `${Math.min(100, mark)}%` }} /> : null}
    </span>
  );
}

/** How a context's fill reads: the tone steps sit just under and at the compaction line. */
export function contextTone(percent: number, compactsAt: number | null): MeterTone {
  const line = compactsAt ?? 95;
  return percent >= line - 0.5 ? 'over' : percent >= Math.min(80, line - 10) ? 'high' : 'calm';
}

export function contextWords(percent: number, compactsAt: number | null): string {
  const used = `${Math.round(percent)}% of context`;
  return compactsAt ? `${used}: compacts at ${Math.round(compactsAt)}%` : used;
}

/** The context meter, the same for a normal thread and a Claude Code one. */
export function ContextGauge({ percent, compactsAt }: { percent: number; compactsAt: number | null }) {
  return (
    <span className="u-gauge">
      <Meter
        percent={percent}
        tone={contextTone(percent, compactsAt)}
        mark={compactsAt}
        label={contextWords(percent, compactsAt)}
      />
      <span className="u-gauge__num" data-num>
        {Math.round(percent)}%
      </span>
    </span>
  );
}
