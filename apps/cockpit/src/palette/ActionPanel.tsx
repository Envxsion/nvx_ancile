/**
 * ------------------------------------------------------------------
 *  Title    |  The palette's action panel
 *  Ref      |  ROADMAP KP1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The actions on one palette result, in a list of their
 *           |  own. Tab or Ctrl+Enter opens it on the highlighted
 *           |  result; Enter chooses; Escape goes back to the
 *           |  results.
 *  How      |  A second cmdk list over PanelActions (actions.ts). A
 *           |  choice with a preview applies it as the highlight
 *           |  moves and puts the old value back if you leave without
 *           |  choosing. Starts on the current choice, so opening the
 *           |  panel changes nothing. A polite status line says what
 *           |  the panel is and how many actions it has.
 *  Note     |  Choosing runs the action and closes the palette,
 *           |  unless the action keeps it open (a setting does, so
 *           |  you can try another).
 * ------------------------------------------------------------------
 */

import { Command } from 'cmdk';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { Kbd } from '../ui/primitives';
import type { PanelAction } from './actions';

const PREFIX = 'act:';

export function ActionPanel({
  title,
  actions,
  onBack,
  onChosen,
}: {
  title: string;
  actions: PanelAction[];
  /** Back to the results, with the palette still open. */
  onBack: () => void;
  /** An action ran. `keepOpen` actions leave the palette open. */
  onChosen: (a: PanelAction) => void;
}) {
  const start = actions.find((a) => a.current)?.id ?? actions[0]?.id ?? '';
  const [sel, setSel] = useState(`${PREFIX}${start}`);
  // The choice that was in force when the panel opened (or was last chosen): what leaving restores.
  const origin = useRef(actions.find((a) => a.current)?.id ?? null);
  // Something other than that is showing as a preview.
  const previewing = useRef(false);
  // The latest actions, so the cleanup restores through a fresh closure.
  const latest = useRef(actions);
  latest.current = actions;

  const restore = () => {
    if (!previewing.current || origin.current === null) return;
    previewing.current = false;
    latest.current.find((a) => a.id === origin.current)?.preview?.apply();
  };

  // Leaving the panel without choosing (back, or the palette closing) puts the old choice back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on unmount, through refs
  useEffect(() => restore, []);

  const highlight = (v: string) => {
    setSel(v);
    const a = actions.find((x) => `${PREFIX}${x.id}` === v);
    if (!a?.preview) return;
    if (a.id === origin.current) {
      restore();
      return;
    }
    a.preview.apply();
    previewing.current = true;
  };

  const choose = (a: PanelAction) => {
    void a.run();
    // What was chosen is the new "old" value; nothing is left to restore.
    previewing.current = false;
    if (a.preview) origin.current = a.id;
    onChosen(a);
  };

  return (
    <Command label={`Actions for ${title}`} loop value={sel} onValueChange={highlight} shouldFilter>
      <div className="palette__input">
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Back to results" onClick={onBack}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="palette__scope" title={title}>
          {title}
        </span>
        <Command.Input
          placeholder="Filter actions"
          aria-label={`Filter the actions for ${title}`}
          autoFocus
        />
      </div>
      <p className="sr-only" role="status">
        {`Actions for ${title}. ${actions.length} ${actions.length === 1 ? 'action' : 'actions'}. Use the up and down arrows, Enter to choose, Escape to go back.`}
      </p>
      <Command.List className="palette__list">
        <Command.Empty className="palette__empty">No action matches.</Command.Empty>
        {actions.map((a) => (
          <Command.Item
            key={a.id}
            value={`${PREFIX}${a.id}`}
            keywords={[a.label]}
            data-danger={a.danger || undefined}
            onSelect={() => choose(a)}
          >
            <Icon name={a.icon} size={15} />
            <span className="palette__label">{a.label}</span>
            {a.hint ? <span className="mute palette__meta">{a.hint}</span> : null}
            {a.current ? <span className="palette__current">Current</span> : null}
          </Command.Item>
        ))}
      </Command.List>
      <footer className="palette__foot">
        <span>
          <Kbd keys="enter" /> choose
        </span>
        <span>
          <Kbd keys="escape" /> back
        </span>
      </footer>
    </Command>
  );
}
