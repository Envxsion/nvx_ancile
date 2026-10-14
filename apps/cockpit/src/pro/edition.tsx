/**
 * ------------------------------------------------------------------
 *  Title    |  The edition on the document
 *  Ref      |  DESIGN.md §9, §13 · packages/aperture/src/pro.css
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Say which edition is on (data-edition="pro" on <html>)
 *           |  so the Pro palette and the gilt kit apply, mark it once
 *           |  in the status bar, and play the one moment Pro arrives:
 *           |  when a key turns it on, and the first time a Pro build
 *           |  opens.
 *  How      |  From the licence (the same query the Pro seam reads).
 *           |  Pro means a Pro build with a Pro tier; a free build with
 *           |  a key held is still free. The edition is kept so the
 *           |  theme script can apply it before first paint. The swap
 *           |  cross-fades colours (the theme's own mechanism); the
 *           |  arrival is a gilded line round the window, once, and
 *           |  nothing at all with reduced motion. In a team, someone
 *           |  without a Pro seat sees the free edition.
 *  Note     |  Presentation only: what Pro unlocks is decided by Core.
 * ------------------------------------------------------------------
 */

import { EDITION_KEY } from '@nvx/aperture';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { reducedMotionNow } from '../lib/motion';
import { Icon } from '../ui/Icon';

/** Set once Pro's arrival has been shown on this computer. */
export const AWAKENED_KEY = 'nvx.ancile.pro-awakened';
const AWAKEN_EVENT = 'ancile:pro-awaken';
const AWAKEN_MS = 1900;

interface EditionView {
  build: 'free' | 'pro';
  status: { tier: 'free' | 'pro' | 'max_access' };
  /** False: a team member without a Pro seat (absent from an older Core: yes). */
  seat?: boolean;
}

export type Edition = 'free' | 'pro';

export function editionOf(d: EditionView | undefined): Edition | null {
  if (!d) return null;
  return d.build === 'pro' && d.status.tier !== 'free' && d.seat !== false ? 'pro' : 'free';
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: this tab only.
  }
}
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The in-app Motion setting, resolved against the system once (lib/motion). */
const reducedMotion = reducedMotionNow;

/** Play Pro's arrival (once per call; the licence screen calls it when a key turns Pro on). */
export function awakenPro(): void {
  store(AWAKENED_KEY, '1');
  window.dispatchEvent(new Event(AWAKEN_EVENT));
}

export function useEdition(): Edition | null {
  const q = useQuery({
    queryKey: ['license', 'details'],
    queryFn: () => api.get<EditionView>('/license/details'),
    staleTime: 30_000,
  });
  return editionOf(q.data);
}

/** Keeps data-edition in step with the licence, and plays the first arrival. */
export function EditionSync() {
  const edition = useEdition();
  useEffect(() => {
    if (!edition) return;
    const root = document.documentElement;
    const was = root.dataset.edition === 'pro' ? 'pro' : 'free';
    if (was !== edition) {
      const fade = !reducedMotion();
      if (fade) root.setAttribute('data-theme-switching', '');
      if (edition === 'pro') root.dataset.edition = 'pro';
      else delete root.dataset.edition;
      if (fade) window.setTimeout(() => root.removeAttribute('data-theme-switching'), 520);
    }
    store(EDITION_KEY, edition === 'pro' ? 'pro' : null);
    if (edition === 'pro' && !stored(AWAKENED_KEY)) awakenPro();
  }, [edition]);
  return <ProAwaken />;
}

/** The gilded line round the window when Pro arrives. */
export function ProAwaken() {
  const [run, setRun] = useState(0);
  useEffect(() => {
    const on = () => {
      if (!reducedMotion()) setRun((n) => n + 1);
    };
    window.addEventListener(AWAKEN_EVENT, on);
    return () => window.removeEventListener(AWAKEN_EVENT, on);
  }, []);
  useEffect(() => {
    if (!run) return;
    const t = window.setTimeout(() => setRun(0), AWAKEN_MS);
    return () => window.clearTimeout(t);
  }, [run]);
  if (!run) return null;
  return (
    <div key={run} className="pro-awaken" aria-hidden="true" data-testid="pro-awaken">
      <span className="pro-awaken__glow" />
      <svg preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="pro-awaken-gilt" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" />
            <stop offset="0.45" className="hi" />
            <stop offset="1" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="100%" height="100%" rx="10" pathLength={1} />
      </svg>
    </div>
  );
}

/** The status bar's mark of the edition: shown with Pro only, quiet, and a way to the licence. */
export function EditionMark() {
  const edition = useEdition();
  if (edition !== 'pro') return null;
  return (
    <Link
      to="/admin/$section"
      params={{ section: 'license' }}
      className="status-seg edition-mark"
      aria-label="NVX Ancile Pro: open the licence"
    >
      <Icon name="seal" size={13} />
      <span>Pro</span>
    </Link>
  );
}
