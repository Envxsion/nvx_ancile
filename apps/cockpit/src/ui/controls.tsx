/**
 * ------------------------------------------------------------------
 *  Title    |  Controls
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Switch, Segmented, Range, Check and Ticker: the small
 *           |  controls Settings and every panel share, each with the
 *           |  feel of a physical thing (a thumb that travels and
 *           |  squashes, a plate that slides, digits that roll).
 *  How      |  Plain buttons with ARIA roles, styled in base.css. The
 *           |  segmented plate and the ticker move on Motion springs;
 *           |  reduced motion makes both jump.
 * ------------------------------------------------------------------
 */

import { spring } from '@nvx/aperture';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef } from 'react';
import { Icon } from './Icon';

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      className="check"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      </svg>
    </button>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
  icon?: Parameters<typeof Icon>[0]['name'];
}

/** A radio group drawn as one well with a plate that slides to the choice. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size,
}: {
  value: T;
  options: SegOption<T>[];
  onChange: (next: T) => void;
  label: string;
  size?: 'sm';
}) {
  const group = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + options.length) % options.length;
    const opt = options[next];
    if (opt) {
      onChange(opt.value);
      refs.current[next]?.focus();
    }
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label} data-size={size}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="segmented__opt"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {on ? (
              <motion.span
                className="segmented__plate"
                layoutId={`seg-${group}`}
                transition={spring.snappy}
              />
            ) : null}
            <span className="segmented__label">
              {o.icon ? <Icon name={o.icon} size={13} /> : null}
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Range({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format = (v) => String(v),
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  label: string;
  format?: (v: number) => string;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <span className="range-field">
      <input
        type="range"
        className="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={format(value)}
        style={{ '--fill': fill } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output className="range-field__value" data-num>
        {format(value)}
      </output>
    </span>
  );
}

/**
 * A number that rolls to its new value instead of jumping: costs, counts,
 * percentages in the status bar. Tabular figures keep it from wobbling.
 */
export function Ticker({
  value,
  format = (v) => Math.round(v).toLocaleString('en-GB'),
  className,
}: {
  value: number;
  format?: (v: number) => string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => format(v));
  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    const c = animate(mv, value, spring.ticker);
    return () => c.stop();
  }, [value, reduce, mv]);
  return (
    <motion.span className={className} data-num aria-label={format(value)}>
      {text}
    </motion.span>
  );
}
