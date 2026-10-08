/**
 * ------------------------------------------------------------------
 *  Title    |  Message
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One turn of the conversation, with everything you can
 *           |  do to it one hover (or one key) away.
 *  How      |  User turns sit on a lifted plate, right-weighted; the
 *           |  assistant writes on the page itself at reading measure,
 *           |  so the answer, not the chrome, is the loudest thing.
 *           |  The footer carries model, fallback, confidence, cost.
 *  Note     |  Messages from Core render their parts (Parts.tsx);
 *           |  demo fixtures render hand-built blocks with claims.
 * ------------------------------------------------------------------
 */

import type { RetrievalTrace } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { type CSSProperties, memo, type ReactNode, useState } from 'react';
import { WakingNotice } from '../compute/WakingNotice';
import { useBinding } from '../keys/dispatch';
import { useFactcheck, useProgress } from '../lib/factcheck';
import { hueVar, modelById, modelName, percent, usd } from '../lib/format';
import { partsText, reasonWords } from '../lib/mappers';
import { editMessage, regenerate, showVersion, stopMessage } from '../lib/turns';
import type { Block, CitationView, MessageView, Span } from '../lib/types';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { CiteProvider } from './Citations';
import { Cite, Claim, ClaimsProvider } from './Claims';
import { FactcheckChip } from './Factcheck';
import { regenerateRoute } from './flowActions';
import { LabChanges } from './LabChanges';
import { MemoryTray } from './MemoryTray';
import { MessageActions } from './MessageActions';
import { Parts } from './Parts';
import { Teamwork } from './Teamwork';
import { useLiveTeam } from './teamworkState';

function renderSpans(spans: Span[], citations: CitationView[] | undefined): ReactNode[] {
  return spans.map((s, i) => {
    const key = `${i}-${s.text.slice(0, 8)}`;
    if (s.cite !== undefined)
      return <Cite key={key} marker={s.cite} citation={citations?.find((c) => c.marker === s.cite)} />;
    if (s.code) return <code key={key}>{s.text}</code>;
    if (s.claim)
      return (
        <Claim key={key} id={s.claim.id} verdict={s.claim.verdict}>
          {s.text}
        </Claim>
      );
    return <span key={key}>{s.text}</span>;
  });
}

function renderBlock(b: Block, i: number, citations: CitationView[] | undefined) {
  if (b.kind === 'h') return <h3 key={i}>{b.text}</h3>;
  if (b.kind === 'ul')
    return (
      <ul key={i}>
        {b.items.map((item, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: items are positional in a fixed answer
          <li key={j}>{renderSpans(item, citations)}</li>
        ))}
      </ul>
    );
  return <p key={i}>{renderSpans(b.spans, citations)}</p>;
}

/** Under a grounded answer: what it drew on, and the seal when every paragraph cites. */
function Grounding({ trace, onWhy }: { trace: RetrievalTrace; onWhy: () => void }) {
  const cited = trace.hits.filter((h) => h.cited);
  const sources = new Set(cited.map((h) => h.source_title));
  if (!trace.hits.length)
    return (
      <p className="grounding grounding--none">
        <Icon name="sources" size={12} />
        <span>No source in this notebook matched the question.</span>
      </p>
    );
  return (
    <button type="button" className="grounding" onClick={onWhy} data-sealed={trace.grounded || undefined}>
      {trace.grounded ? (
        <span className="grounding__seal gilt-ink" aria-hidden="true">
          <Icon name="seal" size={13} />
        </span>
      ) : (
        <Icon name="sources" size={12} />
      )}
      <span>
        {trace.grounded
          ? 'Every statement cited'
          : cited.length
            ? 'Partly from sources'
            : 'Not from the sources'}
        {cited.length
          ? ` · ${cited.length} ${cited.length === 1 ? 'passage' : 'passages'} from ${sources.size} ${sources.size === 1 ? 'source' : 'sources'}`
          : ''}
      </span>
      <span className="grounding__why">Why</span>
    </button>
  );
}

/** The way out of a failed answer: where to fix it, and trying again. */
function ErrorActions({ m, threadId }: { m: MessageView; threadId: string }) {
  if (!m.parts || !m.parentId) return null;
  const toModels = /Settings → Models/.test(m.error?.hint ?? '');
  const flow = m.provenance?.flow;
  return (
    <div className="msg__error-actions">
      {toModels ? (
        <Link to="/admin/$section" params={{ section: 'models' }} className="btn btn--primary btn--sm">
          Open Models
        </Link>
      ) : null}
      {flow?.flow_id ? (
        <Link to="/flows/$flowId" params={{ flowId: flow.flow_id }} className="btn btn--ghost btn--sm">
          Open the flow
        </Link>
      ) : null}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => void (flow ? regenerateRoute(threadId, m.id, 'again') : regenerate(threadId, m))}
      >
        Try again
      </button>
    </div>
  );
}

