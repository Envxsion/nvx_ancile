/**
 * ------------------------------------------------------------------
 *  Title    |  A thread's summary, for a context link
 *  Ref      |  docs/notebooks.md (Context links) · DESIGN.md §8.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What another thread sees of this one through a link:
 *           |  its summary, never its whole history.
 *  How      |  The newest TL;DR or compaction summary NVX Ancile has
 *           |  for the thread. A thread never summarised gives a short
 *           |  digest of the last few turns on its active branch, each
 *           |  cut short, so a link is useful from the first day.
 * ------------------------------------------------------------------
 */

import type { BranchStore } from '../threads/branches';
import { ancestorPath } from '../threads/path';
import { asTree, type ThreadRepo, textOf } from '../threads/repo';

const TURNS = 4;
const TURN_CHARS = 600;

export function threadSummary(deps: {
  threads: Pick<ThreadRepo, 'getThread' | 'messages'>;
  branches?: Pick<BranchStore, 'summaries'> | undefined;
}) {
  return async (threadId: string): Promise<string | null> => {
    const summaries = (await deps.branches?.summaries(threadId).catch(() => [])) ?? [];
    const newest = [...summaries].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (newest?.content.trim()) return newest.content.trim();
    const t = await deps.threads.getThread(threadId);
    if (!t) return null;
    const all = asTree(await deps.threads.messages(threadId));
    const byId = new Map(all.map((m) => [m.id, m] as const));
    const head = t.active_head_id && byId.has(t.active_head_id) ? t.active_head_id : all.at(-1)?.id;
    if (!head) return null;
    const turns = ancestorPath(byId, head)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.deleted_at)
      .slice(-TURNS)
      .map((m) => {
        const text = textOf(m.parts).trim().replace(/\s+/g, ' ');
        const cut = text.length > TURN_CHARS ? `${text.slice(0, TURN_CHARS)}…` : text;
        return cut ? `${m.role === 'user' ? 'Asked' : 'Answered'}: ${cut}` : '';
      })
      .filter(Boolean);
    return turns.length ? `Latest turns (no summary yet):\n${turns.join('\n')}` : null;
  };
}
