/**
 * ------------------------------------------------------------------
 *  Title    |  Notebook picker
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Choose a notebook, or the "none" choice the caller
 *           |  names (Home: "No notebook"; importing Claude Code
 *           |  sessions: "The folder's notebook").
 *  How      |  A DropMenu over the notebooks that are not archived,
 *           |  first thirty. The trigger takes the notebook's hue.
 * ------------------------------------------------------------------
 */

import type { CSSProperties } from 'react';
import { hueVar } from '../lib/format';
import type { Hue, NotebookView } from '../lib/types';
import { Icon } from './Icon';
import { DropMenu, type MenuEntry } from './Menu';

export function NotebookPick({
  notebooks,
  value,
  onChange,
  noneLabel = 'No notebook',
  heading = 'Answer from',
  side = 'top',
  noneIcon = 'thread',
}: {
  notebooks: NotebookView[];
  value: string | null;
  onChange: (id: string | null) => void;
  noneLabel?: string;
  heading?: string;
  side?: 'top' | 'bottom';
  noneIcon?: 'thread' | 'folder';
}) {
  const current = notebooks.find((n) => n.id === value) ?? null;
  const items: MenuEntry[] = [
    { kind: 'label', label: heading },
    { label: noneLabel, icon: noneIcon, onSelect: () => onChange(null) },
    ...(notebooks.length ? [{ kind: 'separator' as const }] : []),
    ...notebooks
      .filter((n) => !n.archived)
      .slice(0, 30)
      .map((n) => ({ label: n.title, icon: 'notebook' as const, onSelect: () => onChange(n.id) })),
  ];
  return (
    <DropMenu
      align="start"
      side={side}
      items={items}
      trigger={
        <button
          type="button"
          className="scope-pick"
          data-set={current ? true : undefined}
          style={current?.color ? ({ '--hue': hueVar(current.color as Hue) } as CSSProperties) : undefined}
          aria-label={current ? `Notebook: ${current.title}. Change` : 'Choose a notebook'}
        >
          {current ? (
            <span className="scope-pick__dot" aria-hidden="true" />
          ) : (
            <Icon name={noneIcon === 'folder' ? 'folder' : 'notebook'} size={13} />
          )}
          <span className="scope-pick__label">{current ? current.title : noneLabel}</span>
          <Icon name="chevronDown" size={11} />
        </button>
      }
    />
  );
}
