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
 *           |  While a check runs, each claim appears as it is found and
 *           |  fills in as its verdict lands, with the judge and the
 *           |  quotes (EV1); opened mid-check, it follows the run again.
 *           |  Highlighted claims that were checked (FC3) are listed under
 *           |  the claims, newest first; "Open in Evidence" on a card lands
 *           |  on its row. Evidence is marked Source or Web (FC4).
 * ------------------------------------------------------------------
 */

import type { ClaimVerdict, FactcheckClaim, SelectionCheck } from '@nvx/contracts';
import { isClaudeCodeModel } from '@nvx/contracts/engines';
import { useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import * as demo from '../fixtures/demo';
import { useThread } from '../lib/data';
import {
  type LiveClaim,
  resumeFactcheck,
  startFactcheck,
  useCheckChoice,
  useFactcheck,
  useLiveClaims,
  useProgress,
} from '../lib/factcheck';
import { modelName, percent } from '../lib/format';
import { scrollBehavior } from '../lib/motion';
import { copyText, costLine, followUpDraft, insertIntoComposer } from '../lib/selectionWords';
import { TIER_WORDS } from '../models/tier';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { EvidenceList, ScoreRing, VerdictMark } from '../thread/Claims';
import { FactcheckChip } from '../thread/Factcheck';
import { SelectionBody } from '../thread/SelectionBody';
import { Icon } from '../ui/Icon';
import { LoadFailed } from '../ui/LoadFailed';
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

/** How a claim was checked, for its tooltip: the tier, the model, a step up, and where routing settled for less. */
function checkWords(c: FactcheckClaim): string {
  const k = c.check;
  if (!k) return c.explanation;
  const parts = [c.explanation];
  if (k.cached) parts.push('Checked earlier; no model was asked now.');
  else if (k.tier_used)
    parts.push(
      `Checked by ${k.model_id ? modelName(k.model_id) : 'a model'} (${TIER_WORDS[k.tier_used].toLowerCase()} tier).`,
    );
  if (k.escalated_from)
    parts.push(`It started at ${TIER_WORDS[k.escalated_from].toLowerCase()} tier and was sent up.`);
  parts.push(...k.degraded);
  return parts.join(' ');
}

const dateWords = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function ClaimCard({
  c,
  focused,
  onRecheck,
}: {
  c: FactcheckClaim;
  focused: boolean;
  onRecheck?: () => void;
}) {
  return (
    <li className="claim-card" data-verdict={c.verdict} data-claim={c.id} data-focused={focused || undefined}>
      <div className="claim-card__head">
        <VerdictMark verdict={c.verdict} />
        {c.verdict !== 'not_checkable' ? (
          <span data-num className="claim-card__conf" title={checkWords(c)}>
            <ScoreRing value={c.confidence} size={14} /> {percent(c.confidence)}
          </span>
        ) : null}
      </div>
      <p className="claim-card__claim">{c.text}</p>
      {c.verdict !== 'not_checkable' ? <EvidenceList claim={c} /> : null}
      {c.rationale ? <p className="claim-card__why">{c.rationale}</p> : null}
      {c.verdict !== 'not_checkable' ? <p className="claim-card__score">{c.explanation}</p> : null}
      {c.check?.cached ? (
        <p className="claim-card__score">
          Checked earlier ({dateWords(c.check.cached.at)}
          {c.check.cached.model_id ? `, ${modelName(c.check.cached.model_id)}` : ''}).{' '}
          {onRecheck ? (
            <button type="button" className="link-btn" onClick={onRecheck}>
              Re-check
            </button>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

/** A claim of a check that is still running: found, then judged as its verdict lands (EV1). */
function LiveCard({ c }: { c: LiveClaim }) {
  const judged = c.verdict !== undefined;
  return (
    <li
      className="claim-card"
      data-verdict={c.verdict}
      data-live={judged ? 'judged' : 'found'}
      data-claim-index={c.index}
    >
      <div className="claim-card__head">
        {c.verdict ? (
          <VerdictMark verdict={c.verdict} />
        ) : (
          <span className="claim-card__wait" role="status">
            {c.checkable ? 'Checking' : 'Nothing to check'}
          </span>
        )}
      </div>
      <p className="claim-card__claim">{c.text}</p>
      {c.quotes?.length ? (
        <ul className="ev-quotes">
          {c.quotes.map((q) => (
            <li key={`${q.origin}-${q.source_title}-${q.quote}`} className="ev-quote" data-stance={q.stance}>
              <span className="ev-quote__stance">
                <span className="ev-quote__origin" data-origin={q.origin}>
                  {q.origin === 'web' ? 'Web' : 'Source'}
                </span>
                {q.stance === 'contradicts' ? 'Says otherwise' : 'Says'}
              </span>
              <blockquote>{q.quote}</blockquote>
              <span className="ev-quote__foot">
                <cite>{q.source_title}</cite>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {c.rationale ? <p className="claim-card__why">{c.rationale}</p> : null}
      {c.judge ? (
        <p className="claim-card__by">
          Judged by {modelName(c.judge)}
          {isClaudeCodeModel(c.judge) ? ', on your Claude plan' : ''}
        </p>
      ) : null}
    </li>
  );
}

const STAGE_WORDS: Record<string, string> = {
  starting: 'Starting the fact-check',
  extracting: 'Finding the claims in this answer',
  gathering: 'Searching your sources for each claim',
  verifying: 'Checking each claim',
};

/** The check as it runs: claims appear as they are found and fill in as each verdict lands. */
/**
 * A mission-critical check could not pick two independent checkers, so nothing ran. Every ready chat model
 * is listed, the writer's provider included; the ones it would pick are ticked (TR3, DESIGN D30).
 */
export function CheckChoice({ messageId }: { messageId: string }) {
  const choice = useCheckChoice((s) => s.byMessage[messageId]);
  const [picked, setPicked] = useState<string[] | null>(null);
  if (!choice) return null;
  const chosen = picked ?? choice.suggested;
  const toggle = (id: string) =>
    setPicked(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id].slice(-4));
  return (
    <div className="check-choice">
      <h2 className="check-choice__title">{choice.title}</h2>
      <p className="check-choice__hint">{choice.hint}</p>
      <ul className="check-choice__list">
        {choice.models.map((m) => (
          <li key={m.id}>
            <label className="check-choice__row" data-low={!m.suitable || undefined}>
              <input type="checkbox" checked={chosen.includes(m.id)} onChange={() => toggle(m.id)} />
              <span className="check-choice__name">{m.name}</span>
              <span className="mute">
                {TIER_WORDS[m.tier]}
                {m.same_family_as_writer ? ' · same provider as the writer' : ''}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="check-choice__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={chosen.length === 0}
          onClick={() => void startFactcheck(messageId, { critical: true, models: chosen })}
        >
          Check with these
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => useCheckChoice.getState().set(messageId, null)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Checking({
  messageId,
  f,
  progress,
}: {
  messageId: string;
  f: Parameters<typeof FactcheckChip>[0]['factcheck'];
  progress: Parameters<typeof FactcheckChip>[0]['progress'];
}) {
  const claims = useLiveClaims(messageId);
  return (
    <div className="panel evidence-wait">
      <FactcheckChip messageId={messageId} factcheck={f} progress={progress} />
      {claims.length ? (
        <ul className="evidence" aria-live="polite" aria-label="Claims found so far">
          {claims.map((c) => (
            <LiveCard key={c.index} c={c} />
          ))}
        </ul>
      ) : (
        <p className="claim-card__wait" role="status">
          {STAGE_WORDS[progress?.stage ?? 'starting'] ?? 'Checking claims'}
        </p>
      )}
    </div>
  );
}

/** A highlighted claim that was checked, as a row: the same words as its card. */
function CheckRow({
  c,
  focused,
  threadId,
}: {
  c: SelectionCheck;
  focused: boolean;
  threadId: string | undefined;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(c));
      notify({ level: 'success', title: 'Copied' });
    } catch {
      notify({ level: 'warn', title: 'Clipboard is blocked', body: 'Select the text and copy it by hand.' });
    }
  };
  return (
    <li className="selrow" data-check={c.id} data-focused={focused || undefined}>
      <SelectionBody c={c} compact />
      <div className="selrow__foot">
        <span data-num>{costLine(c)}</span>
        <span className="selcard__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy()}>
            <Icon name="copy" size={12} />
            Copy
          </button>
          {c.corrected && threadId ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                insertIntoComposer(threadId, followUpDraft(c.corrected ?? ''));
                notify({ level: 'info', title: 'Added to your message box', body: 'Nothing was sent.' });
              }}
            >
              Use the corrected claim
            </button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

/** The claims highlighted in this thread and checked, newest first (FC3). */
function HighlightedChecks({
  checks,
  focused,
  threadId,
}: {
  checks: SelectionCheck[];
  focused: string | null;
  threadId: string | undefined;
}) {
  const ref = useRef<HTMLUListElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a card sends you here
  useEffect(() => {
    if (focused)
      ref.current
        ?.querySelector(`[data-check="${focused}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  }, [focused, checks.length]);
  if (!checks.length) return null;
  return (
    <section aria-label="Highlighted claims">
      <h3 className="selrows__head">Highlighted claims</h3>
      <ul className="selrows" ref={ref}>
        {checks.map((c) => (
          <CheckRow key={c.id} c={c} focused={focused === c.id} threadId={threadId} />
        ))}
      </ul>
    </section>
  );
}

export function EvidencePanel() {
  const isDemo = useUi((s) => s.demo);
  const focused = useUi((s) => s.focusedClaim);
  const focusedCheck = useUi((s) => s.focusedCheck);
  const chosen = useUi((s) => s.evidenceMessage);
  const params = useParams({ strict: false }) as { threadId?: string };
  const thread = useThread(params.threadId);
  const ref = useRef<HTMLUListElement>(null);

  const answers = (thread.data?.messages ?? []).filter((m) => m.role === 'assistant' && !m.cc);
  const inThread = answers.find((a) => a.id === chosen);
  const m = inThread ?? [...answers].reverse().find((a) => a.provenance?.factcheck) ?? answers.at(-1) ?? null;
  const progress = useProgress(m?.id ?? '');
  const fc = useFactcheck(m?.id, !isDemo && !!m);
  // Highlighted claims checked anywhere in this thread, newest first.
  const checks = (thread.data?.messages ?? [])
    .flatMap((x) => x.provenance?.selection_checks ?? [])
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const highlighted = <HighlightedChecks checks={checks} focused={focusedCheck} threadId={params.threadId} />;

  // A check that is running but not being followed (the panel was closed, or the page reloaded) is followed again.
  const runId = fc.data?.status === 'running' ? fc.data.run_id : null;
  const checkedId = m?.id;
  useEffect(() => {
    if (checkedId && runId && !isDemo) resumeFactcheck(checkedId, runId);
  }, [checkedId, runId, isDemo]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the claims arrive too
  useEffect(() => {
    if (focused)
      ref.current
        ?.querySelector(`[data-claim="${focused}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  }, [focused, fc.data]);

  if (isDemo) return <DemoEvidence />;
  // The thread's answers come first: a thread still loading, or never loaded, is not "Ask something".
  if (params.threadId && thread.isPending) return <Skeleton lines={4} label="Loading the fact-check" />;
  if (params.threadId && thread.isError && !thread.data)
    return <LoadFailed error={thread.error} what="The thread" onRetry={() => thread.refetch()} />;
  if (!m)
    return (
      <EmptyState
        icon="factcheck"
        title="Evidence"
        body="Ask something, then fact-check the answer to see each claim against your sources."
      />
    );
  if (fc.isPending) return <Skeleton lines={4} label="Loading the fact-check" />;
  // null is "never checked" (404); undefined after an error is a read that failed, not an offer to check.
  if (fc.isError && fc.data === undefined && !progress)
    return <LoadFailed error={fc.error} what="The fact-check" onRetry={() => fc.refetch()} />;

  const f = fc.data;
  if (!f || (f.status === 'running' && !f.claims.length) || progress) {
    const running = !!progress || f?.status === 'running';
    return running ? (
      <>
        <Checking messageId={m.id} f={f} progress={progress} />
        {highlighted}
      </>
    ) : (
      <>
        <CheckChoice messageId={m.id} />
        <EmptyState
          icon="factcheck"
          title="Not fact-checked yet"
          body="Split this answer into claims and check each against your sources, with a second model as the judge. You can also highlight any words in a message and choose Fact-check."
          action={{
            label: 'Fact-check this answer',
            onClick: () => void startFactcheck(m.id),
            binding: 'message.factcheck',
          }}
        />
        {highlighted}
      </>
    );
  }

  const claims = [...f.claims].sort(
    (a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.char_start - b.char_start,
  );
  return (
    <div className="panel evidence-panel">
      <CheckChoice messageId={m.id} />
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
          {f.critical ? 'Mission-critical. ' : ''}
          {f.verifier_model_id ? (
            <>
              Judged by <strong>{modelName(f.verifier_model_id)}</strong>
              {f.verifier_model_id !== m.modelId ? ', a different model from the one that answered.' : '.'}
              {isClaudeCodeModel(f.verifier_model_id) ? ' Claude Code judges run on your Claude plan.' : ''}
            </>
          ) : f.status === 'failed' ? (
            // A check that stopped never reached a judge; "no claim needed one" would contradict it.
            'It stopped before a model judged the claims.'
          ) : f.claims.length ? (
            'No claim needed a judge: none could be checked against your sources.'
          ) : (
            'There were no claims to judge.'
          )}{' '}
          <button type="button" className="link-btn" onClick={() => void startFactcheck(m.id)}>
            {f.status === 'failed' ? 'Try again' : 'Check again'}
          </button>
          {f.status === 'done' && !f.scope.web && !f.scope.web_note ? (
            <>
              {' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => void startFactcheck(m.id, { web: true })}
              >
                Check again with the web
              </button>
            </>
          ) : null}
        </p>
        {f.scope.web_note ? (
          <p className="mute evidence-head__by">
            {f.scope.web_note}
            {f.scope.web_reason === 'none' ? (
              <>
                {' '}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => useUi.getState().setHelp(true, 'fact-checking')}
                >
                  Set up web search
                </button>
              </>
            ) : null}
          </p>
        ) : null}
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
          <ClaimCard
            key={c.id}
            c={c}
            focused={focused === c.id}
            onRecheck={() => void startFactcheck(m.id, { again: true })}
          />
        ))}
      </ul>
      {highlighted}
    </div>
  );
}