/** Where an answer's context came from, when that is not just this path. */
function ProvenanceMarks({ m }: { m: MessageView }) {
  const p = m.provenance;
  const merged = p?.merged_from;
  return (
    <>
      {p?.compaction ? (
        <span
          className="msg__mark"
          title={`Older messages were read as a summary: about ${(p.compaction.tokens_before - p.compaction.tokens_after).toLocaleString('en-GB')} tokens lighter.`}
        >
          <Icon name="zap" size={11} />
          {p.compaction.auto ? 'Compacted to fit' : 'Read a summary of earlier turns'}
        </span>
      ) : null}
      {merged ? (
        <span className="msg__mark" title="Copied into this thread by a merge.">
          <Icon name="merge" size={11} />
          {p?.synthesized
            ? 'Combined from two branches'
            : !Array.isArray(merged) && merged.side && merged.side !== 'shared'
              ? `From branch ${merged.side.toUpperCase()}`
              : 'From before the split'}
        </span>
      ) : null}
    </>
  );
}

/**
 * Memoised: while one answer streams, the thread re-renders on every token,
 * and without this every finished message re-parsed its markdown each time.
 */
export const Message = memo(function Message({
  m,
  threadId,
  selected,
  onSelect,
  waiting = false,
  liveModelName,
  approvalId = null,
}: {
  m: MessageView;
  threadId: string;
  selected: boolean;
  /** Called with this message's id; stable, so finished messages skip re-rendering. */
  onSelect: (id: string) => void;
  /** Paused on an approval right now. */
  waiting?: boolean;
  /** The writing model's name from the run, before the model list knows it. */
  liveModelName?: string | null;
  /** The approval this message is paused on, so Review opens exactly that one. */
  approvalId?: string | null;
}) {
  const model = modelById(m.modelId);
  const setApproval = useUi((s) => s.setApproval);
  // Pending (queued, not started yet) reads as writing: it shows the dots and
  // Stop, never "paused until you decide", which is only for approvals.
  const streaming = m.status === 'streaming' || m.status === 'pending';
  const unfinished = streaming;
  const name = model?.name ?? m.modelName ?? liveModelName ?? null;
  const sib = m.siblings;
  const demo = useUi((s) => s.demo);
  // Fetch a fact-check only for answers known to have one, or one starting now.
  const progress = useProgress(m.id);
  const checked = !demo && m.role === 'assistant' && (!!m.provenance?.factcheck || !!progress);
  const fc = useFactcheck(m.id, checked).data;
  const claims = fc?.status === 'done' ? fc.claims : undefined;
  const team = useLiveTeam(m.id);
  const flow = m.provenance?.flow;
  const hasText = (m.parts ?? []).some((p) => (p.type === 'text' && p.text) || p.type === 'tool_call');

  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState('');

  const go = (delta: number) => {
    const id = sib?.ids?.[sib.index - 1 + delta];
    if (id) void showVersion(threadId, id);
  };
  useBinding('sibling.prev', () => go(-1), selected && !!sib);
  useBinding('sibling.next', () => go(1), selected && !!sib);

  const startEdit = () => {
    setDraft(partsText(m.parts));
    setEditing(true);
  };

  const submitEdit = async () => {
    const text = draft.trim();
    if (!text || text === partsText(m.parts).trim()) return setEditing(false);
    if (await editMessage(threadId, m, text)) setEditing(false);
  };

  return (
    <article
      className="msg"
      data-role={m.role}
      data-selected={selected || undefined}
      data-status={m.status}
      aria-label={m.role === 'user' ? 'You' : (name ?? 'Assistant')}
      aria-busy={streaming || undefined}
      onFocus={() => onSelect(m.id)}
      onPointerDown={() => onSelect(m.id)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {m.role === 'assistant' || sib ? (
        <header className="msg__head">
          {m.role === 'assistant' && name ? (
            <span className="msg-model" style={{ '--hue': hueVar(model?.hue ?? 'chalk') } as CSSProperties}>
              {name}
            </span>
          ) : null}
          {sib ? (
            <span className="siblings" role="group" aria-label="Versions of this message">
              <button
                type="button"
                className="icon-btn icon-btn--xs"
                aria-label="Previous version"
                disabled={sib.index <= 1 || !sib.ids}
                onClick={() => go(-1)}
              >
                <Icon name="chevronLeft" size={12} />
              </button>
              <span data-num>
                {sib.index} / {sib.count}
              </span>
              <button
                type="button"
                className="icon-btn icon-btn--xs"
                aria-label="Next version"
                disabled={sib.index >= sib.count || !sib.ids}
                onClick={() => go(1)}
              >
                <Icon name="chevronRight" size={12} />
              </button>
            </span>
          ) : null}
        </header>
      ) : null}

      {m.role === 'assistant' && !demo && (m.provenance?.flow || team) ? (
        <Teamwork m={m} threadId={threadId} />
      ) : null}

      {m.role === 'assistant' && m.provenance?.retrieval && !streaming && m.status !== 'error' ? (
        <Grounding trace={m.provenance.retrieval} onWhy={() => useUi.getState().explain(m.id)} />
      ) : null}

      {m.role === 'assistant' && m.fallback && !streaming ? (
        <p
          className="msg__fallback"
          title="NVX Ancile switched models without interrupting you. Open Why for the details."
        >
          <Icon name="model" size={12} />
          <span>
            Answered by {modelName(m.modelId)} because {modelName(m.fallback.from)}{' '}
            {reasonWords(m.fallback.reason)}
          </span>
        </p>
      ) : null}

      {editing ? (
        <form
          className="msg__edit"
          onSubmit={(e) => {
            e.preventDefault();
            void submitEdit();
          }}
        >
          <label className="sr-only" htmlFor={`edit-${m.id}`}>
            Edit your message
          </label>
          <textarea
            id={`edit-${m.id}`}
            className="composer__input"
            value={draft}
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submitEdit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
            // biome-ignore lint/a11y/noAutofocus: the person just asked to edit this message
            autoFocus
          />
          <p className="msg__edit-note mute">
            Sending starts a new version. The original stays one click away.
          </p>
          <div className="msg__edit-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary btn--sm">
              Send edit
            </button>
          </div>
        </form>
      ) : null}

      <div className="msg__body" tabIndex={-1} hidden={editing} dir="auto">
        {m.parts ? (
          <CiteProvider parts={m.parts} trace={m.provenance?.retrieval}>
            <ClaimsProvider messageId={m.id} claims={claims}>
              <Parts parts={m.parts} streaming={streaming} waiting={waiting} claims={claims} />
            </ClaimsProvider>
          </CiteProvider>
        ) : (
          m.blocks.map((b, i) => renderBlock(b, i, m.citations))
        )}
        {streaming && !waiting && !hasText ? (
          <p className="msg__thinking">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {name ? `${name} is thinking` : 'Thinking'}
          </p>
        ) : null}
      </div>

      {streaming ? <WakingNotice messageId={m.id} /> : null}

      {waiting ? (
        <div className="msg__waiting">
          <Icon name="shield" size={14} />
          <span>Paused until you decide.</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => setApproval(true, approvalId)}
          >
            Review the request
          </button>
        </div>
      ) : null}

      {streaming && !waiting ? (
        <div className="msg__live">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void stopMessage(m.id)}>
            <Icon name="close" size={12} />
            Stop
          </button>
        </div>
      ) : null}

      {m.lab && !streaming ? (
        <LabChanges runId={m.lab.runId} undone={m.lab.undone} threadId={threadId} />
      ) : null}

      {m.role === 'assistant' && m.status === 'error' ? (
        <div className="msg__error" role="alert">
          <Icon name="warn" size={14} />
          <div>
            <p className="msg__error-title">{m.error?.title ?? 'This answer could not be finished'}</p>
            <p className="msg__error-hint">
              {m.error?.hint ?? 'Regenerate to try again, or pick another model.'}
            </p>
            <ErrorActions m={m} threadId={threadId} />
          </div>
        </div>
      ) : null}

      {m.role === 'assistant' &&
      !streaming &&
      (m.status === 'complete' || m.status === 'stopped' || m.status === undefined) ? (
        <footer className="msg__foot">
          {m.status === 'stopped' ? <span className="mute">Stopped</span> : null}
          <ProvenanceMarks m={m} />
          {flow ? (
            <button
              type="button"
              className="msg__route"
              title={`Answered by the flow "${flow.name}", version ${flow.version}. Open Why for the route.`}
              onClick={() => useUi.getState().explain(m.id)}
            >
              <Icon name="tree" size={11} />
              {flow.name} <span data-num>v{flow.version}</span>
            </button>
          ) : null}
          {checked ? <FactcheckChip messageId={m.id} factcheck={fc} progress={progress} /> : null}
          {!checked && m.confidence !== undefined ? (
            <span
              className="msg__conf"
              data-level={m.confidence >= 0.75 ? 'high' : m.confidence >= 0.5 ? 'mid' : 'low'}
            >
              <Icon name="factcheck" size={12} />
              <span data-num>{percent(m.confidence)}</span> grounded
            </span>
          ) : null}
          {m.usage ? (
            <span className="mute" data-num>
              {m.usage.tokens.toLocaleString('en-GB')} tok · {usd(m.usage.costUsd, 3)}
              {m.usage.ms !== undefined ? ` · ${(m.usage.ms / 1000).toFixed(1)} s` : null}
            </span>
          ) : null}
        </footer>
      ) : null}

      {m.role === 'assistant' && (team || flow) ? (
        <MemoryTray
          runId={m.runId ?? null}
          startedAt={Date.parse(team?.startedAt ?? flow?.steps[0]?.started_at ?? m.createdAt) - 1_000}
          endedAt={streaming ? null : Date.parse(team?.startedAt ?? m.createdAt) + (team?.ms ?? 60_000)}
        />
      ) : null}

      <MessageActions
        message={m}
        threadId={threadId}
        visible={(selected || hovered) && !unfinished && !editing}
        armed={selected && !unfinished && !editing}
        onEdit={startEdit}
      />
    </article>
  );
});
