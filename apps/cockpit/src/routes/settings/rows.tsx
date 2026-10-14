/**
 * ------------------------------------------------------------------
 *  Title    |  Setting rows
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One row per setting: what it is, what it does, the
 *           |  control, a dot when it differs from the default, and a
 *           |  Reset that puts just this one back.
 *  How      |  Rows register their words with the page so Settings
 *           |  search can hide everything that does not match.
 *           |  A row that another setting, the OS or the frame
 *           |  governor can override shows a note while that is so,
 *           |  naming (and linking) what overrides it: OVERRIDES
 *           |  below, read from the resolved look (lookOf).
 * ------------------------------------------------------------------
 */

import type { Preferences, PrefGroup } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { type ComponentType, createContext, type ReactNode, useContext } from 'react';
import { Hint } from '../../help/Hint';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { isChanged, lookOf, usePrefs } from '../../state/prefs';
import { Icon } from '../../ui/Icon';

export const SearchContext = createContext('');

export function matches(q: string, ...words: (string | undefined)[]): boolean {
  if (!q.trim()) return true;
  const hay = words.join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

export function Row({
  group,
  k,
  label,
  desc,
  children,
  keywords,
  hint,
  stack,
  note,
}: {
  group: PrefGroup;
  k: string;
  label: string;
  desc?: string;
  children: ReactNode;
  keywords?: string;
  hint?: { title: string; body: string; article?: string };
  /** Put the control under the words (wide controls). */
  stack?: boolean;
  /** A note of its own; rows in OVERRIDES get theirs without asking. */
  note?: ReactNode;
}) {
  const q = useContext(SearchContext);
  // Only this row's own value: a slider elsewhere does not redraw every row.
  const changed = usePrefs((s) => isChanged(group, k, s.prefs));
  const reset = usePrefs((s) => s.reset);
  if (!matches(q, label, desc, keywords, group)) return null;
  const Override = OVERRIDES[`${group}.${k}`];
  return (
    <div className="setting" data-stack={stack || undefined} data-changed={changed || undefined}>
      <div className="setting__words">
        <div className="setting__label">
          <span>{label}</span>
          {changed ? <span className="setting__dot" title="Changed from the default" /> : null}
          {hint ? (
            <Hint id={`setting-${group}-${k}`} title={hint.title} article={hint.article}>
              {hint.body}
            </Hint>
          ) : null}
        </div>
        {desc ? <p className="setting__desc">{desc}</p> : null}
        {note ?? (Override ? <Override /> : null)}
      </div>
      <div className="setting__control">
        {children}
        {/* Always laid out, shown only when changed: if Reset appeared mid-drag
            it pushed the slider sideways under the pointer and the value jumped. */}
        <button
          type="button"
          className="setting__reset link-btn link-btn--quiet"
          data-hidden={changed ? undefined : true}
          aria-hidden={changed ? undefined : true}
          tabIndex={changed ? undefined : -1}
          disabled={!changed}
          onClick={() => reset(group, k)}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export function Block({ title, children, lede }: { title: string; children: ReactNode; lede?: string }) {
  return (
    <section className="setting-block">
      <header className="setting-block__head">
        <h2>{title}</h2>
        {lede ? <p className="mute">{lede}</p> : null}
      </header>
      <div className="setting-block__rows">{children}</div>
    </section>
  );
}

export function useSet<G extends PrefGroup>(group: G) {
  const set = usePrefs((s) => s.set);
  return (patch: Partial<ReturnType<typeof usePrefs.getState>['prefs'][G]>) => set(group, patch);
}

/**
 * What stops glass and grain showing although they are chosen, read from
 * the resolved look (lookOf: the same look the document wears) and put
 * down to the setting that did it. Transparency first: it is a person's
 * own choice, or their system's; then Effects (Light, or Automatic while
 * the frame governor has it light).
 */
export type LookOverride = 'transparency' | 'system-transparency' | 'effects' | 'effects-auto';

export function lookOverride(prefs: Preferences, autoLite: boolean): LookOverride | null {
  const look = lookOf(prefs, autoLite);
  if (look.transparency === 'reduced')
    return prefs.accessibility.transparency === 'reduced' ? 'transparency' : 'system-transparency';
  if (look.fx === 'lite') return prefs.advanced.performance === 'lite' ? 'effects' : 'effects-auto';
  return null;
}

const TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)';
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** lookOverride, live: the prefs, the governor and the OS. */
export function useLookOverride(): LookOverride | null {
  const prefs = usePrefs((s) => s.prefs);
  const autoLite = usePrefs((s) => s.autoLite);
  // lookOf asks the OS itself; subscribing here redraws the row when it changes.
  useMediaQuery(TRANSPARENCY_QUERY);
  return lookOverride(prefs, autoLite);
}

/** The line under a row's words that says why its choice is not in force. */
export function RowNote({ children }: { children: ReactNode }) {
  return (
    <p className="setting__note">
      <Icon name="info" size={12} />
      <span>{children}</span>
    </p>
  );
}

/** Surfaces and Film grain: a note only while the chosen glass or grain is overridden. */
function LookNote({ what }: { what: 'glass' | 'grain' }) {
  const chosen = usePrefs((s) =>
    what === 'glass' ? s.prefs.appearance.material === 'glass' : s.prefs.appearance.grain,
  );
  const why = useLookOverride();
  if (!chosen || !why) return null;
  return (
    <RowNote>
      <OverrideNote what={what} why={why} />
    </RowNote>
  );
}

/** Motion and Transparency on System: what that comes to while the OS asks for less. */
function SystemNote({ what }: { what: 'motion' | 'transparency' }) {
  const system = usePrefs((s) => s.prefs.accessibility[what] === 'system');
  const reduces = useMediaQuery(what === 'motion' ? MOTION_QUERY : TRANSPARENCY_QUERY);
  if (!system || !reduces) return null;
  return (
    <RowNote>
      {what === 'motion'
        ? 'Reduced: your system asks for less motion.'
        : 'Reduced: your system asks for less transparency, so glass is solid and the grain is off.'}
    </RowNote>
  );
}

/** Effects on Automatic, while the frame governor has turned blur and grain off. */
function EffectsNote() {
  const lite = usePrefs((s) => s.prefs.advanced.performance === 'auto' && s.autoLite);
  if (!lite) return null;
  return <RowNote>Light for now: blur and grain are off while the machine is struggling.</RowNote>;
}

/** The rows something else can override, each with the note that says so. */
const OVERRIDES: Partial<Record<string, ComponentType>> = {
  'appearance.material': () => <LookNote what="glass" />,
  'appearance.grain': () => <LookNote what="grain" />,
  'accessibility.motion': () => <SystemNote what="motion" />,
  'accessibility.transparency': () => <SystemNote what="transparency" />,
  'advanced.performance': EffectsNote,
};

function SettingLink({ group, children }: { group: 'accessibility' | 'advanced'; children: ReactNode }) {
  return (
    <Link to="/settings/$group" params={{ group }}>
      {children}
    </Link>
  );
}

/** The note on a Materials row while an override is in force, naming and linking it. */
export function OverrideNote({ what, why }: { what: 'glass' | 'grain'; why: LookOverride }) {
  const off = what === 'glass' ? 'Solid' : 'Off';
  const transparency = <SettingLink group="accessibility">Transparency</SettingLink>;
  const effects = <SettingLink group="advanced">Effects</SettingLink>;
  switch (why) {
    case 'transparency':
      return (
        <>
          {off} while {transparency} is reduced.
        </>
      );
    case 'system-transparency':
      return (
        <>
          {off} while your system reduces transparency (see {transparency}).
        </>
      );
    case 'effects':
      return (
        <>
          {off} while {effects} is Light.
        </>
      );
    case 'effects-auto':
      return (
        <>
          {off} for now: {effects} turned {what === 'glass' ? 'blur' : 'it'} off because the machine is
          struggling.
        </>
      );
  }
}
