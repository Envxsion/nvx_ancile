/**
 * ------------------------------------------------------------------
 *  Title    |  The Trash
 *  Ref      |  ROADMAP TC4 · guard rail GR23
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Deleted threads wait 30 days. This reads them, puts
 *           |  them back, and empties the Trash when asked.
 *  How      |  Restore is a bulk action, so it has an Undo like the
 *           |  rest. Emptying is the one step here with no way back,
 *           |  so the view asks first and this sends the confirm.
 * ------------------------------------------------------------------
 */

import type { EmptyTrashResult, TrashItem, TrashList } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { notify } from '../state/notify';
import { ApiCallError, api } from './api';
import { keys } from './data';
import { queryClient } from './query';
import { bulkWithUndo } from './threads';

export function useTrash(enabled = true) {
  return useQuery({
    queryKey: keys.trash,
    enabled,
    queryFn: () => api.get<TrashList>('/threads/trash'),
  });
}

/** Whole days left before the daily purge removes a thread (never below 0). */
export function daysLeft(item: Pick<TrashItem, 'purge_at'>, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(item.purge_at) - now) / 86_400_000));
}

export function restoreThreads(ids: string[], title?: string) {
  return bulkWithUndo(
    { action: 'restore', ids },
    {
      title: (n) => (n === 1 ? 'Restored from the Trash' : `Restored ${n} threads from the Trash`),
      ...(title && { body: title }),
      none: 'Nothing was restored',
    },
  );
}

/** Remove everything in the Trash for good. Call it only after the person has confirmed. */
export async function emptyTrash(): Promise<EmptyTrashResult | null> {
  try {
    const r = await api.post<EmptyTrashResult>('/threads/trash/empty', { confirm: true });
    notify({
      level: 'success',
      title: 'Trash emptied',
      body:
        r.kept > 0
          ? `${r.purged} removed for good. ${r.kept} stayed because they are answering.`
          : `${r.purged} ${r.purged === 1 ? 'thread' : 'threads'} removed for good.`,
    });
    return r;
  } catch (error) {
    notify({
      level: 'error',
      title: error instanceof ApiCallError ? error.body.error.title : 'The Trash was not emptied',
      body:
        error instanceof ApiCallError
          ? error.body.error.hint
          : 'Nothing was removed. Check that NVX Ancile is running, then try again.',
    });
    return null;
  } finally {
    void queryClient.invalidateQueries({ queryKey: keys.trash });
  }
}
