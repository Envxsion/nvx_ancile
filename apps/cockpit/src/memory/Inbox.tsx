/**
 * ------------------------------------------------------------------
 *  Title    |  Memory inbox
 *  Ref      |  DESIGN.md §6.3 (apply policy)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What NVX Ancile would like to remember but was not sure
 *           |  enough to keep on its own, and anything that came from
 *           |  tool or source content (which is never kept without
 *           |  you). Approve, reword, or turn it down.
 *  How      |  One card per proposal. With a card focused: A keeps it,
 *           |  E rewords it, R turns it down, J and K move. Below the
 *           |  waiting ones, what was kept on its own lately, each with
 *           |  Undo.
 * ------------------------------------------------------------------
 */

import type { MemoryProposal } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { type KeyboardEvent, useRef, useState } from 'react';
import { relative } from '../lib/format';
import { Icon } from '../ui/Icon';
import { EmptyState, Skeleton } from '../ui/primitives';
import { useDecide, useMemoryUi, useProposals } from './api';

const KIND: Record<MemoryProposal['kind'], string> = {
  preference: 'A preference',
  failure_lesson: 'A lesson',
  project_finding: 'A finding',
  model_quirk: 'A model quirk',
  manual: 'An entry',
};

const OP: Record<MemoryProposal['op'], string> = {
  add: 'Add',
  update: 'Reword',
  supersede: 'Replace',
};

const where = (path: string) =>
  path === 'USER.md' ? 'About you' : path === 'AGENTS.md' ? 'House rules' : path.replace(/\.md$/, '');

function Card({ p, onMove }: { p: MemoryProposal; onMove: (d: 1 | -1) => void }) {
  const decide = useDecide();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.text);
  const [leaving, setLeaving] = useState<'kept' | 'dropped' | null>(null);
  const thread = p.evidence.find((e) => e.thread_id)?.thread_id;
  const quote = p.evidence.find((e) => e.quote)?.quote;
  const untrusted = p.provenance === 'tool_output' || p.provenance === 'source_content';

  const act = (decision: 'approve' | 'reject') => {
    setLeaving(decision === 'approve' ? 'kept' : 'dropped');
    decide.mutate(
      { id: p.id, decision, ...(decision === 'approve' && text.trim() !== p.text && { text: text.trim() }) },
      { onError: () => setLeaving(null) },
    );
  };

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (editing || e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'a') act('approve');
    else if (k === 'r') act('reject');
    else if (k === 'e') setEditing(true);
    else if (k === 'j' || e.key === 'ArrowDown') onMove(1);
    else if (k === 'k' || e.key === 'ArrowUp') onMove(-1);
    else return;
    e.preventDefault();
  };

  return (
    <li
      className="mem-card"
      data-leaving={leaving ?? undefined}
      data-untrusted={untrusted || undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable card with its own shortcuts (A, E, R)
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`${KIND[p.kind]} for ${where(p.target_path)}: ${p.text}`}
    >
      <header className="mem-card__head">
        <span className="mem-card__kind">
          {OP[p.op]} · {KIND[p.kind].toLowerCase()}
        </span>
        <span className="mem-card__where">
          <Icon name="memory" size={12} />
          {where(p.target_path)}
          {p.section ? <span className="mute"> / {p.section}</span> : null}
        </span>
        <time className="mute" dateTime={p.created_at}>
          {relative(p.created_at)}
        </time>
      </header>

      {editing ? (
        <textarea
          className="input mem-card__edit"
          value={text}
          rows={2}
          // biome-ignore lint/a11y/noAutofocus: the reword field opens because the person asked for it
          autoFocus
          aria-label="Reword the entry"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              act('approve');
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setText(p.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <p className="mem-card__text">{text.replace(/\*\*/g, '')}</p>
      )}

      {p.target_text && p.op !== 'add' ? (
        <p className="mem-card__was">
          <span className="mute">{p.op === 'supersede' ? 'Replaces' : 'Was'}:</span> <s>{p.target_text}</s>
        </p>
      ) : null}

      <div className="mem-card__why">
        <span className="mem-conf" title={`Confidence ${Math.round(p.confidence * 100)}%`}>
          <span className="mem-conf__fill" style={{ width: `${Math.round(p.confidence * 100)}%` }} />
        </span>
        <span className="mute">{p.rationale}</span>
        {untrusted ? (
          <span className="mem-card__flag">
            <Icon name="lock" size={11} />
            From {p.provenance === 'tool_output' ? 'a tool' : 'a source'}, so it waits for you
          </span>
        ) : null}
      </div>

      {quote ? <blockquote className="mem-card__quote">{quote}</blockquote> : null}

      <footer className="mem-card__actions">
        {thread ? (
          <Link to="/t/$threadId" params={{ threadId: thread }} className="link-btn link-btn--quiet">
            Open the thread
          </Link>
        ) : (
          <span />
        )}
        <span className="mem-card__buttons">
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => act('reject')}>
            Not this <kbd>R</kbd>
          </button>
          {editing ? null : (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>
              Reword <kbd>E</kbd>
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!text.trim()}
            data-busy={(decide.isPending && leaving === 'kept') || undefined}
            onClick={() => act('approve')}
          >
            Remember <kbd>A</kbd>
          </button>
        </span>
      </footer>
    </li>
  );
}

function Kept({ p }: { p: MemoryProposal }) {
  const decide = useDecide();
  const open = useMemoryUi((s) => s.open);
  return (
    <li className="mem-kept" data-status={p.status}>
      <Icon name={p.status === 'undone' ? 'undo' : 'seal'} size={13} className="mem-kept__icon" />
      <button type="button" className="mem-kept__text" onClick={() => open(p.target_path)}>
        {p.text.replace(/\*\*/g, '')}
      </button>
      <span className="mute mem-kept__where">{where(p.target_path)}</span>
      <time className="mute" dateTime={p.decided_at ?? p.created_at}>
        {relative(p.decided_at ?? p.created_at)}
      </time>
      {p.status === 'auto_applied' || p.status === 'applied' ? (
        <button
          type="button"
          className="link-btn link-btn--quiet"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ id: p.id, decision: 'undo' })}
        >
          Undo
        </button>
      ) : (
        <span className="mute">{p.status === 'undone' ? 'Undone' : 'Turned down'}</span>
      )}
    </li>
  );
}

export function Inbox() {
  const proposals = useProposals();
  const list = useRef<HTMLOListElement>(null);
  if (proposals.isPending) return <Skeleton lines={4} label="Loading the inbox" />;
  const items = proposals.data?.items ?? [];
  const waiting = items.filter((p) => p.status === 'proposed');
  const done = items.filter((p) => p.status !== 'proposed').slice(0, 20);

  const move = (from: number) => (d: 1 | -1) => {
    const cards = list.current?.querySelectorAll<HTMLElement>('.mem-card');
    cards?.[Math.max(0, Math.min(cards.length - 1, from + d))]?.focus();
  };

  return (
    <div className="mem-inbox">
      {waiting.length ? (
        <ol className="mem-inbox__list" ref={list}>
          {waiting.map((p, i) => (
            <Card key={p.id} p={p} onMove={move(i)} />
          ))}
        </ol>
      ) : (
        <EmptyState
          icon="inbox"
          title="Nothing waiting"
          body="When NVX Ancile is not sure something is worth keeping, it asks here first. Anything from a tool or a source always does."
        />
      )}
      {done.length ? (
        <section className="mem-inbox__done">
          <h3 className="mem-files__h">
            <Icon name="seal" size={12} />
            Lately
          </h3>
          <ul>
            {done.map((p) => (
              <Kept key={p.id} p={p} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
