/**
 * ------------------------------------------------------------------
 *  Title    |  Automations
 *  Ref      |  DESIGN.md §13.6 · ROADMAP Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The things NVX Ancile does on its own: when each runs,
 *           |  what happened last time, and when it runs next, with
 *           |  Run now and a switch for the scheduled ones. The ones
 *           |  that run on events (after a turn, on ingest) are listed
 *           |  too, so nothing happens out of sight.
 * ------------------------------------------------------------------
 */

import type { AutomationView } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { duration, LoadFailed, reportFailure, until } from './common';

const KEY = ['ops', 'automations'] as const;

export function AutomationsScreen() {
  const [, tick] = useState(0);
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
        ...(a.last_error && { body: a.last_error }),
      });
      return queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => reportFailure(e, 'Running it'),
  });

  if (list.isPending) return <Skeleton lines={6} label="Loading automations" />;
  if (list.isError && !list.data)
    return <LoadFailed error={list.error} what="Automations" onRetry={() => void list.refetch()} />;
  const scheduled = list.data.filter((a) => a.trigger === 'schedule');
  const events = list.data.filter((a) => a.trigger === 'event');

  return (
    <div className="ops autos">
      <p className="admin__lede mute">
        Scheduled work runs in this computer's time. Switching one off keeps its history; Run now works either
        way.
      </p>
      <ul className="auto-grid">
        {scheduled.map((a, i) => (
          <li
            key={a.id}
            className="auto m-glass"
            data-on={a.enabled || undefined}
            data-status={a.last_status ?? 'never'}
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <div className="auto__head">
              <span className="auto__icon" aria-hidden="true">
                <Icon name="clock" size={15} />
              </span>
              <div className="auto__names">
                <strong>{a.title}</strong>
                <span className="mute">{a.description}</span>
              </div>
              <Switch
                checked={a.enabled}
                onChange={(enabled) => toggle.mutate({ id: a.id, enabled })}
                label={`Run ${a.title} on its schedule`}
              />
            </div>
            <dl className="auto__facts">
              <div>
                <dt>When</dt>
                <dd>{a.schedule_words}</dd>
              </div>
              <div>
                <dt>Next</dt>
                <dd>{a.enabled ? until(a.next_run_at) : 'Off'}</dd>
              </div>
              <div>
                <dt>Last</dt>
                <dd>
                  {a.last_run_at ? (
                    <>
                      <span className="auto__status" data-status={a.last_status ?? undefined}>
                        {a.last_status === 'succeeded'
                          ? 'Done'
                          : a.last_status === 'failed'
                            ? 'Failed'
                            : a.last_status === 'running'
                              ? 'Running'
                              : 'Skipped'}
                      </span>{' '}
                      {relative(a.last_run_at)} · {duration(a.last_duration_ms)}
                    </>
                  ) : (
                    'Not yet'
                  )}
                </dd>
              </div>
            </dl>
            {a.last_error ? (
              <p className={`auto__note ${a.last_status === 'failed' ? 'auto__note--fail' : ''}`}>
                {a.last_error}
              </p>
            ) : null}
            <div className="auto__foot">
              <span className="mute" data-num>
                {a.runs} {a.runs === 1 ? 'run' : 'runs'}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => runNow.mutate(a.id)}
                disabled={runNow.isPending || a.last_status === 'running'}
                data-busy={(runNow.isPending && runNow.variables === a.id) || undefined}
              >
                <Icon name="play" size={12} />
                Run now
              </button>
            </div>
          </li>
        ))}
      </ul>

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
    </div>
  );
}
