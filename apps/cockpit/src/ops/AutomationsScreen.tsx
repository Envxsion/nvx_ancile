/**
 * ------------------------------------------------------------------
 *  Title    |  Automations
 *  Ref      |  DESIGN.md §13.6 · ROADMAP Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The things NVX Ancile does on its own: when each runs,
 *           |  what happened last time, and when it runs next. Make
 *           |  your own (ask a model, run a flow, re-check links,
 *           |  remind me), change a built-in job's schedule or reset
 *           |  it, switch any of them off. The ones that run on events
 *           |  (after a turn, on ingest) are listed too, so nothing
 *           |  happens out of sight.
 *  How      |  One card per scheduled automation; its "more" menu holds
 *           |  Edit, Run now, Reset to default (built in) and Delete
 *           |  (your own). The dialog is AutomationDialog.tsx.
 * ------------------------------------------------------------------
 */

import type { AutomationView } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Switch } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { Skeleton } from '../ui/primitives';
import { AutomationDialog, AUTOMATIONS_KEY as KEY } from './AutomationDialog';
import { duration, LoadFailed, reportFailure, until } from './common';

const KIND_ICON: Record<string, IconName> = {
  ask_model: 'sparkle',
  run_flow: 'tree',
  recheck_sources: 'link',
  notify: 'bell',
};

/** The word for how the last run went. */
export function lastWord(a: Pick<AutomationView, 'last_status' | 'setup'>): string {
  if (a.setup) return a.setup.title;
  switch (a.last_status) {
    case 'succeeded':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'running':
      return 'Running';
    default:
      return 'Skipped';
  }
}

