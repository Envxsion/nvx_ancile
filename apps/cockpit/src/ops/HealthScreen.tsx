/**
 * ------------------------------------------------------------------
 *  Title    |  Health
 *  Ref      |  DESIGN.md §7.4 · ROADMAP Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Is everything well, and if not, what is NVX Ancile doing
 *           |  about it and what should you do? One card per service:
 *           |  its state, how fast it answers (with a short history),
 *           |  restarts in the last ten minutes, and for anything
 *           |  unwell the last error and the fix, with Restart when the
 *           |  runner can bring it back.
 *  How      |  Polls every 5 s while open; the latency history is kept
 *           |  here, in memory, from those polls.
 * ------------------------------------------------------------------
 */

import type { ServiceHealthView, SystemHealth } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Ticker } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { CopyButton, LoadFailed, reportFailure, Sparkline } from './common';

const NAME: Record<string, { title: string; role: string }> = {
  postgres: { title: 'Database', role: 'Threads, sources, memory index and every record' },
  knowledge: { title: 'Knowledge', role: 'Reads sources and finds passages for answers' },
  controller: { title: 'Controller', role: 'Starts, stops and watches your GPU nodes' },
  agent: { title: 'The lab', role: 'Runs coding and file work in your workspace' },
  disk: { title: 'Disk space', role: 'Room for sources, models and logs' },
};

const STATUS_WORDS: Record<ServiceHealthView['status'], string> = {
  ok: 'Answering',
  degraded: 'Slow',
  down: 'Not answering',
  restarting: 'Restarting',
};

const ADAPTER_WORDS: Record<SystemHealth['restart_adapter'], string> = {
  process: 'Brings a service back on its own after',
  docker: 'Restarts the container on its own after',
  none: 'Automatic restart is off; you will be told after',
};

const KEY = ['ops', 'health'] as const;

export function HealthScreen() {
  const history = useRef(new Map<string, number[]>());
  const health = useQuery({
    queryKey: KEY,
    refetchInterval: 5_000,
    queryFn: async () => {
      const h = await api.get<SystemHealth>('/system/health');
      for (const s of h.services) {
        if (s.latency_ms === null) continue;
        const list = history.current.get(s.service) ?? [];
        list.push(s.latency_ms);
        history.current.set(s.service, list.slice(-24));
      }
      return h;
    },
  });
  const check = useMutation({
    mutationFn: () => api.get<SystemHealth>('/system/health?fresh=1'),
    onSuccess: (h) => queryClient.setQueryData(KEY, h),
    onError: (e) => reportFailure(e, 'The check'),
  });
  const restart = useMutation({
    mutationFn: (service: string) => api.post<{ status: string }>(`/system/services/${service}/restart`, {}),
    onSuccess: (r, service) => {
      notify({
        level: r.status === 'down' ? 'error' : 'success',
        title:
          r.status === 'down'
            ? `${NAME[service]?.title ?? service} did not come back`
            : `Restarting ${NAME[service]?.title ?? service}`,
        ...(r.status !== 'down' && { body: 'It shows as answering again within a few seconds.' }),
      });
      return queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => reportFailure(e, 'Restarting'),
  });

  if (health.isPending) return <Skeleton lines={6} label="Loading health" />;
  if (health.isError && !health.data)
    return <LoadFailed error={health.error} what="Health" onRetry={() => void health.refetch()} />;
  const h = health.data;
  const unwell = h.services.filter((s) => s.status !== 'ok');
  const verdict = unwell.length === 0 ? 'ok' : unwell.some((s) => s.status === 'down') ? 'down' : 'degraded';

  return (
    <div className="ops">
      <section className="ops-hero" data-status={verdict}>
        <span className="ops-hero__orb" aria-hidden="true" />
        <div className="ops-hero__text">
          <h2 className="ops-hero__title">
            {verdict === 'ok'
              ? 'Everything is answering'
              : unwell.length === 1
                ? `${NAME[unwell[0]?.service ?? '']?.title ?? unwell[0]?.service} needs a look`
                : `${unwell.length} services need a look`}
          </h2>
          <p className="mute">
            Checked every {h.interval_s} seconds, every 5 while anything is unwell.{' '}
            {ADAPTER_WORDS[h.restart_adapter]} {h.restart_after} failed checks in a row.
          </p>
        </div>
        <div className="ops-hero__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-busy={check.isPending || undefined}
            onClick={() => check.mutate()}
            disabled={check.isPending}
          >
            <Icon name="regenerate" size={13} />
            {check.isPending ? 'Checking' : 'Check now'}
          </button>
          <Link to="/admin/$section" params={{ section: 'diagnostics' }} className="btn btn--primary btn--sm">
            <Icon name="factcheck" size={13} />
            Run a full self-check
          </Link>
        </div>
      </section>

      <ul className="svc-grid">
        {h.services.map((s, i) => {
          const name = NAME[s.service] ?? { title: s.service, role: '' };
          const recent = s.restarts.filter((t) => Date.now() - Date.parse(t) < 10 * 60_000).length;
          return (
            <li
              key={s.service}
              className="svc m-glass"
              data-status={s.status}
              data-attention={s.needs_attention || undefined}
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div className="svc__head">
                <span className="svc__orb" data-status={s.status} aria-hidden="true" />
                <div className="svc__names">
                  <span className="svc__title">{name.title}</span>
                  <span className="svc__role mute">{name.role}</span>
                </div>
                <span className="svc__state" data-status={s.status}>
                  {s.needs_attention ? 'Needs attention' : STATUS_WORDS[s.status]}
                </span>
              </div>
              <div className="svc__stats">
                <div className="svc__stat">
                  <span className="svc__k">Answers in</span>
                  <span className="svc__v">
                    {s.latency_ms === null ? (
                      '—'
                    ) : (
                      <>
                        <Ticker value={s.latency_ms} /> ms
                      </>
                    )}
                  </span>
                </div>
                <Sparkline values={history.current.get(s.service) ?? []} />
                <div className="svc__stat">
                  <span className="svc__k">Last good check</span>
                  <span className="svc__v">{s.last_ok_at ? relative(s.last_ok_at) : 'Not yet'}</span>
                </div>
                {recent ? (
                  <div className="svc__stat">
                    <span className="svc__k">Restarts, 10 min</span>
                    <span className="svc__v">
                      <Ticker value={recent} />
                    </span>
                  </div>
                ) : null}
              </div>
              {s.status !== 'ok' && (s.last_error || s.remediation) ? (
                <div className="svc__problem">
                  {s.last_error ? <p className="svc__error">{s.last_error}</p> : null}
                  {s.remediation ? (
                    <div className="svc__fix">
                      <Icon name="sparkle" size={13} />
                      <p>{s.remediation}</p>
                      <CopyButton text={s.remediation} label="Copy" small />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {s.restartable ? (
                <div className="svc__foot">
                  <button
                    type="button"
                    className={`btn btn--sm ${s.status === 'ok' ? 'btn--quiet' : 'btn--primary'}`}
                    disabled={restart.isPending || s.status === 'restarting'}
                    data-busy={(restart.isPending && restart.variables === s.service) || undefined}
                    onClick={() => restart.mutate(s.service)}
                  >
                    <Icon name="regenerate" size={13} />
                    {s.status === 'restarting' ? 'Restarting' : 'Restart'}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
