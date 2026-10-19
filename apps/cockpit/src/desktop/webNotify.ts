/**
 * ------------------------------------------------------------------
 *  Title    |  Browser notifications
 *  Ref      |  ROADMAP row NT1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  In a browser tab (the desktop app has native ones),
 *           |  a category set to "Desktop" also notifies you while
 *           |  the tab is not in front: a request waiting for you,
 *           |  or a run that took 30 seconds or more.
 *  How      |  The browser asks permission when "Desktop" is chosen in
 *           |  Settings → Notifications. Events come from the same
 *           |  stream as everything else (lib/events.ts). Each one is
 *           |  shown once (its tag is its id), and only while the tab
 *           |  has no focus.
 *  Note     |  A browser notification never carries the request or the
 *           |  thread title: a tab cannot tell which notebooks are
 *           |  private, so it says only that something is waiting.
 * ------------------------------------------------------------------
 */

import type { GlobalEvent } from '@nvx/contracts';
import { isDesktop } from '../lib/runtime';
import { usePrefs } from '../state/prefs';

/** A run shorter than this is not worth one: you were watching it. */
export const LONG_RUN_MS = 30_000;

const started = new Map<string, number>();

const supported = () => typeof Notification !== 'undefined';

export const webPermission = (): NotificationPermission | 'unsupported' =>
  supported() ? Notification.permission : 'unsupported';

/** Ask the browser, from a click in Settings. */
export async function askWebPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!supported() || isDesktop()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

type Cat = 'approvals' | 'runs' | 'sources' | 'health' | 'memory';

const wanted = (cat: Cat) => usePrefs.getState().prefs.notifications.categories[cat] === 'desktop';

function away(): boolean {
  return typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
}

function show(id: string, title: string, body?: string): void {
  if (isDesktop() || !supported() || Notification.permission !== 'granted' || !away()) return;
  try {
    new Notification(title, { tag: id, ...(body && { body }) });
  } catch {
    /* a browser that refuses (a locked-down profile): the in-app toast still shows */
  }
}

/** Called for every event on the global stream. */
export function webNotifyEvent(e: GlobalEvent, now = Date.now()): void {
  if (isDesktop()) return;
  switch (e.type) {
    case 'approval.requested':
      if (wanted('approvals')) show(`approval:${e.approval_id}`, 'A request needs your go-ahead');
      return;
    case 'run.updated': {
      if (e.status === 'queued' || e.status === 'running') {
        if (!started.has(e.run_id)) started.set(e.run_id, now);
        if (started.size > 300) started.delete(started.keys().next().value as string);
        return;
      }
      if (e.status === 'waiting_approval' || e.status === 'waiting_compute') return;
      const began = started.get(e.run_id);
      started.delete(e.run_id);
      if (began === undefined || now - began < LONG_RUN_MS || e.status === 'cancelled' || !e.thread_id)
        return;
      if (wanted('runs'))
        show(`run:${e.run_id}`, e.status === 'succeeded' ? 'An answer is ready' : 'An answer did not finish');
      return;
    }
    default:
      return;
  }
}

/** A notice in a category set to Desktop (sources, health, memory). */
export function webNotifyNotice(n: { id: string; title: string; category?: Cat | undefined }): void {
  if (!n.category || n.category === 'approvals' || n.category === 'runs' || !wanted(n.category)) return;
  show(`notice:${n.id}`, n.title);
}
