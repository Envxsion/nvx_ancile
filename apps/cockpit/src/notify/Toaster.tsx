/**
 * ------------------------------------------------------------------
 *  Title    |  Toaster
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Background events, said quietly in a corner, never in
 *           |  the way. Undo wherever the change can be taken back.
 *  How      |  Settings → Notifications set the corner, the stack
 *           |  height, how long each stays (errors at least 8 s, or
 *           |  until dismissed) and an optional soft chime. Timers
 *           |  pause while hovered or focused. Motion lays the stack
 *           |  out; reduced motion makes it a plain swap.
 * ------------------------------------------------------------------
 */

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { type Notice, useNotify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { Icon, type IconName } from '../ui/Icon';

const ICON: Record<Notice['level'], IconName> = {
  info: 'dot',
  success: 'check',
  warn: 'warn',
  error: 'alert',
};

let audio: AudioContext | null = null;

/** Two quiet sine notes, a fifth apart. Lower and shorter for errors. */
function chime(level: Notice['level']) {
  try {
    audio ??= new AudioContext();
    const at = audio.currentTime;
    const base = level === 'error' || level === 'warn' ? 440 : 660;
    for (const [i, f] of [base, base * 1.5].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, at + i * 0.09);
      gain.gain.linearRampToValueAtTime(0.05, at + i * 0.09 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + i * 0.09 + 0.32);
      osc.connect(gain).connect(audio.destination);
      osc.start(at + i * 0.09);
      osc.stop(at + i * 0.09 + 0.34);
    }
  } catch {
    /* no audio device, or blocked until a gesture: stay silent */
  }
}

function Toast({ t, exitX }: { t: Notice; exitX: number }) {
  const dismiss = useNotify((s) => s.dismiss);
  const duration = usePrefs((s) => s.prefs.notifications.durationMs);
  const sound = usePrefs((s) => s.prefs.notifications.sound);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(
    duration === null ? null : t.level === 'error' ? Math.max(8000, duration) : duration,
  );
  const started = useRef(Date.now());

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the toast appears
  useEffect(() => {
    if (sound) chime(t.level);
  }, []);

  useEffect(() => {
    if (paused || remaining.current === null) return;
    started.current = Date.now();
    const timer = setTimeout(() => dismiss(t.id), remaining.current);
    return () => {
      clearTimeout(timer);
      if (remaining.current !== null) remaining.current -= Date.now() - started.current;
    };
  }, [paused, dismiss, t.id]);

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: exitX, transition: { duration: 0.16 } }}
      transition={{ duration: 0.36, ease: [0.19, 1, 0.22, 1] }}
      className="toast"
      data-level={t.level}
      role={t.level === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast__icon">
        <Icon name={ICON[t.level]} size={14} />
      </span>
      <div className="toast__text">
        <p className="toast__title">{t.title}</p>
        {t.body ? <p className="toast__body">{t.body}</p> : null}
      </div>
      <div className="toast__actions">
        {t.undo ? (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              t.undo?.();
              dismiss(t.id);
            }}
          >
            Undo
          </button>
        ) : null}
        {t.action ? (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              t.action?.run();
              dismiss(t.id);
            }}
          >
            {t.action.label}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn icon-btn--xs"
          aria-label="Dismiss"
          onClick={() => dismiss(t.id)}
        >
          <Icon name="close" size={10} />
        </button>
      </div>
    </motion.li>
  );
}

export function Toaster() {
  const toasts = useNotify((s) => s.toasts);
  const position = usePrefs((s) => s.prefs.notifications.position);
  return (
    <ol className="toaster" data-position={position} aria-label="Notifications">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <Toast key={t.id} t={t} exitX={position === 'bottom-centre' ? 0 : 24} />
        ))}
      </AnimatePresence>
    </ol>
  );
}
