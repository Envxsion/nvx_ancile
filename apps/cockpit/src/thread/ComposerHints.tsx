/**
 * ------------------------------------------------------------------
 *  Title    |  Composer hints
 *  Ref      |  DESIGN.md §8.4, §8.5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One slim line on the composer's top edge, only when it
 *           |  matters: this branch is near or over the model's
 *           |  context (with Compact now), or your last message
 *           |  started a new topic (with a way to name that branch).
 *           |  Neither ever acts alone.
 *  How      |  The budget comes from /context-budget; the suggestion
 *           |  from a `suggestion` event held in useSuggestions. A
 *           |  line slides up out of the composer and leaves when
 *           |  dismissed or used. With reduced motion (the in-app
 *           |  setting, through MotionPrefs) it fades instead.
 *  Note     |  Threads from Claude Code get no estimate: Claude Code
 *           |  manages its own context, and its own count shows in
 *           |  the status line instead (claudecode/LiveBar.tsx).
 * ------------------------------------------------------------------
 */

import type { PathBudget } from '@nvx/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { compactNow, nameBranch, useContextBudget, useSuggestions } from '../lib/branching';
import { percent } from '../lib/format';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';

/** What the context line says, and how its meter reads. */
export function budgetWords(b: Pick<PathBudget, 'ratio' | 'level'>): {
  text: string;
  tone: 'over' | 'high' | 'calm';
  fill: number;
  title: string;
} {
  const fill = Math.max(0, Math.min(1, b.ratio));
  if (b.ratio >= 1)
    return {
      text: 'Over the context limit: compacts before the next answer',
      tone: 'over',
      fill,
      title: "This branch is longer than the model's context.",
    };
  if (b.level === 'critical')
    return {
      text: 'At the context limit: compacts before the next answer',
      tone: 'high',
      fill,
      title: `This branch fills ${percent(fill)} of the model's context.`,
    };
  return {
    text: 'Near the context limit',
    tone: b.level === 'warn' ? 'high' : 'calm',
    fill,
    title: `This branch fills ${percent(fill)} of the model's context.`,
  };
}

const rise = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6, transition: { duration: 0.12 } },
  transition: { duration: 0.2, ease: [0.2, 0.8, 0.2, 1] as const },
};

export function ComposerHints({
  threadId,
  headId,
  fromClaudeCode,
}: {
  threadId: string;
  headId: string | null;
  /** The thread mirrors a Claude Code session; null while the thread is loading. */
  fromClaudeCode: boolean | null;
}) {
  const demo = useUi((s) => s.demo);
  const budget = useContextBudget(demo || fromClaudeCode !== false ? undefined : threadId);
  const suggestion = useSuggestions((s) => s.byThread[threadId]);
  const dismiss = useSuggestions((s) => s.dismiss);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);

  const b = fromClaudeCode === false ? budget.data : undefined;
  const full = b && b.level !== 'ok' && b.compactable > 0 && hidden !== b.head_id;
  const shift = suggestion && suggestion.messageId !== hidden ? suggestion : null;
  const words = full ? budgetWords(b) : null;

  return (
    <div className="composer-hints" aria-live="polite">
      <AnimatePresence initial={false}>
        {full && words ? (
          <motion.div key="budget" className="hint-line" data-tone={words.tone} {...rise}>
            <span
              className="hint-line__meter"
              role="meter"
              aria-label="Context used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(words.fill * 100)}
              aria-valuetext={words.tone === 'over' ? 'Over the limit' : percent(words.fill)}
              title={words.title}
            >
              <span style={{ transform: `scaleX(${words.fill})` }} />
            </span>
            <span className="hint-line__text" title={words.title}>
              {words.text}
            </span>
            <button
              type="button"
              className="hint-line__act"
              data-busy={busy || undefined}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await compactNow(threadId, headId);
                setBusy(false);
              }}
            >
              Compact now
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--xs hint-line__close"
              aria-label="Hide the context warning"
              onClick={() => setHidden(b.head_id)}
            >
              <Icon name="close" size={11} />
            </button>
          </motion.div>
        ) : null}
        {shift ? (
          <motion.div key="shift" className="hint-line" data-kind="branch" {...rise}>
            <Icon name="branch" size={12} className="hint-line__icon" />
            <span className="hint-line__text">
              New topic: <strong>{shift.title}</strong>
            </span>
            <button
              type="button"
              className="hint-line__act"
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
              className="icon-btn icon-btn--xs hint-line__close"
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
