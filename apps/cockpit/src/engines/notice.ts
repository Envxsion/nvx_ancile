/**
 * ------------------------------------------------------------------
 *  Title    |  The context notice
 *  Ref      |  docs/engines.md (Claude Code)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  "This thread's context will be sent to Claude Code":
 *           |  one quiet line, once per turn that shares context.
 *  How      |  Whichever arrives first, the send's context_notice or
 *           |  the run's context.shared event, shows it; the other is
 *           |  ignored for the same answer. Dismissible.
 *  Note     |  Imports nothing from the app, so lib/run.ts can call it.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';

interface Notice {
  text: string;
  /** The answer it belongs to: one notice per turn, whichever source says it first. */
  messageId: string | null;
}

interface NoticeState {
  byThread: Record<string, Notice>;
  seen: Record<string, true>;
  show: (threadId: string, text: string, messageId: string | null) => void;
  dismiss: (threadId: string) => void;
}

export const useContextNotices = create<NoticeState>((set) => ({
  byThread: {},
  seen: {},
  show: (threadId, text, messageId) =>
    set((s) => {
      if (messageId && s.seen[messageId]) return s;
      return {
        byThread: { ...s.byThread, [threadId]: { text, messageId } },
        seen: messageId ? { ...s.seen, [messageId]: true } : s.seen,
      };
    }),
  dismiss: (threadId) =>
    set((s) => {
      const { [threadId]: _gone, ...rest } = s.byThread;
      return { byThread: rest };
    }),
}));

export function showContextNotice(threadId: string, text: string, messageId: string | null): void {
  useContextNotices.getState().show(threadId, text, messageId);
}
