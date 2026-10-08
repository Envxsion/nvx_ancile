/**
 * ------------------------------------------------------------------
 *  Title    |  Composer hints
 *  Ref      |  DESIGN.md §8.4, §8.5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Quiet chips just above the composer, only when they
 *           |  matter: this branch is filling the model's context
 *           |  (with Compact now), or your last message started a new
 *           |  topic (with a way to name that branch). Neither ever
 *           |  acts alone.
 *  How      |  The budget comes from /context-budget; the suggestion
 *           |  from a `suggestion` event held in useSuggestions. Chips
 *           |  rise in on a spring and leave when dismissed or used.
 * ------------------------------------------------------------------
 */

import { spring } from '@nvx/aperture';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { compactNow, nameBranch, useContextBudget, useSuggestions } from '../lib/branching';
import { percent } from '../lib/format';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';

export function ComposerHints({ threadId, headId }: { threadId: string; headId: string | null }) {
  const demo = useUi((s) => s.demo);
  const budget = useContextBudget(demo ? undefined : threadId);
  const suggestion = useSuggestions((s) => s.byThread[threadId]);
  const dismiss = useSuggestions((s) => s.dismiss);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);

  const b = budget.data;
  const full = b && b.level !== 'ok' && b.compactable > 0 && hidden !== b.head_id;
  const shift = suggestion && suggestion.messageId !== hidden ? suggestion : null;

  return (
    <div className="composer-hints" aria-live="polite">
      <AnimatePresence initial={false}>
        {full ? (
          <motion.div
            key="budget"
            className="hint-chip"
            data-level={b.level}
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
            transition={spring.smooth}
          >
            <span className="hint-chip__meter" aria-hidden="true">
              <span style={{ width: percent(Math.min(1, b.ratio)) }} />
            </span>
            <span>
              {b.level === 'critical'
                ? `This branch is ${percent(b.ratio)} of the model's context. It will be compacted before the next answer.`
                : `This branch is ${percent(b.ratio)} of the model's context.`}
            </span>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              data-busy={busy || undefined}
              onClick={async () => {
                setBusy(true);
                await compactNow(threadId, headId);
                setBusy(false);
              }}
            >
              <Icon name="zap" size={12} />
              Compact now
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--xs"
              aria-label="Hide this"
              onClick={() => setHidden(b.head_id)}
            >
              <Icon name="close" size={11} />
            </button>
          </motion.div>
        ) : null}
        {shift ? (
          <motion.div
            key="shift"
            className="hint-chip hint-chip--branch"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
            transition={spring.smooth}
          >
            <Icon name="branch" size={13} />
            <span>
              This looks like a new topic: <strong>{shift.title}</strong>
            </span>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              disabled={!headId}
              onClick={() => {
                dismiss(threadId);
                if (headId) void nameBranch(threadId, headId, shift.title);
              }}
            >
              Name it as a branch
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--xs"
              aria-label="Not now"
              onClick={() => {
                setHidden(shift.messageId);
                dismiss(threadId);
              }}
            >
              <Icon name="close" size={11} />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
