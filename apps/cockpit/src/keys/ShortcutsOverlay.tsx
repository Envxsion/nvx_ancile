/**
 * ------------------------------------------------------------------
 *  Title    |  Shortcuts overlay
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  `?` shows every key, grouped, straight from the keymap
 *           |  with your own changes applied. Nothing here is typed
 *           |  by hand, so it cannot go stale.
 *  How      |  effectiveBindings() re-read whenever the overrides in
 *           |  Settings → Keyboard change. Keys you rebound wear the
 *           |  gilt mark; single keys are struck through while they
 *           |  are turned off. Type to filter.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { Kbd } from '../ui/primitives';
import { useLayer } from './dispatch';
import { KeyTester } from './KeyTester';
import { effectiveBindings, type Group } from './registry';

const GROUPS: Group[] = ['Everywhere', 'Go to', 'View', 'Thread', 'Lists', 'Branch tree', 'Flow editor'];

const single = (keys: string) => !keys.includes('+') && !keys.includes(' ') && keys !== 'escape';

export function ShortcutsOverlay() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcuts);
  const overrides = usePrefs((s) => s.prefs.keyboard.overrides);
  const singleKeys = usePrefs((s) => s.prefs.keyboard.singleKeys);
  const [q, setQ] = useState('');
  useLayer(open);

  // biome-ignore lint/correctness/useExhaustiveDependencies: overrides is the signal that the keymap changed
  const bindings = useMemo(() => effectiveBindings(), [overrides]);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? bindings.filter((b) => `${b.label} ${b.keys} ${b.group}`.toLowerCase().includes(needle))
    : bindings;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ('');
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog shortcuts" aria-describedby="shortcuts-desc">
          <div className="shortcuts__head">
            <Dialog.Title className="dialog__title">Keyboard shortcuts</Dialog.Title>
            <input
              className="input input--sm shortcuts__filter"
              placeholder="Filter"
              aria-label="Filter shortcuts"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <p id="shortcuts-desc" className="dialog__lede">
            {singleKeys
              ? 'Single keys work whenever you are not typing. Press Esc to leave the composer, i to come back.'
              : 'Single-key shortcuts are off, so the struck-through keys do nothing. Turn them on in Settings.'}{' '}
            <Link
              to="/settings/$group"
              params={{ group: 'keyboard' }}
              className="link-btn"
              onClick={() => setOpen(false)}
            >
              Change keys
            </Link>
          </p>
          <KeyTester />
          <div className="shortcuts__grid" data-scrollable>
            {GROUPS.map((g) => {
              const rows = shown.filter((b) => b.group === g);
              if (rows.length === 0) return null;
              return (
                <section key={g} className="shortcuts__group">
                  <h3>{g}</h3>
                  <dl>
                    {rows.map((b) => (
                      <div
                        key={b.id}
                        className="shortcuts__row"
                        data-custom={overrides[b.id] ? true : undefined}
                        data-off={!singleKeys && single(b.keys) ? true : undefined}
                      >
                        <dt>
                          {b.label}
                          {overrides[b.id] ? (
                            <span className="shortcuts__mine" title="You set this key">
                              yours
                            </span>
                          ) : null}
                        </dt>
                        <dd>
                          <Kbd keys={b.keys} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              );
            })}
            {shown.length === 0 ? <p className="mute">No shortcut matches “{q.trim()}”.</p> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
