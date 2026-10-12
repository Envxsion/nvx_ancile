/**
 * ------------------------------------------------------------------
 *  Title    |  Activity panel
 *  Ref      |  docs/activity.md · ROADMAP G (Activity panel)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One place to see what is running: NVX Ancile's own runs
 *           |  with their progress, Claude Code sessions open
 *           |  elsewhere, subagents still working and background
 *           |  shells, each opening its thread (at its message, when
 *           |  known). Read-only: nothing here starts or stops work.
 *  How      |  A side sheet like the notification centre, opened from
 *           |  the status bar's count, the palette, or `g r`. The list
 *           |  refreshes on `activity.changed`, and every few seconds
 *           |  while it is open and something runs. ActivityHost also
 *           |  sends the typing hint while an import runs.
 *  Note     |  Signal violet marks live rows only (the pulse on a
 *           |  running row); "Needs you" uses the attention ink.
 * ------------------------------------------------------------------
 */

import type { ActivityItem } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useImportProgress } from '../claudecode/api';
import { useBinding, useLayer } from '../keys/dispatch';
import { Icon, type IconName } from '../ui/Icon';
import { EmptyState, Skeleton } from '../ui/primitives';
import {
  GROUP_TITLES,
  grouped,
  noteTyping,
  openActivity,
  since,
  stateLabel,
  useActivity,
  useActivityPanel,
} from './api';
import '../styles/activity.css';

const KIND_ICON: Record<ActivityItem['kind'], IconName> = {
  run: 'pulse',
  claude_session: 'terminal',
  subagent: 'branch',
  shell: 'command',
};

