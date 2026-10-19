/**
 * ------------------------------------------------------------------
 *  Title    |  Switch branch from the find bar
 *  Ref      |  roadmap TS2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Pro's "All branches" lists hits on other branches. A
 *           |  jump to one has to show that branch first; this does
 *           |  that, and says so plainly when the branch is gone.
 *  How      |  Sets the thread's active head to the branch's last
 *           |  message (the same write the tree panel's "jump here"
 *           |  makes), refreshes the thread, then checks the hit's
 *           |  message really is on the path now. A branch deleted
 *           |  since the list was made fails that check (or the write
 *           |  itself): the head is put back where it was, nothing
 *           |  has moved, and the caller refreshes the list.
 * ------------------------------------------------------------------
 */

import { notify } from '../state/notify';
import { ApiCallError, api } from './api';
import { refreshThread } from './branching';
import { ensureLoaded } from './threadPages';

export type SwitchResult = 'ok' | 'gone' | 'failed';

export async function switchToBranch(
  threadId: string,
  pick: { leafId: string; messageId: string },
  /** The last message of the branch on screen, to go back to. */
  back: string | null,
): Promise<SwitchResult> {
  const restore = async () => {
    if (!back) return;
    await api.patch(`/threads/${threadId}`, { active_head_id: back }).catch(() => undefined);
    await refreshThread(threadId);
  };
  try {
    await api.patch(`/threads/${threadId}`, { active_head_id: pick.leafId });
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 404) return 'gone';
    notify({
      level: 'error',
      title: 'Switching branch did not work',
      body:
        error instanceof ApiCallError
          ? error.body.error.hint
          : 'Nothing changed. Check that NVX Ancile is running, then try again.',
    });
    return 'failed';
  }
  await refreshThread(threadId);
  if (await ensureLoaded(threadId, pick.messageId)) return 'ok';
  await restore();
  return 'gone';
}
