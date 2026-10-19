/**
 * ------------------------------------------------------------------
 *  Title    |  "This thread's context will be sent to Claude Code"
 *  Ref      |  docs/engines.md (Claude Code)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One quiet line above the composer when a turn sends
 *           |  some of the thread to Claude Code. Not a modal, not a
 *           |  toast: it says what happened and steps aside.
 *  How      |  Reads engines/notice.ts; the close button dismisses it
 *           |  until the next turn that shares context.
 * ------------------------------------------------------------------
 */

import { AnimatePresence, m as motion } from 'motion/react';
import { Icon } from '../ui/Icon';
import { useContextNotices } from './notice';

const rise = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4, transition: { duration: 0.12 } },
};

export function ContextNotice({ threadId }: { threadId: string }) {
  const notice = useContextNotices((s) => s.byThread[threadId]);
  const dismiss = useContextNotices((s) => s.dismiss);
  return (
    <AnimatePresence initial={false}>
      {notice ? (
        <motion.div key="ctx" className="hint-line ctx-notice" role="status" {...rise}>
          <Icon name="link" size={12} className="hint-line__icon" />
          <span className="hint-line__text">{notice.text}</span>
          <button
            type="button"
            className="icon-btn icon-btn--xs hint-line__close"
            aria-label="Dismiss this notice"
            onClick={() => dismiss(threadId)}
          >
            <Icon name="close" size={11} />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
