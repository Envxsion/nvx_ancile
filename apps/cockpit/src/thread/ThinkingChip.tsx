/**
 * ------------------------------------------------------------------
 *  Title    |  Thinking toggle
 *  Ref      |  ROADMAP.md 0.1.1 · docs/prompt-caching.md · thread/EffortChip.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Beside the effort chip, for a model that can reason:
 *           |  turn extended thinking on or off for this thread.
 *  How      |  Shown when the model's capabilities (Core sends the
 *           |  effective list) include reasoning. Choosing saves it on
 *           |  the thread (PATCH /threads/:id { thinking }); every later
 *           |  message in the thread sends it.
 *  Note     |  Unlike effort, this starts a new prompt epoch
 *           |  (`thinking_toggled`), so the next turn reads the whole
 *           |  conversation again. The menu says so, once, in its footer.
 * ------------------------------------------------------------------
 */

import { api } from '../lib/api';
import { keys, useThread } from '../lib/data';
import { queryClient } from '../lib/query';
import type { ThreadView } from '../lib/types';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { BarLabel, Tip } from '../ui/primitives';

/** Turn extended thinking on or off for the thread. */
export async function setThinking(threadId: string, thinking: boolean): Promise<boolean> {
  try {
    await api.patch(`/threads/${threadId}`, { thinking });
    queryClient.setQueryData<ThreadView>(keys.thread(threadId), (t) => (t ? { ...t, thinking } : t));
    void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
    return true;
  } catch {
    notify({
      level: 'error',
      title: "Thinking didn't reach Core",
      body: 'Nothing changed. Check that NVX Ancile is running, then try again.',
    });
    return false;
  }
}

export function ThinkingChip({ threadId }: { threadId: string }) {
  const on = useThread(threadId).data?.thinking === true;
  const word = on ? 'On' : 'Off';
  const said = `Thinking: ${word.toLowerCase()}`;
  const items: MenuEntry[] = [
    { kind: 'label', label: 'Let the model think before it answers' },
    { label: 'On', icon: on ? 'check' : undefined, onSelect: () => void setThinking(threadId, true) },
    { label: 'Off', icon: on ? undefined : 'check', onSelect: () => void setThinking(threadId, false) },
    { kind: 'separator' },
    { kind: 'label', label: 'Changing this re-reads the conversation on the next turn' },
  ];
  return (
    <DropMenu
      align="start"
      side="top"
      items={items}
      trigger={
        <Tip label={said}>
          <button
            type="button"
            className="effort-chip"
            data-set={on || undefined}
            data-tour="thinking-chip"
            aria-label={`${said}. Change`}
          >
            <Icon name="sparkle" size={12} />
            <BarLabel full={`Thinking: ${word}`} short="Thinking" />
          </button>
        </Tip>
      }
    />
  );
}
