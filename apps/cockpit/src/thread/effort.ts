/**
 * ------------------------------------------------------------------
 *  Title    |  Reasoning effort: the thread's setting
 *  Ref      |  ROADMAP.md EN1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Words for the levels and the one write: save the
 *           |  effort on the thread, or clear it back to the model's
 *           |  default. Used by the chip and by /effort.
 *  How      |  PATCH /threads/:id { effort }. Core keeps it in the
 *           |  thread's settings and sends it with each request in the
 *           |  provider's own words; a model that takes none drops it.
 * ------------------------------------------------------------------
 */

import type { Effort } from '@nvx/contracts';
import { api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import type { ThreadView } from '../lib/types';
import { notify } from '../state/notify';

export const EFFORT_WORDS: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Set the thread's reasoning effort; null goes back to the model's default. */
export async function setEffort(threadId: string, effort: Effort | null): Promise<boolean> {
  try {
    await api.patch(`/threads/${threadId}`, { effort });
    // The chip shows it at once; the thread is read again behind it.
    queryClient.setQueryData<ThreadView>(keys.thread(threadId), (t) => (t ? { ...t, effort } : t));
    void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
    return true;
  } catch {
    notify({
      level: 'error',
      title: "The effort didn't reach Core",
      body: 'Nothing changed. Check that NVX Ancile is running, then try again.',
    });
    return false;
  }
}
