/**
 * ------------------------------------------------------------------
 *  Title    |  Saved to memory (under your message)
 *  Ref      |  ROADMAP M2 · DESIGN.md §6.3 · guard rail GR3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When you say "remember that..." or "never...", NVX
 *           |  Ancile keeps it at once. This is the note under your
 *           |  message that says so, with Undo, so a saved thing is
 *           |  never a surprise.
 *  How      |  Reads the proposals that were kept on their own from
 *           |  this message (same list as the memory inbox, one shared
 *           |  query). Undo reverts the memory commit. Anything that
 *           |  came from a tool or a source never appears here: those
 *           |  only ever wait in the inbox.
 * ------------------------------------------------------------------
 */

import { useDecide, useSavedFrom } from '../memory/api';
import { Icon } from '../ui/Icon';

/** A message Core has saved has an id like msg_...; a message still being sent does not. */
const saved = (id: string) => id.startsWith('msg_');

export function SavedNote({ messageId }: { messageId: string }) {
  const items = useSavedFrom(messageId, saved(messageId)).data ?? [];
  const decide = useDecide();
  if (!items.length) return null;
  return (
    <>
      {items.map((p) => (
        <p key={p.id} className="msg__saved" role="status">
          <Icon name="memory" size={12} />
          <span>Saved to memory</span>
          <span className="msg__saved-text mute" title={p.text}>
            {p.text.replace(/\*\*/g, '')}
          </span>
          <button
            type="button"
            className="link-btn link-btn--quiet"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: p.id, decision: 'undo' })}
          >
            Undo
          </button>
        </p>
      ))}
    </>
  );
}
