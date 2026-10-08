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
 * ------------------------------------------------------------------
 */

import type { PrefGroup } from '@nvx/contracts';
import { createContext, type ReactNode, useContext } from 'react';
import { Hint } from '../../help/Hint';
import { isChanged, usePrefs } from '../../state/prefs';

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
}) {
  const q = useContext(SearchContext);
  const prefs = usePrefs((s) => s.prefs);
  const reset = usePrefs((s) => s.reset);
  if (!matches(q, label, desc, keywords, group)) return null;
  const changed = isChanged(group, k, prefs);
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
      </div>
      <div className="setting__control">
        {children}
        {changed ? (
          <button
            type="button"
            className="setting__reset link-btn link-btn--quiet"
            onClick={() => reset(group, k)}
          >
            Reset
          </button>
        ) : null}
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
