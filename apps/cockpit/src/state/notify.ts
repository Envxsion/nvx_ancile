/**
 * ------------------------------------------------------------------
 *  Title    |  Notifications
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Toasts for what just happened, and a centre that keeps
 *           |  every one of them (DESIGN.md §13.3).
 *  How      |  notify() adds to both. Settings → Notifications decide
 *           |  the rest: per category, a toast, the centre only, or
 *           |  nothing; how many stack; how long they stay. Anything
 *           |  with Undo, and any error without a category, always
 *           |  toasts: a choice you can take back must be seen.
 *  Note     |  Core keeps every notice for 90 days: the centre loads
 *           |  that history (GET /notifications) and merges it with the
 *           |  live ones from /events by id; reading marks them read on
 *           |  Core too, so another device agrees.
 * ------------------------------------------------------------------
 */

import type { NotificationItem } from '@nvx/contracts';
import { create } from 'zustand';
import { api } from '../lib/api';
import { usePrefs } from './prefs';

export type Level = 'info' | 'success' | 'warn' | 'error';
export type NoticeCategory = 'approvals' | 'runs' | 'sources' | 'health' | 'memory';

export interface Notice {
  id: string;
  level: Level;
  title: string;
  body?: string;
  at: number;
  read: boolean;
  action?: { label: string; run: () => void };
  undo?: () => void;
  /** Which notification setting governs it. Absent: always a toast. */
  category?: NoticeCategory;
  /** Kept by Core (its read state lives there too). */
  server?: boolean;
}

interface NotifyState {
  toasts: Notice[];
  history: Notice[];
  notify: (n: Omit<Notice, 'id' | 'at' | 'read'> & { id?: string }) => string;
  dismiss: (id: string) => void;
  markAllRead: () => void;
  clear: () => void;
  /** Core's history, merged by id; live and local notices are kept. */
  mergeServer: (items: NotificationItem[], navigate?: (to: string) => void) => void;
}

export const MAX_TOASTS = 3;

/** Where a notice goes under the current settings. */
export function routeOf(n: Pick<Notice, 'category' | 'undo'>): 'toast' | 'centre' | 'off' {
  if (n.undo || !n.category) return 'toast';
  return usePrefs.getState().prefs.notifications.categories[n.category] ?? 'toast';
}

export const useNotify = create<NotifyState>((set) => ({
  toasts: [],
  history: [],
  notify: (n) => {
    const notice: Notice = { ...n, id: n.id ?? crypto.randomUUID(), at: Date.now(), read: false };
    const route = routeOf(notice);
    if (route === 'off') return notice.id;
    const max = usePrefs.getState().prefs.notifications.maxStacked ?? MAX_TOASTS;
    set((s) => ({
      toasts:
        route === 'toast' ? [...s.toasts.filter((t) => t.id !== notice.id), notice].slice(-max) : s.toasts,
      history: [notice, ...s.history.filter((h) => h.id !== notice.id)].slice(0, 200),
    }));
    return notice.id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  markAllRead: () =>
    set((s) => {
      if (s.history.some((h) => h.server && !h.read))
        void api.post('/notifications/read', { all: true }).catch(() => undefined);
      return { history: s.history.map((h) => ({ ...h, read: true })) };
    }),
  clear: () => set({ history: [] }),
  mergeServer: (items, navigate) =>
    set((s) => {
      const byId = new Map(s.history.map((h) => [h.id, h]));
      for (const it of items) {
        const mine = byId.get(it.id);
        byId.set(it.id, {
          ...(mine ?? {}),
          id: it.id,
          level: it.level,
          title: it.title,
          ...(it.body ? { body: it.body } : {}),
          at: mine?.at ?? Date.parse(it.created_at),
          // Read anywhere is read everywhere.
          read: !!it.read_at || !!mine?.read,
          server: true,
          ...(it.action && navigate && !mine?.action
            ? { action: { label: it.action.label, run: () => navigate(it.action?.href ?? '/') } }
            : {}),
        });
      }
      const history = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, 300);
      return { history };
    }),
}));

export const notify = (n: Parameters<NotifyState['notify']>[0]) => useNotify.getState().notify(n);
