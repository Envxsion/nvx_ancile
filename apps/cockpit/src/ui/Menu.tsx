/**
 * ------------------------------------------------------------------
 *  Title    |  Menus
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One menu vocabulary for the "more" buttons and for
 *           |  right-click: the same items, icons, shortcuts and
 *           |  danger styling, opened from where you clicked.
 *  How      |  Radix DropdownMenu and ContextMenu over one item list.
 *           |  Menus scale in from their trigger in 140 ms and never
 *           |  travel: they are used too often to perform.
 * ------------------------------------------------------------------
 */

import * as CM from '@radix-ui/react-context-menu';
import * as DM from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Kbd } from './primitives';

export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      icon?: IconName;
      keys?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator' }
  | { kind: 'label'; label: string }
  | { kind: 'sub'; label: string; icon?: IconName; items: MenuEntry[] };

type Kit = typeof DM | typeof CM;

function Entries({ kit, items }: { kit: Kit; items: MenuEntry[] }) {
  const K = kit as typeof DM;
  return (
    <>
      {items.map((e, i) => {
        const key = `${e.kind ?? 'item'}-${'label' in e ? e.label : i}`;
        // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity but their place
        if (e.kind === 'separator') return <K.Separator key={`sep-${i}`} className="menu__sep" />;
        if (e.kind === 'label')
          return (
            <K.Label key={key} className="menu__label">
              {e.label}
            </K.Label>
          );
        if (e.kind === 'sub')
          return (
            <K.Sub key={key}>
              <K.SubTrigger className="menu__item">
                {e.icon ? <Icon name={e.icon} size={14} /> : <span className="menu__noicon" />}
                <span className="menu__text">{e.label}</span>
                <Icon name="chevronRight" size={12} className="menu__chev" />
              </K.SubTrigger>
              <K.Portal>
                <K.SubContent className="menu" sideOffset={4} alignOffset={-5}>
                  <Entries kit={kit} items={e.items} />
                </K.SubContent>
              </K.Portal>
            </K.Sub>
          );
        return (
          <K.Item
            key={key}
            className="menu__item"
            data-danger={e.danger || undefined}
            disabled={e.disabled}
            onSelect={e.onSelect}
          >
            {e.icon ? <Icon name={e.icon} size={14} /> : <span className="menu__noicon" />}
            <span className="menu__text">{e.label}</span>
            {e.keys ? <Kbd keys={e.keys} /> : null}
          </K.Item>
        );
      })}
    </>
  );
}

/** A "more" button's menu. */
export function DropMenu({
  trigger,
  items,
  align = 'end',
  side = 'bottom',
}: {
  trigger: ReactNode;
  items: MenuEntry[];
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content className="menu" align={align} side={side} sideOffset={6} collisionPadding={8}>
          <Entries kit={DM} items={items} />
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/** Right-click (or the context key) on anything. */
export function ContextMenu({ children, items }: { children: ReactNode; items: MenuEntry[] }) {
  return (
    <CM.Root modal={false}>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className="menu" collisionPadding={8}>
          <Entries kit={CM} items={items} />
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
