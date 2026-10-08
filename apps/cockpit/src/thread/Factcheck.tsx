/**
 * ------------------------------------------------------------------
 *  Title    |  An answer's fact-check, at a glance
 *  Ref      |  DESIGN.md §10.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One chip under the answer that says how it held up:
 *           |  while checking, which stage and how many claims; when
 *           |  done, the score as a ring and the verdicts in words; a
 *           |  fully verified answer wears the gilt seal.
 *  How      |  The chip opens the Evidence panel on this answer. Its
 *           |  card (hover or focus) gives the breakdown in words,
 *           |  from Core, so the numbers and the sentence agree.
 * ------------------------------------------------------------------
 */

import type { Factcheck } from '@nvx/contracts';
import * as HoverCard from '@radix-ui/react-hover-card';
import { type FactcheckProgress, startFactcheck } from '../lib/factcheck';
import { percent } from '../lib/format';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { ScoreRing } from './Claims';

const STAGE: Record<FactcheckProgress['stage'], string> = {
  starting: 'Starting the fact-check',
  extracting: 'Finding the claims',
  gathering: 'Searching your sources',
  verifying: 'Checking claims',
  done: 'Checked',
  failed: 'The fact-check stopped',
};

function level(c: number | null): 'high' | 'mid' | 'low' | 'none' {
  if (c === null) return 'none';
  return c >= 0.75 ? 'high' : c >= 0.5 ? 'mid' : 'low';
}

export function FactcheckChip({
  messageId,
  factcheck,
  progress,
}: {
  messageId: string;
  factcheck: Factcheck | null | undefined;
  progress: FactcheckProgress | undefined;
}) {
  const showEvidence = useUi((s) => s.showEvidence);

  if (progress && progress.stage !== 'done' && progress.stage !== 'failed') {
    const frac = progress.total ? progress.done / progress.total : 0;
    return (
      <span className="fc-chip" data-state="running" role="status" aria-live="polite">
        <ScoreRing value={progress.stage === 'verifying' ? frac : 0.12} />
        <span>{STAGE[progress.stage]}</span>
        {progress.stage === 'verifying' && progress.total ? (
          <span data-num className="mute">
            {progress.done} of {progress.total}
          </span>
        ) : null}
      </span>
    );
  }
  if (!factcheck) return null;
  if (factcheck.status === 'running')
    return (
      <span className="fc-chip" data-state="running" role="status">
        <ScoreRing value={0.12} />
        <span>Checking claims</span>
      </span>
    );
  if (factcheck.status === 'failed')
    return (
      <span className="fc-chip" data-state="failed">
        <Icon name="warn" size={12} />
        <span>{factcheck.error?.title ?? STAGE.failed}</span>
        <button type="button" className="link-btn" onClick={() => void startFactcheck(messageId)}>
          Try again
        </button>
      </span>
    );

  const { verified, unverified, contradicted } = factcheck.counts;
  const checkable = verified + unverified + contradicted;
  const label = factcheck.sealed
    ? 'Every claim verified'
    : checkable === 0
      ? 'Nothing to check'
      : contradicted
        ? `${contradicted} contradicted`
        : `${verified} of ${checkable} verified`;
  return (
    <HoverCard.Root openDelay={250} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          className="fc-chip"
          data-state="done"
          data-level={level(factcheck.confidence)}
          data-sealed={factcheck.sealed || undefined}
          onClick={() => showEvidence(messageId)}
          aria-label={`Fact-check: ${factcheck.summary} Open the evidence.`}
        >
          {factcheck.sealed ? (
            <span className="fc-chip__seal gilt-ink" aria-hidden="true">
              <Icon name="seal" size={13} />
            </span>
          ) : (
            <ScoreRing value={factcheck.confidence ?? 0} />
          )}
          {factcheck.confidence !== null ? <span data-num>{percent(factcheck.confidence)}</span> : null}
          <span>{label}</span>
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content className="fc-card" side="top" align="start" sideOffset={8} collisionPadding={12}>
          <p className="fc-card__summary">{factcheck.summary}</p>
          <ul className="fc-card__counts">
            <li data-verdict="verified">
              <span data-num>{verified}</span> verified
            </li>
            <li data-verdict="unverified">
              <span data-num>{unverified}</span> unverified
            </li>
            <li data-verdict="contradicted">
              <span data-num>{contradicted}</span> contradicted
            </li>
          </ul>
          <p className="fc-card__how">
            Each claim is scored on how well your sources support it, whether a second model agrees, and how
            closely the passages found match it. Click for the evidence.
          </p>
          <HoverCard.Arrow className="hint-pop__arrow" width={12} height={6} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
