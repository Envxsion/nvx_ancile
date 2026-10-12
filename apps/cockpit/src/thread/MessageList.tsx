/**
 * ------------------------------------------------------------------
 *  Title    |  The conversation list
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every loaded message of the path, in order, costing
 *           |  only what is near the screen.
 *  How      |  Each row is a LazyRow: the last few, anything live and
 *           |  the message jumped to are drawn at once; the rest as
 *           |  plain text until they come near (LazyRow.tsx). Rows are
 *           |  memoised on the message object, which React Query keeps
 *           |  the same while the message is unchanged, so a streaming
 *           |  answer re-renders itself and not the thread.
 * ------------------------------------------------------------------
 */

import type { RefObject } from 'react';
import { CcEventRow } from '../claudecode/ThreadMarker';
import type { LiveTurn } from '../lib/run';
import type { MessageView } from '../lib/types';
import { LazyRoot, LazyRow } from './LazyRow';
import { Message } from './Message';
import { ToolCwd } from './ToolSteps';

/** Messages at the end that are always drawn in full (where you read and where it streams). */
export const EAGER_TAIL = 6;

export function MessageList({
  messages,
  threadId,
  turns,
  selected,
  onSelect,
  jumpTo,
  cwd,
  scroller,
}: {
  messages: MessageView[];
  threadId: string;
  turns: Record<string, LiveTurn>;
  selected: string | null;
  onSelect: (id: string) => void;
  jumpTo: string | null;
  cwd: string | null;
  scroller: RefObject<HTMLElement | null>;
}) {
  const eagerFrom = messages.length - EAGER_TAIL;
  return (
    <LazyRoot scroller={scroller}>
      <ToolCwd.Provider value={cwd}>
        <ol className="thread__messages" aria-label="Conversation">
          {messages.map((m, i) => {
            // Tool results already drawn in the answer before them.
            if (m.folded) return null;
            // Claude Code's commands, notices and compactions: quiet rows, not bubbles.
            if (m.cc)
              return (
                <li key={m.id} data-mid={m.id} data-cc={m.cc.kind}>
                  <CcEventRow e={m.cc} />
                </li>
              );
            const live = turns[m.id];
            const waiting = !!live && !live.done && (!!live.approvalId || live.status === 'waiting_approval');
            const eager =
              i >= eagerFrom ||
              !!live ||
              m.status === 'streaming' ||
              m.status === 'pending' ||
              selected === m.id ||
              jumpTo === m.id;
            return (
              <li key={m.id} data-mid={m.id}>
                <LazyRow m={m} eager={eager}>
                  {() => (
                    <Message
                      m={m}
                      threadId={threadId}
                      selected={selected === m.id}
                      onSelect={onSelect}
                      waiting={waiting}
                      liveModelName={live?.modelName ?? null}
                      approvalId={live?.approvalId ?? null}
                    />
                  )}
                </LazyRow>
              </li>
            );
          })}
        </ol>
      </ToolCwd.Provider>
    </LazyRoot>
  );
}