/** Ticks once a second while mounted, so "for 12 s" moves. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function when(i: ActivityItem, now: number): string | null {
  if (i.finished_at) {
    const ago = since(i.finished_at, now);
    return ago ? `${stateLabel(i)} ${ago} ago` : null;
  }
  const how = since(i.started_at ?? i.updated_at, now);
  return how ? `for ${how}` : null;
}

function Row({ i, now, onOpen }: { i: ActivityItem; now: number; onOpen: (i: ActivityItem) => void }) {
  const live = i.state === 'running';
  const label = stateLabel(i);
  // The thread, unless the row is already named after it, then the folder.
  const where = [
    i.thread_title && i.thread_title !== i.title ? i.thread_title : null,
    i.project && i.kind !== 'run' ? i.project : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const body = (
    <>
      <span className="act__icon" aria-hidden="true">
        <Icon name={KIND_ICON[i.kind]} size={14} />
      </span>
      <span className="act__main">
        <span className={i.kind === 'shell' ? 'act__title act__title--mono' : 'act__title'}>{i.title}</span>
        {i.detail ? <span className="act__detail">{i.detail}</span> : null}
        {i.progress ? (
          <span className="act__bar" aria-hidden="true">
            <span
              className="act__fill"
              style={{ width: `${Math.round((100 * i.progress.done) / Math.max(1, i.progress.total))}%` }}
            />
          </span>
        ) : null}
        {where ? <span className="act__where">{where}</span> : null}
      </span>
      <span className="act__side">
        <span className="act__state" data-state={i.state} data-attention={label === 'Needs you' || undefined}>
          {live ? <span className="act__pulse" aria-hidden="true" /> : null}
          {label}
          {i.progress ? (
            <span data-num>
              {' '}
              {i.progress.done}/{i.progress.total}
            </span>
          ) : null}
        </span>
        <span className="act__when">{when(i, now)}</span>
      </span>
    </>
  );
  return (
    <li className="act__item" data-kind={i.kind} data-state={i.state}>
      {i.thread_id ? (
        <button
          type="button"
          className="act__row"
          onClick={() => onOpen(i)}
          aria-label={`${i.title}: ${label}. Open ${i.thread_title ? `the thread ${i.thread_title}` : 'its thread'}`}
        >
          {body}
          <Icon name="chevronRight" size={12} />
        </button>
      ) : (
        <div className="act__row act__row--static">{body}</div>
      )}
    </li>
  );
}

export function ActivityPanel() {
  const open = useActivityPanel((s) => s.open);
  const setOpen = useActivityPanel((s) => s.setOpen);
  const q = useActivity();
  const importing = useImportProgress((s) => s.progress);
  const importLine = useImportProgress((s) => s.line);
  const navigate = useNavigate();
  const now = useNow(open);
  useLayer(open);

  const items = q.data?.items ?? [];
  const running = q.data?.running ?? 0;
  const groups = grouped(items);

  const go = (i: ActivityItem) => {
    if (!i.thread_id) return;
    setOpen(false);
    void navigate({
      to: '/t/$threadId',
      params: { threadId: i.thread_id },
      ...(i.message_id && { hash: i.message_id }),
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim scrim--light" />
        <Dialog.Content className="center act" aria-describedby="act-sub">
          <header className="center__head">
            <div className="act__head">
              <Dialog.Title className="center__title">Activity</Dialog.Title>
              <p id="act-sub" className="act__sub mute">
                {running ? (
                  <>
                    <span data-num>{running}</span> running. Open a row to go to its thread.
                  </>
                ) : (
                  'Runs, Claude Code elsewhere, subagents and shells.'
                )}
              </p>
            </div>
            <Dialog.Close className="icon-btn icon-btn--sm" aria-label="Close">
              <Icon name="close" size={14} />
            </Dialog.Close>
          </header>
          {importing && importLine ? (
            <div className="act__import" role="status">
              <span className="act__import-line">
                <Icon name="download" size={13} />
                {importLine}
              </span>
              <span className="act__bar" aria-hidden="true">
                <span
                  className="act__fill"
                  data-paused={importing.paused || undefined}
                  style={{ width: `${Math.round((100 * importing.done) / Math.max(1, importing.total))}%` }}
                />
              </span>
            </div>
          ) : null}
          {q.isPending && !q.data ? (
            <div className="act__body">
              <Skeleton lines={3} label="Looking at what is running" />
            </div>
          ) : groups.length === 0 ? (
            <EmptyState
              icon="pulse"
              title="Nothing running"
              body="Work in progress shows here while it runs."
            />
          ) : (
            <div className="act__body" data-scrollable>
              {groups.map((g) => (
                <section key={g.group} className="act__group" aria-labelledby={`act-${g.group}`}>
                  <h3 id={`act-${g.group}`} className="act__group-title">
                    {GROUP_TITLES[g.group]}
                    <span className="mute" data-num>
                      {' '}
                      {g.items.length}
                    </span>
                  </h3>
                  <ul className="act__list">
                    {g.items.map((i) => (
                      <Row key={i.id} i={i} now={now} onOpen={go} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The panel, its key, and the typing hint for background imports. */
export function ActivityHost() {
  useBinding('activity.open', openActivity);
  useEffect(() => {
    const onInput = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) noteTyping();
    };
    document.addEventListener('input', onInput, true);
    return () => document.removeEventListener('input', onInput, true);
  }, []);
  return <ActivityPanel />;
}

/** The status bar's count: shown only while something runs. */
export function ActivitySegment() {
  useActivity();
  const running = useActivityPanel((s) => s.running);
  if (running <= 0) return null;
  return (
    <button
      type="button"
      className="status-seg act-seg"
      onClick={openActivity}
      aria-label={`${running} running. Show activity`}
    >
      <span className="act__pulse" aria-hidden="true" />
      <span data-num>{running}</span>
      <span>running</span>
    </button>
  );
}

/** A quiet line while a large background import runs (5 sessions or more). */
export function ImportSegment() {
  const p = useImportProgress((s) => s.progress);
  if (!p || p.total < 5) return null;
  return (
    <button
      type="button"
      className="status-seg act-import-seg"
      onClick={openActivity}
      aria-label={`${p.paused ? 'Import paused while you type' : 'Importing Claude Code sessions'}: ${p.done} of ${p.total}. Show activity`}
    >
      <Icon name="download" size={12} />
      <span>{p.paused ? 'Paused' : 'Importing'}</span>
      <span data-num>
        {p.done}/{p.total}
      </span>
    </button>
  );
}
