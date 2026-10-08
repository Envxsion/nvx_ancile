/**
 * ------------------------------------------------------------------
 *  Title    |  Primitives
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Kbd, Tip, Skeleton, EmptyState, StatusDot, HueChip:
 *           |  the small pieces every screen shares.
 *  Note     |  Tip reads the keymap, so a tooltip always shows the
 *           |  real shortcut for its action.
 * ------------------------------------------------------------------
 */

import * as Tooltip from '@radix-ui/react-tooltip';
import type { CSSProperties, ReactNode } from 'react';
import { noteClick } from '../keys/nudge';
import { bindingById, displayKeys } from '../keys/registry';
import { hueVar } from '../lib/format';
import type { Hue } from '../lib/types';
import { Icon, type IconName } from './Icon';

export function Kbd({ keys, binding }: { keys: string; binding?: string }) {
  return (
    <span className="kbd-group" aria-hidden="true" data-binding={binding}>
      {displayKeys(keys).map((chord, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: chords are positional
        <span key={i} className="kbd-chord">
          {chord.map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

/** Tooltip with the binding's real shortcut. */
export function Tip({
  label,
  binding,
  children,
  side = 'top',
}: {
  label: string;
  binding?: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const keys = binding ? bindingById(binding)?.keys : undefined;
  return (
    <Tooltip.Root delayDuration={350}>
      {/* Slot composes this after the control's own onClick. */}
      <Tooltip.Trigger asChild onClick={keys && binding ? () => noteClick(binding) : undefined}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" side={side} sideOffset={6}>
          <span>{label}</span>
          {keys ? <Kbd keys={keys} binding={binding} /> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Placeholder with the family's chalk wipe; never a spinner. */
export function Skeleton({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <span key={i} className="skeleton__line" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

/** One sentence and one action: what to do next. */
export function EmptyState({
  icon,
  title,
  body,
  action,
  secondary,
}: {
  icon: IconName;
  title: string;
  body: ReactNode;
  action?: { label: string; onClick: () => void; binding?: string };
  secondary?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__glyph">
        <Icon name={icon} size={20} />
      </span>
      <h2 className="empty__title">{title}</h2>
      <p className="empty__body">{body}</p>
      {action ? (
        <button type="button" className="btn btn--primary" onClick={action.onClick}>
          {action.label}
          {action.binding ? <Kbd keys={bindingById(action.binding)?.keys ?? ''} /> : null}
        </button>
      ) : null}
      {secondary}
    </div>
  );
}

export function StatusDot({
  status,
  label,
}: {
  status: 'ok' | 'degraded' | 'down' | 'restarting' | 'idle';
  label?: string;
}) {
  return label ? (
    <span className="dot" data-status={status} role="img" aria-label={label} />
  ) : (
    <span className="dot" data-status={status} aria-hidden="true" />
  );
}

export function HueChip({ hue, children }: { hue: Hue; children: ReactNode }) {
  return (
    <span className="hue-chip" style={{ '--hue': hueVar(hue) } as CSSProperties}>
      <span className="hue-chip__swatch" aria-hidden="true" />
      {children}
    </span>
  );
}

export function TierBadge({ tier }: { tier: 'auto' | 'gated' | 'critical' }) {
  const label = { auto: 'Auto', gated: 'Asks once', critical: 'Asks every time' }[tier];
  return (
    <span className="tier" data-tier={tier}>
      <Icon name={tier === 'critical' ? 'warn' : 'shield'} size={12} />
      {label}
    </span>
  );
}
