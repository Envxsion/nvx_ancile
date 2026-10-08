/**
 * ------------------------------------------------------------------
 *  Title    |  Add a node
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The fastest way onto the canvas: Tab (or a double
 *           |  click, or a drag from a port into empty space) opens a
 *           |  search where you type what you want. A model's name
 *           |  drops a Model node already set to it; a team block's
 *           |  name drops it as a subflow.
 *  How      |  cmdk, at the pointer. Dragged from a port, only kinds
 *           |  that accept input are offered, and the new node arrives
 *           |  connected to that port.
 * ------------------------------------------------------------------
 */

import type { FlowNodeKind, FlowSummary } from '@nvx/contracts';
import { Command } from 'cmdk';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { hueVar } from '../lib/format';
import { Icon } from '../ui/Icon';
import { FAMILIES, KINDS, PROVIDER_NAMES } from './kinds';
import type { FlowModel } from './models';
import { priceText, windowText } from './models';

export type Pick =
  | { type: 'kind'; kind: FlowNodeKind }
  | { type: 'model'; model: FlowModel }
  | { type: 'block'; flow: FlowSummary };

/**
 * Predictable ranking: a name that starts with what you typed, then a name
 * that contains it, then its other words. Loose fuzzy matches would put
 * "Manager" above "Template" for "template".
 */
export function rank(value: string, search: string): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const [name = '', rest = ''] = value.toLowerCase().split('|');
  if (name.startsWith(q)) return 1;
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 0.9;
  if (name.includes(q)) return 0.8;
  if (rest.split(/\s+/).some((w) => w.startsWith(q))) return 0.5;
  if (rest.includes(q)) return 0.3;
  return 0;
}

export function AddNode({
  screen,
  fromPort,
  models,
  blocks,
  hasInput,
  onPick,
  onClose,
}: {
  screen: { x: number; y: number };
  fromPort: boolean;
  models: FlowModel[];
  blocks: FlowSummary[];
  hasInput: boolean;
  onPick: (p: Pick) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [onClose]);

  const kinds = Object.values(KINDS).filter(
    (k) => (!fromPort || k.input) && !(k.kind === 'input' && hasInput) && !(fromPort && k.furniture),
  );
  const chatModels = models.filter((m) => m.chat);
  // Keep it on screen.
  const left = Math.min(screen.x, window.innerWidth - 380);
  const top = Math.min(screen.y, window.innerHeight - 440);

  return (
    <div
      ref={ref}
      className="fadd m-glass-thick"
      style={{ left, top } as CSSProperties}
      role="dialog"
      aria-label="Add a node"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <Command label="Add a node" loop filter={rank}>
        <div className="fadd__search">
          <Icon name="search" size={14} />
          <Command.Input
            autoFocus
            value={q}
            onValueChange={setQ}
            placeholder={fromPort ? 'Connect to… a node or a model' : 'Add a node, or type a model name'}
          />
          <kbd className="fadd__esc">Esc</kbd>
        </div>
        <Command.List className="fadd__list">
          <Command.Empty className="fadd__empty">
            Nothing matches. Try “router”, “judge” or a model name.
          </Command.Empty>
          {FAMILIES.map((fam) => {
            const ks = kinds.filter((k) => k.family === fam);
            if (!ks.length) return null;
            return (
              <Command.Group key={fam} heading={fam} className="fadd__group">
                {ks.map((k) => (
                  <Command.Item
                    key={k.kind}
                    value={`${k.name}|${k.kind} ${k.words ?? ''}`}
                    onSelect={() => onPick({ type: 'kind', kind: k.kind })}
                    className="fadd__item"
                  >
                    <span className="fadd__glyph" style={{ '--hue': hueVar(k.hue) } as CSSProperties}>
                      <Icon name={k.icon} size={13} />
                    </span>
                    <span className="fadd__text">
                      <span className="fadd__name">{k.name}</span>
                      <span className="fadd__blurb">{k.blurb}</span>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
          {/* Models only show once you type, so the list stays short. */}
          {q.trim().length >= 2 && chatModels.length ? (
            <Command.Group heading="Your models" className="fadd__group">
              {chatModels.map((m) => (
                <Command.Item
                  key={m.id}
                  value={`${m.name}|model ${m.id} ${m.provider} ${m.family} ${m.nodeName ?? ''}`}
                  onSelect={() => onPick({ type: 'model', model: m })}
                  className="fadd__item"
                >
                  <span className="fadd__glyph" style={{ '--hue': hueVar(m.hue) } as CSSProperties}>
                    <Icon name="model" size={13} />
                  </span>
                  <span className="fadd__text">
                    <span className="fadd__name">
                      {m.name}
                      {m.awake === false ? <span className="fadd__sleep">asleep</span> : null}
                      {m.status !== 'ready' ? <span className="fadd__unready">needs a key</span> : null}
                    </span>
                    <span className="fadd__blurb">
                      {PROVIDER_NAMES[m.provider] ?? m.provider} · {windowText(m.window)} context ·{' '}
                      {priceText(m)}
                    </span>
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
          {blocks.length ? (
            <Command.Group heading="Team blocks" className="fadd__group">
              {blocks.map((b) => (
                <Command.Item
                  key={b.id}
                  value={`${b.name.replace(/^Block:\s*/, '')}|block team ${b.description}`}
                  onSelect={() => onPick({ type: 'block', flow: b })}
                  className="fadd__item"
                >
                  <span className="fadd__glyph" style={{ '--hue': hueVar('magenta') } as CSSProperties}>
                    <Icon name="layout" size={13} />
                  </span>
                  <span className="fadd__text">
                    <span className="fadd__name">{b.name.replace(/^Block:\s*/, '')}</span>
                    <span className="fadd__blurb">
                      {b.nodes} nodes · {b.models.slice(0, 3).join(', ')}
                    </span>
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
      </Command>
    </div>
  );
}
