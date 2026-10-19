/**
 * ------------------------------------------------------------------
 *  Title    |  Demo data loader
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Load the sample workspace only when the Cockpit is in
 *           |  demo mode, so a connected session never downloads it.
 *  How      |  loadDemo() is a dynamic import, cached by the module
 *           |  system. useDemoData(enabled) returns the module once it
 *           |  has arrived, or undefined until then (and always when
 *           |  not enabled).
 * ------------------------------------------------------------------
 */

import { useEffect, useState } from 'react';

export type DemoModule = typeof import('../fixtures/demo');

let loaded: DemoModule | undefined;

export const loadDemo = (): Promise<DemoModule> =>
  import('../fixtures/demo').then((m) => {
    loaded = m;
    return m;
  });

/** The sample workspace if it has been loaded; for the few synchronous lookups in demo mode. */
export const loadedDemo = (): DemoModule | undefined => loaded;
export const loadClaudeCodeDemo = () => import('../fixtures/claudeCode');

export function useDemoData(enabled: boolean): DemoModule | undefined {
  const [mod, setMod] = useState<DemoModule | undefined>(loaded);
  useEffect(() => {
    if (!enabled || loaded) return;
    let live = true;
    loadDemo().then((m) => {
      if (live) setMod(m);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? (loaded ?? mod) : undefined;
}
