/**
 * ------------------------------------------------------------------
 *  Title    |  Memory inbox
 *  Ref      |  DESIGN.md §6.3 (apply policy)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What NVX Ancile would like to remember but was not sure
 *           |  enough to keep on its own, and anything that came from
 *           |  tool or source content (which is never kept without
 *           |  you). Approve, reword, or turn it down. Each card says
 *           |  why: how sure, the words it learned from, and a link to
 *           |  the turn (M3); and where to keep it (M1).
 *  How      |  One card per proposal. With a card focused: A keeps it,
 *           |  E rewords it, R turns it down, J and K move. A lesson
 *           |  seen only once waits under "Watching" with its
 *           |  uncertainty written in (M8). Below the waiting ones,
 *           |  what was kept on its own lately, each with Undo.
 *           |  Cards select like threads in the rail (ROADMAP TC4):
 *           |  Ctrl or Cmd click or Space toggles, Shift click or
 *           |  Shift with an arrow runs a range, Ctrl+A takes all. A
 *           |  floating bar then keeps or turns down the lot, with one
 *           |  Undo (shell/selection.ts holds the rules).
 * ------------------------------------------------------------------
 */

import type { MemoryProposal } from '@nvx/contracts';
import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { relative } from '../lib/format';
import {
  EMPTY,
  extendTo,
  prune,
  type Selection,
  selectAll,
  selectionSaid,
  toggle as toggleSel,
} from '../shell/selection';
import { Icon } from '../ui/Icon';
import { LoadFailed } from '../ui/LoadFailed';
import { EmptyState, Skeleton } from '../ui/primitives';
import { decideMany, type Keep, useDecide, useMemoryUi, useProposals } from './api';
import { Evidence } from './Evidence';
import { KeepIn } from './KeepIn';

const KIND: Record<MemoryProposal['kind'], string> = {
  preference: 'A preference',
  failure_lesson: 'A lesson',
  project_finding: 'A finding',
  model_quirk: 'A model quirk',
  manual: 'An entry',
  imported: 'An imported entry',
};

const OP: Record<MemoryProposal['op'], string> = {
  add: 'Add',
  update: 'Reword',
  supersede: 'Replace',
};

const where = (path: string) =>
  path === 'USER.md' ? 'About you' : path === 'AGENTS.md' ? 'House rules' : path.replace(/\.md$/, '');

/** "Lapses 14 Jan 2027" for a watch item. */
export const lapses = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

interface Picking {
  selected: boolean;
  /** How many cards are selected. */
  count: number;
  pick: (id: string, how: 'toggle' | 'range' | 'range-add' | 'all') => void;
  decideAll: (decision: 'approve' | 'reject') => void;
  clear: () => void;
}

function Card({
  p,
  onMove,
  picking,
}: {
  p: MemoryProposal;
  onMove: (d: 1 | -1, extend?: boolean) => void;
  picking: Picking;
}) {
  const decide = useDecide();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.text);
  const [leaving, setLeaving] = useState<'kept' | 'dropped' | null>(null);
  const [keep, setKeep] = useState<Keep>({});
  const watching = p.status === 'watching';
  const untrusted = p.provenance === 'tool_output' || p.provenance === 'source_content';

  const act = (decision: 'approve' | 'reject') => {
    setLeaving(decision === 'approve' ? 'kept' : 'dropped');
    decide.mutate(
      {
        id: p.id,
        decision,
        ...(decision === 'approve' && text.trim() !== p.text && { text: text.trim() }),
        ...(decision === 'approve' && keep),
      },
      { onError: () => setLeaving(null) },
    );
  };

  // With several cards selected (this one among them), A and R decide them all.
  const many = picking.selected && picking.count > 1;

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (editing || e.target !== e.currentTarget || e.altKey) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'a') picking.pick(p.id, 'all');
    else if (e.ctrlKey || e.metaKey) return;
    else if (k === ' ') picking.pick(p.id, 'toggle');
    else if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
      onMove(e.key === 'ArrowDown' ? 1 : -1, true);
    else if (e.key === 'Escape' && picking.count > 0) picking.clear();
    else if (k === 'a') {
      if (many) picking.decideAll('approve');
      else act('approve');
    } else if (k === 'r') {
      if (many) picking.decideAll('reject');
      else act('reject');
    } else if (k === 'e') setEditing(true);
    else if (k === 'j' || e.key === 'ArrowDown') onMove(1);
    else if (k === 'k' || e.key === 'ArrowUp') onMove(-1);
    else return;
    e.preventDefault();
  };

  // Ctrl, Cmd or Shift click picks the card; a plain click on its blank space lets go of a selection.
  const onClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button, a, textarea, input, select, summary')) return;
    if (e.shiftKey) {
      picking.pick(p.id, e.ctrlKey || e.metaKey ? 'range-add' : 'range');
      window.getSelection()?.removeAllRanges();
    } else if (e.ctrlKey || e.metaKey) picking.pick(p.id, 'toggle');
    else if (picking.count > 0) picking.clear();
  };

  return (
    <li
      className="mem-card"
      data-leaving={leaving ?? undefined}
      data-untrusted={untrusted || undefined}
      data-selected={picking.selected || undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable card with its own shortcuts (A, E, R, Space)
      tabIndex={0}
      onKeyDown={onKey}
      onClick={onClick}
      aria-label={`${KIND[p.kind]} for ${where(p.target_path)}: ${p.text}`}
    >
      <header className="mem-card__head">
        <span className="mem-card__kind">
          {watching ? 'Watching' : OP[p.op]} · {KIND[p.kind].toLowerCase()}
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
        <span className="mute">{p.rationale}</span>
        {untrusted ? (
          <span className="mem-card__flag">
            <Icon name="lock" size={11} />
            From {p.provenance === 'tool_output' ? 'a tool' : 'a source'}, so it waits for you
          </span>
        ) : null}
      </div>

      {watching ? (
        <p className="mem-card__watch">
          {p.uncertainty ?? 'Seen once.'}
          {p.expires_at ? <span className="mute"> Lapses {lapses(p.expires_at)}.</span> : null}
        </p>
      ) : null}

      <Evidence p={p} />

      <KeepIn p={p} value={keep} onChange={setKeep} />

      <footer className="mem-card__actions">
        <span />
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
            {watching ? 'Trust it now' : 'Remember'} <kbd>A</kbd>
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
        <span className="mute">
          {p.status === 'undone' ? 'Undone' : p.status === 'expired' ? 'Not seen again' : 'Turned down'}
        </span>
      )}
    </li>
  );
}

