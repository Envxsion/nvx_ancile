/**
 * ------------------------------------------------------------------
 *  Title    |  "Your plan can answer this"
 *  Ref      |  docs/claude-code.md (Plan or key) · roadmap MD3 (GR12)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When a thread's model bills an Anthropic API key per
 *           |  use and the same Claude line is ready on your Claude
 *           |  plan, say so once and let the owner choose.
 *  How      |  One line above the composer with two buttons: "Use my
 *           |  plan" switches this thread to the matching Claude Code
 *           |  model through the picker's own chooseModel; "Keep the
 *           |  API key" dismisses. Either answer is remembered for the
 *           |  thread (state/ui.ts planNoticeDone), so it never comes
 *           |  back for that thread.
 *  Note     |  Nothing is ever switched automatically.
 * ------------------------------------------------------------------
 */

import { AnimatePresence, m as motion } from 'motion/react';
import { useModels } from '../lib/data';
import { chooseModel, useCurrentModel } from '../lib/models';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { billingWords, planTwinOf } from './billing';
import '../styles/cclive.css';

const rise = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4, transition: { duration: 0.12 } },
};

export function PlanNotice({ threadId }: { threadId: string }) {
  const done = useUi((s) => !!s.planNoticeDone[threadId]);
  const dismiss = useUi((s) => s.dismissPlanNotice);
  const models = useModels().data ?? [];
  const current = useCurrentModel(threadId);
  const twin = done ? null : planTwinOf(current, models);
  return (
    <AnimatePresence initial={false}>
      {twin && current && twin.billing ? (
        <motion.div key="plan" className="cc-notice" data-kind="plan_choice" role="status" {...rise}>
          <Icon name="key" size={14} className="cc-notice__icon" />
          <div className="cc-notice__text">
            <p>
              <strong>{current.name} bills your Anthropic API key per use.</strong>{' '}
              {billingWords(twin.billing)} can answer this as Claude Code, which uses its own tools instead of
              this notebook's.
            </p>
          </div>
          <div className="cc-notice__acts">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                dismiss(threadId);
                void chooseModel(twin, threadId);
              }}
            >
              Use my plan
            </button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => dismiss(threadId)}>
              Keep the API key
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
