/**
 * ------------------------------------------------------------------
 *  Title    |  "Re-reads 84k tokens: about $0.25"
 *  Ref      |  ROADMAP.md CA12
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Before a long thread moves to a model that does not have
 *           |  it cached, say once what that re-read costs. A price tag,
 *           |  not a gate: nothing is blocked and nothing asks.
 *  How      |  One quiet line above the composer with a small close. It
 *           |  shows when the model chosen for the next turn is not the
 *           |  one that answered last, is cold for this thread, and the
 *           |  thread is long enough to matter. Closing it hides it for
 *           |  that thread and model. It goes by itself once a turn is
 *           |  sent, because that model is warm then.
 *  Note     |  Estimates. Hidden for Claude Code threads (no gateway cache).
 * ------------------------------------------------------------------
 */

import { AnimatePresence, motion } from 'motion/react';
import { useThread } from '../lib/data';
import { useCurrentModel } from '../lib/models';
import { Icon } from '../ui/Icon';
import { useSwitchCost, useSwitchCostDismissed } from './cacheState';
import '../styles/cache.css';

const rise = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

export function SwitchCostNotice({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  const model = useCurrentModel(threadId);
  const closed = useSwitchCostDismissed((s) => s.closed);
  const dismiss = useSwitchCostDismissed((s) => s.dismiss);
  const lastAnswer = [...(thread.data?.messages ?? [])].reverse().find((m) => m.role === 'assistant');
  const same = !!model && !!lastAnswer && lastAnswer.modelId === model.id;
  const hidden = !model || !lastAnswer || same || !!closed[`${threadId}|${model.id}`];
  const cost = useSwitchCost(threadId, model?.id, !hidden);
  const line = hidden || !model ? null : (cost?.line ?? null);
  return (
    <AnimatePresence initial={false}>
      {line && model ? (
        <motion.div
          key={model.id}
          className="switch-cost"
          role="status"
          title={
            cost?.guess
              ? 'An estimate. This provider does not report cache use, so the figure is a guess.'
              : 'An estimate from this thread so far. It is a price tag, not a limit.'
          }
          {...rise}
        >
          <span className="switch-cost__text">{line}</span>
          <button
            type="button"
            className="switch-cost__close"
            aria-label={`Hide this note for ${model.name}`}
            onClick={() => dismiss(threadId, model.id)}
          >
            <Icon name="close" size={12} />
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
