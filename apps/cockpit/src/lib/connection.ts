/**
 * ------------------------------------------------------------------
 *  Title    |  Connection to Core
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One honest answer to "can I reach Core right now?", so
 *           |  the banner, the status bar and the composer agree.
 *  How      |  Every API call and the /events stream report in. Two
 *           |  failures in a row (or the stream retrying) is offline;
 *           |  any success is online again.
 *  Note     |  `everOnline` is remembered per device. Only a browser
 *           |  that has never reached Core shows the sample workspace;
 *           |  after that, an outage keeps your own data on screen.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';

const SEEN_KEY = 'nvx.ancile.core-seen';

function seenBefore(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

interface ConnectionState {
  status: 'online' | 'offline';
  /** When Core stopped answering, for "Offline for 2 min". */
  since: number | null;
  failures: number;
  everOnline: boolean;
  ok: () => void;
  fail: () => void;
}

export const useConnection = create<ConnectionState>()((set, get) => ({
  status: 'online',
  since: null,
  failures: 0,
  everOnline: typeof window !== 'undefined' && seenBefore(),
  ok: () => {
    const s = get();
    if (!s.everOnline) {
      try {
        localStorage.setItem(SEEN_KEY, '1');
      } catch {
        /* blocked storage: remembered for this tab */
      }
    }
    if (s.status !== 'online' || s.failures || !s.everOnline)
      set({ status: 'online', since: null, failures: 0, everOnline: true });
  },
  fail: () => {
    const s = get();
    const failures = s.failures + 1;
    set(
      failures >= 2 && s.status !== 'offline'
        ? { failures, status: 'offline', since: Date.now() }
        : { failures },
    );
  },
}));
