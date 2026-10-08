/**
 * ------------------------------------------------------------------
 *  Title    |  Keyboard settings
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every shortcut, changeable. Press Change, press the new
 *           |  key (or two keys in a row for a sequence), and see at
 *           |  once if something else already uses it.
 *  How      |  Recording listens in the capture phase so nothing else
 *           |  reacts while you choose. Overrides live in preferences
 *           |  and reach the dispatcher through setOverrides().
 * ------------------------------------------------------------------
 */

import { useContext, useEffect, useRef, useState } from 'react';
import { chordOf } from '../../keys/dispatch';
import { BINDINGS, type BindingDef, findConflicts, type Group, normalise } from '../../keys/registry';
import { usePrefs } from '../../state/prefs';
import { Range, Switch } from '../../ui/controls';
import { Kbd } from '../../ui/primitives';
import { Block, matches, Row, SearchContext, useSet } from './rows';

const GROUPS: Group[] = ['Everywhere', 'Go to', 'View', 'Thread', 'Lists', 'Branch tree', 'Flow editor'];

function Recorder({ onKeys, onCancel }: { onKeys: (keys: string) => void; onCancel: () => void }) {
  const [first, setFirst] = useState<string | null>(null);
  // The callbacks are new on every render of the row; read them through refs
  // so the listener (and the timer below) is not torn down when they change.
  const done = useRef(onKeys);
  const cancel = useRef(onCancel);
  done.current = onKeys;
  cancel.current = onCancel;

  // A single key with no modifier may start a sequence: wait a moment for a
  // second one, then take the single key. The timer lives in its own effect:
  // it used to be cleared by the re-render that showed "then…", so a single
  // key (F9, a letter) could never be recorded.
  useEffect(() => {
    if (!first) return;
    const timer = setTimeout(() => done.current(first), 700);
    return () => clearTimeout(timer);
  }, [first]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const chord = chordOf(e);
      if (chord === 'escape' && !first) return cancel.current();
      if (first) return done.current(`${first} ${chord}`);
      if (!chord.includes('+')) setFirst(chord);
      else done.current(chord);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [first]);
  return (
    <span className="key-rec" aria-live="polite">
      {first ? (
        <>
          <Kbd keys={first} /> then…
        </>
      ) : (
        'Press the new key'
      )}
    </span>
  );
}

function BindingRow({ b }: { b: BindingDef }) {
  const overrides = usePrefs((s) => s.prefs.keyboard.overrides);
  const set = useSet('keyboard');
  const [recording, setRecording] = useState(false);
  const [candidate, setCandidate] = useState<string | null>(null);
  const current = overrides[b.id] ?? b.keys;
  const changed = !!overrides[b.id] && normalise(overrides[b.id] ?? '') !== normalise(b.keys);

  const conflicts = candidate
    ? findConflicts(
        BINDINGS.map((x) =>
          x.id === b.id
            ? { ...x, keys: candidate }
            : overrides[x.id]
              ? { ...x, keys: overrides[x.id] as string }
              : x,
        ),
      ).filter((c) => c.a === b.id || c.b === b.id)
    : [];
  const clash = conflicts[0]
    ? BINDINGS.find((x) => x.id === (conflicts[0]?.a === b.id ? conflicts[0]?.b : conflicts[0]?.a))
    : undefined;

  const save = (keys: string) => {
    const next = { ...overrides };
    if (normalise(keys) === normalise(b.keys)) delete next[b.id];
    else next[b.id] = keys;
    set({ overrides: next });
    setCandidate(null);
  };

  return (
    <div className="keyrow" data-changed={changed || undefined}>
      <span className="keyrow__label">
        {b.label}
        {changed ? <span className="setting__dot" title="Changed from the default" /> : null}
      </span>
      <span className="keyrow__keys">
        {recording ? (
          <Recorder
            onCancel={() => setRecording(false)}
            onKeys={(k) => {
              setRecording(false);
              setCandidate(k);
            }}
          />
        ) : candidate ? (
          <>
            <Kbd keys={candidate} />
            {clash ? <span className="keyrow__clash">Also {clash.label.toLowerCase()}</span> : null}
            <button type="button" className="btn btn--primary btn--sm" onClick={() => save(candidate)}>
              {clash ? 'Use anyway' : 'Save'}
            </button>
            <button type="button" className="link-btn link-btn--quiet" onClick={() => setCandidate(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <Kbd keys={current} binding={b.id} />
            <button type="button" className="link-btn" onClick={() => setRecording(true)}>
              Change
            </button>
            {changed ? (
              <button type="button" className="link-btn link-btn--quiet" onClick={() => save(b.keys)}>
                Reset
              </button>
            ) : null}
          </>
        )}
      </span>
    </div>
  );
}

export function KeyboardGroup() {
  const k = usePrefs((s) => s.prefs.keyboard);
  const set = useSet('keyboard');
  const q = useContext(SearchContext);
  return (
    <>
      <Block title="Behaviour">
        <Row
          group="keyboard"
          k="singleKeys"
          label="Single-key shortcuts"
          desc="J, K, M, N and the rest, when you are not typing."
          keywords="vim keys letters"
        >
          <Switch
            label="Single-key shortcuts"
            checked={k.singleKeys}
            onChange={(singleKeys) => set({ singleKeys })}
          />
        </Row>
        <Row
          group="keyboard"
          k="hintFlash"
          label="Light up the hint"
          desc="The key hint on screen flashes when you use its shortcut."
          keywords="flash teach"
        >
          <Switch
            label="Light up the hint"
            checked={k.hintFlash}
            onChange={(hintFlash) => set({ hintFlash })}
          />
        </Row>
        <Row
          group="keyboard"
          k="sequenceMs"
          label="Time for the second key"
          desc="How long G waits for the letter after it."
          keywords="sequence timeout"
        >
          <Range
            label="Time for the second key"
            value={k.sequenceMs}
            min={400}
            max={1600}
            step={100}
            onChange={(sequenceMs) => set({ sequenceMs })}
            format={(v) => `${v} ms`}
          />
        </Row>
      </Block>
      {GROUPS.map((g) => {
        const rows = BINDINGS.filter((b) => b.group === g && matches(q, b.label, b.keys, g, 'shortcut key'));
        if (!rows.length) return null;
        return (
          <Block key={g} title={g}>
            {rows.map((b) => (
              <BindingRow key={b.id} b={b} />
            ))}
          </Block>
        );
      })}
      {Object.keys(k.overrides).length > 0 ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm settings__reset-keys"
          onClick={() => set({ overrides: {} })}
        >
          Put every key back
        </button>
      ) : null}
    </>
  );
}
