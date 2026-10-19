/**
 * ------------------------------------------------------------------
 *  Title    |  Frame host
 *  Ref      |  packages/contracts/src/csp.ts · docs/desktop.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Put a document into a sandboxed frame without srcdoc,
 *           |  which would inherit the Cockpit's strict policy.
 *  How      |  The frame loads the empty frame host (public/frame.html);
 *           |  when it says it is ready, the document is posted to it
 *           |  once, and it writes it. Only that frame's own window, at
 *           |  an opaque origin, is listened to, and only the first
 *           |  ready counts: a frame that navigates itself back to the
 *           |  host gets nothing.
 * ------------------------------------------------------------------
 */

import { FRAME_HOST_CHANNEL, FRAME_HOST_PATH } from '@nvx/contracts/csp';

export const FRAME_HOST_URL = FRAME_HOST_PATH;

/** Fill `frame` with `doc` when its host is ready. Call before the frame loads; returns a cleanup. */
export function feedFrame(frame: HTMLIFrameElement, doc: string): () => void {
  let sent = false;
  const onMessage = (e: MessageEvent) => {
    if (sent || !frame.contentWindow || e.source !== frame.contentWindow || e.origin !== 'null') return;
    const d = e.data as { channel?: unknown; ready?: unknown } | null;
    if (!d || typeof d !== 'object' || d.channel !== FRAME_HOST_CHANNEL || d.ready !== true) return;
    sent = true;
    window.removeEventListener('message', onMessage);
    frame.contentWindow.postMessage({ channel: FRAME_HOST_CHANNEL, doc }, '*');
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