export function Inbox() {
  const proposals = useProposals();
  const root = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Selection>(EMPTY);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);

  const items = proposals.data?.items ?? [];
  const waiting = items.filter((p) => p.status === 'proposed');
  const watching = items.filter((p) => p.status === 'watching');
  const done = items.filter((p) => p.status !== 'proposed' && p.status !== 'watching').slice(0, 20);
  // Every card on screen, in reading order: a range runs along this.
  const order = [...waiting, ...watching].map((p) => p.id);
  const orderKey = order.join(',');

  // Cards that were decided (here or elsewhere) leave the selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: orderKey stands for order
  useEffect(() => setSel((s) => prune(s, order)), [orderKey]);

  const apply = useCallback((next: Selection) => {
    setSel(next);
    setSaid(selectionSaid(next.ids.size, 'suggestion'));
  }, []);

  const pick = (id: string, how: 'toggle' | 'range' | 'range-add' | 'all') =>
    apply(
      how === 'toggle'
        ? toggleSel(sel, id)
        : how === 'all'
          ? selectAll(order)
          : extendTo(sel, order, id, how === 'range-add'),
    );

  const decideAll = async (decision: 'approve' | 'reject') => {
    const ids = order.filter((id) => sel.ids.has(id));
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      await decideMany(ids, decision);
      apply(EMPTY);
    } finally {
      setBusy(false);
    }
  };

  const picking = (id: string): Picking => ({
    selected: sel.ids.has(id),
    count: sel.ids.size,
    pick,
    decideAll: (d) => void decideAll(d),
    clear: () => apply(EMPTY),
  });

  const move = (from: number) => (d: 1 | -1, extend?: boolean) => {
    const cards = root.current?.querySelectorAll<HTMLElement>('.mem-card');
    const at = Math.max(0, Math.min((cards?.length ?? 1) - 1, from + d));
    cards?.[at]?.focus();
    const id = order[at];
    if (extend && id) {
      // Shift with an arrow starts from the card you were on, then runs to the next.
      const start = order[from];
      const base = sel.anchor ? sel : start ? toggleSel(EMPTY, start) : sel;
      apply(extendTo(base, order, id));
    }
  };

  if (proposals.isPending) return <Skeleton lines={4} label="Loading the inbox" />;
  // A failed read is not "Nothing waiting".
  if (proposals.isError && !proposals.data)
    return <LoadFailed error={proposals.error} what="The inbox" onRetry={() => proposals.refetch()} />;

  return (
    <div className="mem-inbox" ref={root}>
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
      {waiting.length ? (
        <ol className="mem-inbox__list">
          {waiting.map((p, i) => (
            <Card key={p.id} p={p} onMove={move(i)} picking={picking(p.id)} />
          ))}
        </ol>
      ) : (
        <EmptyState
          icon="inbox"
          title="Nothing waiting"
          body="When NVX Ancile is not sure something is worth keeping, it asks here first. Anything from a tool or a source always does."
        />
      )}
      {watching.length ? (
        <section className="mem-inbox__watch" aria-label="Watching">
          <h3 className="mem-files__h">
            <Icon name="evidence" size={12} />
            Watching
          </h3>
          <p className="mute mem-inbox__watch-note">
            Seen once, so not a rule yet. A second sighting makes it one; if it never comes back it lapses
            after 90 days.
          </p>
          <ol className="mem-inbox__list">
            {watching.map((p, i) => (
              <Card key={p.id} p={p} onMove={move(waiting.length + i)} picking={picking(p.id)} />
            ))}
          </ol>
        </section>
      ) : null}
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
      {sel.ids.size > 0 ? (
        <div
          className="bulkbar mem-inbox__bar"
          role="toolbar"
          aria-label={`Actions for ${sel.ids.size} selected ${sel.ids.size === 1 ? 'suggestion' : 'suggestions'}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              apply(EMPTY);
            }
          }}
        >
          <span className="bulkbar__count" data-num>
            {sel.ids.size} selected
          </span>
          <button
            type="button"
            className="bulkbar__btn"
            disabled={busy}
            onClick={() => void decideAll('approve')}
          >
            <Icon name="seal" size={13} />
            Remember
          </button>
          <button
            type="button"
            className="bulkbar__btn"
            disabled={busy}
            onClick={() => void decideAll('reject')}
          >
            <Icon name="close" size={13} />
            Not these
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--xs"
            aria-label="Clear selection"
            onClick={() => apply(EMPTY)}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
