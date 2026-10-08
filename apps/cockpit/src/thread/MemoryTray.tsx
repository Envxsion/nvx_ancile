/**
 * ------------------------------------------------------------------
 *  Title    |  Memory tray
 *  Ref      |  DESIGN.md §6.3 (poisoning rule) · §16
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A flow's workers may only propose memory; they never
 *           |  write it. Under the answer they worked on, the
 *           |  proposals wait to be kept or let go, one click each.
 *  How      |  memory.proposal names the run it came from, so a
 *           |  proposal sits under that run's answer. An event without
 *           |  a run id falls back to timing: the answer whose flow was
 *           |  running when it arrived (or a few seconds after). Kept
 *           |  ones are committed to the git memory by Core; dismissed
 *           |  ones are rejected there.
 * ------------------------------------------------------------------
 */

import { useState } from 'react';
import { create } from 'zustand';
import { ApiCallError, api } from '../lib/api';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';

export interface TrayProposal {
  id: string;
  text: string;
  target: string;
  at: number;
  runId?: string;
}

interface TrayStore {
  items: TrayProposal[];
  add: (p: TrayProposal) => void;
  remove: (id: string) => void;
}

/** Proposals heard this session (the newest 50), waiting for a decision. */
export const useMemoryTray = create<TrayStore>((set) => ({
  items: [],
  add: (p) => set((s) => (s.items.some((x) => x.id === p.id) ? s : { items: [...s.items, p].slice(-50) })),
  remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

/** Grace after a flow ends: capture runs just after the answer is saved. */
const AFTER_MS = 15_000;

export function MemoryTray({
  runId,
  startedAt,
  endedAt,
}: {
  runId?: string | null;
  startedAt: number;
  endedAt: number | null;
}) {
  const all = useMemoryTray((s) => s.items);
  const [busy, setBusy] = useState<string | null>(null);
  const mine = all.filter((p) =>
    p.runId ? p.runId === runId : p.at >= startedAt && (endedAt === null || p.at <= endedAt + AFTER_MS),
  );
  if (!mine.length) return null;

  const decide = async (p: TrayProposal, decision: 'approve' | 'reject') => {
    setBusy(p.id);
    try {
      await api.post(`/memory/proposals/${p.id}`, { decision });
      useMemoryTray.getState().remove(p.id);
      if (decision === 'approve') notify({ level: 'success', title: 'Remembered', body: p.text });
    } catch (e) {
      notify({
        level: 'error',
        title: e instanceof ApiCallError ? e.body.error.title : 'That did not reach Core',
        body: e instanceof ApiCallError ? e.body.error.hint : 'Try again from Admin, Memory.',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="mem-tray" aria-label="Memory the team suggested">
      <p className="mem-tray__head">
        <Icon name="memory" size={13} />
        The team suggested {mine.length === 1 ? 'something' : `${mine.length} things`} to remember
      </p>
      {mine.map((p) => (
        <div key={p.id} className="mem-tray__item">
          <span className="mem-tray__text">{p.text}</span>
          <span className="mute" data-num>
            {p.target}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy === p.id}
            onClick={() => void decide(p, 'reject')}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy === p.id}
            onClick={() => void decide(p, 'approve')}
          >
            Keep
          </button>
        </div>
      ))}
    </aside>
  );
}
