/**
 * ------------------------------------------------------------------
 *  Title    |  Key tester
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Press a key and see what NVX Ancile heard and what the
 *           |  key does here. When a shortcut seems dead, this tells
 *           |  you whether the app ever received it.
 *  How      |  While testing, listens on window in the capture phase
 *           |  and swallows every key, so nothing fires and the
 *           |  dialog stays open. Esc stops the test.
 *  Note     |  A key that shows nothing never reached the page: the
 *           |  browser or an extension kept it. The desktop app
 *           |  receives every key.
 * ------------------------------------------------------------------
 */

import { useEffect, useState } from 'react';
import { isDesktop } from '../lib/runtime';
import { track } from '../lib/telemetry';
import { usePrefs } from '../state/prefs';
import { Kbd } from '../ui/primitives';
import { chordOf, isSingleKey } from './dispatch';
import { effectiveBindings, isMac, normalise } from './registry';

interface Heard {
  chord: string;
  uses: { id: string; label: string; group: string; keys: string }[];
}

export function KeyTester() {
  const [on, setOn] = useState(false);
  const [heard, setHeard] = useState<Heard | null>(null);
  const singleKeys = usePrefs((s) => s.prefs.keyboard.singleKeys);

  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const chord = chordOf(e);
      if (chord === 'escape') {
        setOn(false);
        return;
      }
      const uses = effectiveBindings()
        .filter((b) => {
          const k = normalise(b.keys);
          return k === chord || k.startsWith(`${chord} `);
        })
        .map((b) => ({ id: b.id, label: b.label, group: b.group, keys: b.keys }));
      setHeard({ chord, uses });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [on]);

  return (
    <div className="keytest" data-on={on || undefined}>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-pressed={on}
        onClick={() => {
          setHeard(null);
          if (!on) track('key_test');
          setOn((v) => !v);
        }}
      >
        {on ? 'Stop testing' : 'Test a key'}
      </button>
      <div className="keytest__out" aria-live="polite">
        {!on && !heard ? (
          <span className="mute">Not sure a shortcut works? Test it here.</span>
        ) : on && !heard ? (
          <span>Press any key or shortcut. Esc stops.</span>
        ) : heard ? (
          <>
            <Kbd keys={heard.chord} />
            {heard.uses.length === 0 ? (
              <span className="mute">Nothing in NVX Ancile uses this key.</span>
            ) : (
              <span>
                {heard.uses
                  .map((u) =>
                    normalise(u.keys) === heard.chord ? `${u.label} (${u.group})` : `${u.keys}: ${u.label}`,
                  )
                  .join('; ')}
                {!singleKeys && isSingleKey(heard.chord) ? (
                  <span className="mute"> Single keys are off in Settings.</span>
                ) : null}
              </span>
            )}
          </>
        ) : null}
      </div>
      {on && !isDesktop() ? (
        <p className="keytest__note mute">
          If a key shows nothing here, it never reached the page: your browser or an extension kept it.
          Browsers always keep {isMac ? '⌘N, ⌘T and ⌘W' : 'Ctrl+N, Ctrl+T and Ctrl+W'}.
        </p>
      ) : null}
    </div>
  );
}
