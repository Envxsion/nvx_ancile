/**
 * ------------------------------------------------------------------
 *  Title    |  Evidence
 *  Ref      |  DESIGN.md §10.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Each checked claim with the evidence for and against,
 *           |  contradictions first, so the warning is unmissable.
 *  How      |  Shows the fact-check of the answer chosen (a claim or
 *           |  the score chip under it), else the latest answer in the
 *           |  thread. Clicking an underlined claim focuses it here.
 *           |  Verdicts carry an icon and a word as well as a colour
 *           |  (DESIGN.md §10). Demo data keeps its own sample.
 * ------------------------------------------------------------------
 */

import type { ClaimVerdict, FactcheckClaim } from '@nvx/contracts';
import { useParams } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import * as demo from '../fixtures/demo';
import { useThread } from '../lib/data';
import { startFactcheck, useFactcheck, useProgress } from '../lib/factcheck';
import { modelName, percent } from '../lib/format';
import { useUi } from '../state/ui';
import { EvidenceList, ScoreRing, VerdictMark } from '../thread/Claims';
import { FactcheckChip } from '../thread/Factcheck';
import { Icon } from '../ui/Icon';
import { EmptyState, Skeleton } from '../ui/primitives';

const ORDER: Record<ClaimVerdict, number> = { contradicted: 0, unverified: 1, verified: 2, not_checkable: 3 };

function DemoEvidence() {
  const focused = useUi((s) => s.focusedClaim);
  const claims = [...demo.evidence].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);
  return (
    <div className="panel">
      <div className="panel__bar">
        <span className="mute">
          Checked by <strong>Gemini 3 Pro</strong>, a different model family from the one that answered
        </span>
      </div>
      <ul className="evidence">
        {claims.map((c) => (
          <li
            key={c.claimId}
            className="claim-card"
            data-verdict={c.verdict}
            data-claim={c.claimId}
            data-focused={focused === c.claimId || undefined}
          >
            <div className="claim-card__head">
              <VerdictMark verdict={c.verdict} />
              <span data-num className="claim-card__conf" title="Confidence">
                {percent(c.confidence)}
              </span>
            </div>
            <p className="claim-card__claim">{c.claim}</p>
            <ul className="claim-card__quotes">
              {c.support.map((s) => (
                <li key={s.quote} data-stance={s.stance}>
                  <span className="claim-card__stance">
                    {s.stance === 'supports' ? 'Supports' : 'Contradicts'}
                  </span>
                  <blockquote>{s.quote}</blockquote>
                  <cite>{s.source}</cite>
                </li>
              ))}
            </ul>
            <p className="claim-card__why">{c.rationale}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClaimCard({ c, focused }: { c: FactcheckClaim; focused: boolean }) {
  return (
    <li className="claim-card" data-verdict={c.verdict} data-claim={c.id} data-focused={focused || undefined}>
      <div className="claim-card__head">
        <VerdictMark verdict={c.verdict} />
        {c.verdict !== 'not_checkable' ? (
          <span data-num className="claim-card__conf" title={c.explanation}>
            <ScoreRing value={c.confidence} size={14} /> {percent(c.confidence)}
          </span>
        ) : null}
      </div>
      <p className="claim-card__claim">{c.text}</p>
      {c.verdict !== 'not_checkable' ? <EvidenceList claim={c} /> : null}
      {c.rationale ? <p className="claim-card__why">{c.rationale}</p> : null}
      {c.verdict !== 'not_checkable' ? <p className="claim-card__score">{c.explanation}</p> : null}
    </li>
  );
}

export function EvidencePanel() {
  const isDemo = useUi((s) => s.demo);
  const focused = useUi((s) => s.focusedClaim);
  const chosen = useUi((s) => s.evidenceMessage);
  const params = useParams({ strict: false }) as { threadId?: string };
  const thread = useThread(params.threadId);
  const ref = useRef<HTMLUListElement>(null);

  const answers = (thread.data?.messages ?? []).filter((m) => m.role === 'assistant');
  const inThread = answers.find((a) => a.id === chosen);
  const m = inThread ?? [...answers].reverse().find((a) => a.provenance?.factcheck) ?? answers.at(-1) ?? null;
  const progress = useProgress(m?.id ?? '');
  const fc = useFactcheck(m?.id, !isDemo && !!m);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the claims arrive too
  useEffect(() => {
    if (focused)
      ref.current
        ?.querySelector(`[data-claim="${focused}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused, fc.data]);

  if (isDemo) return <DemoEvidence />;
  if (!m)
    return (
      <EmptyState
        icon="factcheck"
        title="Evidence"
        body="Ask something, then fact-check the answer to see each claim against your sources."
      />
    );
  if (fc.isPending) return <Skeleton lines={4} label="Loading the fact-check" />;

  const f = fc.data;
  if (!f || (f.status === 'running' && !f.claims.length) || progress) {
    const running = !!progress || f?.status === 'running';
    return running ? (
      <div className="panel evidence-wait">
        <FactcheckChip messageId={m.id} factcheck={f} progress={progress} />
        <Skeleton lines={5} label="Checking claims" />
      </div>
    ) : (
      <EmptyState
        icon="factcheck"
        title="Not fact-checked yet"
        body="Split this answer into claims and check each against your sources, with a second model as the judge."
        action={{
          label: 'Fact-check this answer',
          onClick: () => void startFactcheck(m.id),
          binding: 'message.factcheck',
        }}
      />
    );
  }

  const claims = [...f.claims].sort(
    (a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.char_start - b.char_start,
  );
  return (
    <div className="panel evidence-panel">
      <header className="evidence-head" data-sealed={f.sealed || undefined}>
        <div className="evidence-head__score">
          {f.sealed ? (
            <span className="evidence-head__seal gilt-ink" aria-hidden="true">
              <Icon name="seal" size={22} />
            </span>
          ) : (
            <ScoreRing value={f.confidence ?? 0} size={34} />
          )}
          <span className="evidence-head__pct" data-num>
            {f.confidence !== null ? percent(f.confidence) : 'n/a'}
          </span>
        </div>
        <p className="evidence-head__summary">{f.summary}</p>
        <p className="mute evidence-head__by">
          {f.verifier_model_id ? (
            <>
              Judged by <strong>{modelName(f.verifier_model_id)}</strong>
              {f.verifier_model_id !== m.modelId ? ', a different model from the one that answered.' : '.'}
            </>
          ) : (
            'No claim needed a judge.'
          )}{' '}
          <button type="button" className="link-btn" onClick={() => void startFactcheck(m.id)}>
            Check again
          </button>
        </p>
      </header>
      {f.status === 'failed' ? (
        <p className="evidence-failed" role="alert">
          <Icon name="warn" size={14} />
          <span>
            <strong>{f.error?.title}</strong> {f.error?.hint}
          </span>
        </p>
      ) : null}
      <ul className="evidence" ref={ref}>
        {claims.map((c) => (
          <ClaimCard key={c.id} c={c} focused={focused === c.id} />
        ))}
      </ul>
    </div>
  );
}