export function AutomationsScreen() {
  const [, tick] = useState(0);
  const [editing, setEditing] = useState<AutomationView | null>(null);
  const [creating, setCreating] = useState(false);
  // Keep "in 4 min" honest without refetching.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const list = useQuery({
    queryKey: KEY,
    refetchInterval: 30_000,
    queryFn: () => api.get<{ items: AutomationView[] }>('/automations').then((r) => r.items),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api.patch<AutomationView>(`/automations/${v.id}`, { enabled: v.enabled }),
    onMutate: async (v) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const prev = queryClient.getQueryData<AutomationView[]>(KEY);
      queryClient.setQueryData<AutomationView[]>(KEY, (l) =>
        l?.map((a) => (a.id === v.id ? { ...a, enabled: v.enabled } : a)),
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY, ctx.prev);
      reportFailure(e, 'Changing it');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
  const runNow = useMutation({
    mutationFn: (id: string) => api.post<AutomationView>(`/automations/${id}/run`, {}),
    onSuccess: (a) => {
      notify({
        level: a.last_status === 'failed' ? 'error' : 'success',
        title:
          a.last_status === 'failed'
            ? `${a.title} failed`
            : a.last_status === 'skipped'
              ? `${a.title}: nothing to do`
              : `${a.title}: done`,
        ...((a.last_error ?? a.last_detail) && { body: a.last_error ?? a.last_detail ?? '' }),
      });
      return queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => reportFailure(e, 'Running it'),
  });
  const reset = useMutation({
    mutationFn: (id: string) => api.post<AutomationView>(`/automations/${id}/reset`, {}),
    onSuccess: (a) => {
      notify({ level: 'success', title: `${a.title} is back to its default` });
      return queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => reportFailure(e, 'Resetting it'),
  });
  const remove = useMutation({
    mutationFn: (a: AutomationView) => api.del(`/automations/${a.id}`).then(() => a),
    onSuccess: (a) => {
      notify({ level: 'success', title: `${a.title} is deleted` });
      return queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => reportFailure(e, 'Deleting it'),
  });

  if (list.isPending) return <Skeleton lines={6} label="Loading automations" />;
  if (list.isError && !list.data)
    return <LoadFailed error={list.error} what="Automations" onRetry={() => void list.refetch()} />;
  const mine = list.data.filter((a) => a.origin === 'user');
  const scheduled = list.data.filter((a) => a.origin === 'builtin' && a.trigger === 'schedule');
  const events = list.data.filter((a) => a.trigger === 'event');

  const menu = (a: AutomationView): MenuEntry[] => [
    { label: 'Edit', icon: 'edit', onSelect: () => setEditing(a) },
    {
      label: 'Run now',
      icon: 'play',
      disabled: !!a.setup || a.last_status === 'running' || runNow.isPending,
      onSelect: () => runNow.mutate(a.id),
    },
    ...(a.origin === 'builtin'
      ? [
          {
            label: 'Reset to default',
            icon: 'undo' as const,
            disabled: !a.customised,
            onSelect: () => reset.mutate(a.id),
          },
        ]
      : [
          { kind: 'separator' as const },
          { label: 'Delete', icon: 'trash' as const, danger: true, onSelect: () => remove.mutate(a) },
        ]),
  ];

  const cards = (items: AutomationView[], offset = 0) => (
    <ul className="auto-grid">
      {items.map((a, i) => (
        <AutomationCard
          key={a.id}
          a={a}
          delay={(i + offset) * 40}
          busy={runNow.isPending && runNow.variables === a.id}
          menu={menu(a)}
          onToggle={(enabled) => toggle.mutate({ id: a.id, enabled })}
        />
      ))}
    </ul>
  );

  return (
    <div className="ops autos">
      <div className="admin__bar">
        <p className="admin__lede mute">
          Scheduled work runs in this computer's time. Switching one off keeps its history; Run now works
          either way.
        </p>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} />
          New automation
        </button>
      </div>

      {mine.length ? (
        <>
          <h3 className="admin__h">Yours</h3>
          {cards(mine)}
          <h3 className="admin__h">Built in</h3>
        </>
      ) : null}
      {cards(scheduled, mine.length)}

      <h3 className="admin__h">On events</h3>
      <ul className="rows auto-events">
        {events.map((a) => (
          <li key={a.id} className="row">
            <Icon name="zap" size={13} />
            <span className="row__title">{a.title}</span>
            <span className="row__meta mute">{a.description}</span>
          </li>
        ))}
      </ul>

      <AutomationDialog
        open={creating || editing !== null}
        automation={editing}
        onOpenChange={(o) => {
          if (o) return;
          setCreating(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

function AutomationCard({
  a,
  delay,
  busy,
  menu,
  onToggle,
}: {
  a: AutomationView;
  delay: number;
  busy: boolean;
  menu: MenuEntry[];
  onToggle: (enabled: boolean) => void;
}) {
  const navigate = useNavigate();
  const note = a.setup
    ? { text: a.setup.hint, fail: false }
    : a.last_error
      ? { text: a.last_error, fail: a.last_status === 'failed' }
      : a.origin === 'user' && a.last_detail
        ? { text: a.last_detail, fail: false }
        : null;
  return (
    <li
      className="auto m-glass"
      data-on={(a.enabled && !a.setup) || undefined}
      data-status={a.setup ? 'setup' : (a.last_status ?? 'never')}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="auto__head">
        <span className="auto__icon" aria-hidden="true">
          <Icon name={KIND_ICON[a.kind] ?? 'clock'} size={15} />
        </span>
        <div className="auto__names">
          <strong>
            {a.title}
            {a.customised ? <span className="auto__tag">Changed</span> : null}
          </strong>
          <span className="mute">{a.description}</span>
        </div>
        <Switch checked={a.enabled} onChange={onToggle} label={`Run ${a.title} on its schedule`} />
      </div>
      <dl className="auto__facts">
        <div>
          <dt>When</dt>
          <dd>{a.schedule_words}</dd>
        </div>
        <div>
          <dt>Next</dt>
          <dd>{a.setup ? '—' : a.enabled ? until(a.next_run_at) : 'Off'}</dd>
        </div>
        <div>
          <dt>Last</dt>
          <dd>
            {a.setup ? (
              <span className="auto__status" data-status="setup">
                {lastWord(a)}
              </span>
            ) : a.last_run_at ? (
              <>
                <span className="auto__status" data-status={a.last_status ?? undefined}>
                  {lastWord(a)}
                </span>{' '}
                {relative(a.last_run_at)} · {duration(a.last_duration_ms)}
              </>
            ) : (
              'Not yet'
            )}
          </dd>
        </div>
      </dl>
      {note ? (
        <p className={`auto__note ${note.fail ? 'auto__note--fail' : ''}`}>
          {note.text}
          {a.last_href && !a.setup ? (
            <>
              {' '}
              <button
                type="button"
                className="auto__link"
                onClick={() => void navigate({ to: a.last_href ?? '/' })}
              >
                Open
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <div className="auto__foot">
        <span className="mute" data-num data-busy={busy || undefined}>
          {busy ? 'Running…' : `${a.runs} ${a.runs === 1 ? 'run' : 'runs'}`}
        </span>
        <DropMenu
          items={menu}
          trigger={
            <button type="button" className="icon-btn icon-btn--sm" aria-label={`More for ${a.title}`}>
              <Icon name="more" size={15} />
            </button>
          }
        />
      </div>
    </li>
  );
}
