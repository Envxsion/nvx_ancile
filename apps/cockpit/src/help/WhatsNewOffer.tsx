/**
 * ------------------------------------------------------------------
 *  Title    |  Offer the "What is new" tour
 *  Ref      |  ROADMAP H4 (tours) · GD1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  After an update, say once that there is a short tour of
 *           |  what changed, and let the person take it or leave it.
 *  How      |  A single quiet notice with a "Take the tour" button, a
 *           |  few seconds after the workspace has loaded. It is shown
 *           |  only to a workspace that already has threads (a new
 *           |  install learns from the first-steps list instead), only
 *           |  when the tour is neither done nor skipped, and only once:
 *           |  the offer is remembered as a seen hint (help store, which
 *           |  Core keeps), so it follows you to another device.
 *  Note     |  Never while automation drives the window, so a test run
 *           |  keeps its toasts. The desktop "What changed" sheet has
 *           |  its own button for the same tour (desktop/WhatChanged).
 * ------------------------------------------------------------------
 */

import { useEffect } from 'react';
import { useThreads } from '../lib/data';
import { notify } from '../state/notify';
import { useHelp } from './store';

/** The tour offered, and the release it belongs to. */
export const NEWS_TOUR = 'whats-new';
export const NEWS_OFFER_ID = 'offer:whats-new:0.1.1';
const DELAY_MS = 8_000;

/** Should the offer be made now? Pure, so the rules can be tested. */
export function shouldOffer(s: {
  threads: number | undefined;
  tours: Record<string, string>;
  hintsSeen: readonly string[];
  touring: boolean;
  automated: boolean;
}): boolean {
  if (s.automated || s.touring || s.threads === undefined || s.threads === 0) return false;
  return !s.tours[NEWS_TOUR] && !s.hintsSeen.includes(NEWS_OFFER_ID);
}

export function WhatsNewOffer() {
  const threads = useThreads().data;
  const count = threads?.length;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const h = useHelp.getState();
      const automated = typeof navigator !== 'undefined' && navigator.webdriver === true;
      if (
        !shouldOffer({ threads: count, tours: h.tours, hintsSeen: h.hintsSeen, touring: !!h.tour, automated })
      )
        return;
      h.seeHint(NEWS_OFFER_ID);
      notify({
        level: 'info',
        title: 'New in 0.1.1',
        body: 'A three minute tour shows what changed. You can find it later in the guide (G H).',
        action: { label: 'Take the tour', run: () => useHelp.getState().startTour(NEWS_TOUR) },
      });
    }, DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [count]);
  return null;
}
