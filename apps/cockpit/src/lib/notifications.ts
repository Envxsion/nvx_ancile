/**
 * ------------------------------------------------------------------
 *  Title    |  Notification history
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Core keeps every notice for 90 days. Load it once when
 *           |  the app starts (so the bell's count is right after a
 *           |  reload), again whenever the centre opens, and page back
 *           |  through older ones on request.
 *  How      |  Each page is merged into the notice store by id, so a
 *           |  live notice that also arrives in a page appears once.
 * ------------------------------------------------------------------
 */

import type { NotificationList } from '@nvx/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNotify } from '../state/notify';
import { useUi } from '../state/ui';
import { api } from './api';

const PAGE = 50;

async function page(cursor: string | null): Promise<NotificationList | null> {
  try {
    const q = `limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    return await api.get<NotificationList>(`/notifications?${q}`);
  } catch {
    return null; // Core older than the history routes, or offline: live notices still work.
  }
}

/** Keep the store in step with Core's history. Mount once (the title bar). */
export function useNotificationHistory(): {
  more: boolean;
  loadMore: () => Promise<void>;
  loading: boolean;
} {
  const demo = useUi((s) => s.demo);
  const open = useUi((s) => s.centerOpen);
  const navigate = useNavigate();
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (from: string | null) => {
      setLoading(true);
      const r = await page(from);
      setLoading(false);
      if (!r) return;
      useNotify.getState().mergeServer(r.items, (to) => void navigate({ to }));
      setCursor(r.next_cursor);
    },
    [navigate],
  );

  // On start, and each time the centre opens: the newest page.
  const started = useRef(false);
  useEffect(() => {
    if (demo || (!open && started.current)) return;
    started.current = true;
    void load(null);
  }, [open, demo, load]);

  return { more: !!cursor, loading, loadMore: () => load(cursor) };
}
