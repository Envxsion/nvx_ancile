/**
 * ------------------------------------------------------------------
 *  Title    |  What changed
 *  Ref      |  ROADMAP row UP1 (extends H5)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The first time you open NVX Ancile after an update, a
 *           |  sheet says what changed. Once: closing it is the end of it.
 *  How      |  The desktop shell tells Core what it installed (the
 *           |  notes that came with the update); this reads them from
 *           |  GET /system/desktop and remembers, in the help progress
 *           |  (lastSeenVersion, which H5 keeps), the version it has
 *           |  shown. Nothing shows in a browser tab,
 *           |  on a first install, or when the version has no notes.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { useHelp } from '../help/store';
import { NEWS_OFFER_ID, NEWS_TOUR } from '../help/WhatsNewOffer';
import { useLayer } from '../keys/dispatch';
import { isDesktop } from '../lib/runtime';
import { useDesktopState } from './api';
import '../styles/desktop.css';

/** Should the sheet open: an update just happened to the running version, and it has not been shown. */
export function shouldShow(
  last: { to: string; notes: string | null } | null | undefined,
  running: string | undefined,
  shown: string | null,
): boolean {
  return !!last && !!running && last.to === running && shown !== last.to && !!last.notes?.trim();
}

export function WhatChangedHost() {
  const state = useDesktopState();
  const last = state.data?.last_update;
  const running = typeof window === 'undefined' ? undefined : window.__NVX_DESKTOP__?.version;
  // The help progress already keeps the last version whose news was shown (H5).
  const shown = useHelp((s) => s.lastSeenVersion);
  const toursSeen = useHelp((s) => s.tours);
  const [open, setOpen] = useState(false);
  useLayer(open);
  useEffect(() => {
    if (isDesktop() && shouldShow(last, running, shown ?? null)) setOpen(true);
  }, [last, running, shown]);
  if (!last) return null;
  const close = () => {
    useHelp.setState({ lastSeenVersion: last.to });
    setOpen(false);
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick what-changed" aria-describedby="what-changed-body">
          <Dialog.Title className="dialog__title">What changed in {last.to}</Dialog.Title>
          <div id="what-changed-body" className="dialog__lede">
            <p className="mute">Updated from {last.from}. Your data and settings are as you left them.</p>
            <p className="what-changed__notes">{last.notes}</p>
          </div>
          <div className="dialog__actions">
            {last.to.startsWith('0.1.1') && !toursSeen[NEWS_TOUR] ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  close();
                  useHelp.getState().seeHint(NEWS_OFFER_ID);
                  useHelp.getState().startTour(NEWS_TOUR);
                }}
              >
                Take the tour
              </button>
            ) : null}
            <button type="button" className="btn btn--primary" onClick={close}>
              Got it
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
