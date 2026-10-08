/**
 * ------------------------------------------------------------------
 *  Title    |  Self-diagnostic
 *  Ref      |  DESIGN.md §14 · ROADMAP Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One press checks everything NVX Ancile depends on, live,
 *           |  and says for anything wrong what to do about it.
 *  How      |  POST starts a run; its results stream in over SSE and
 *           |  land in their group as they finish. The ring fills as
 *           |  checks pass; a failure keeps its fix in view with Copy.
 *           |  Earlier runs are listed below to compare.
 * ------------------------------------------------------------------
 */

import { DiagnosticCheck, type DiagnosticRun } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { API_BASE, api } from '../lib/api';
import { relative } from '../lib/format';
import { openStream } from '../lib/sse';
import { Ticker } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';
import { EmptyState } from '../ui/primitives';
import { CopyButton, duration, reportFailure } from './common';

const GROUPS: { id: DiagnosticCheck['group']; title: string; icon: IconName }[] = [
  { id: 'data', title: 'Your data', icon: 'grid' },
  { id: 'services', title: 'Services', icon: 'pulse' },
  { id: 'models', title: 'Models', icon: 'model' },
  { id: 'memory', title: 'Memory', icon: 'memory' },
  { id: 'security', title: 'Security', icon: 'lock' },
  { id: 'system', title: 'This computer', icon: 'monitor' },
];

const STATUS_ICON: Record<DiagnosticCheck['status'], IconName> = {
  pending: 'dot',
  running: 'regenerate',
  passed: 'check',
  warned: 'warn',
  failed: 'alert',
  skipped: 'minus',
};

const Event = z.union([
  z.object({ seq: z.number(), type: z.literal('check'), check: DiagnosticCheck }),
  z.object({ seq: z.number(), type: z.literal('done'), run: z.unknown() }),
]);

function Ring({
  done,
  passed,
  total,
  status,
}: {
  done: number;
  passed: number;
  total: number;
  status: string;
}) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const f = total ? done / total : 0;
  return (
    <div className="diag-ring" data-status={status}>
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle cx="40" cy="40" r={r} className="diag-ring__track" />
        <circle
          cx="40"
          cy="40"
          r={r}
          className="diag-ring__fill"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - f)}
          transform="rotate(-90 40 40)"
        />
      </svg>
      <span className="diag-ring__num" data-num>
        <Ticker value={passed} />
        <span className="mute">/{total}</span>
      </span>
    </div>
  );
}

export function DiagnosticsScreen() {
  const [run, setRun] = useState<DiagnosticRun | null>(null);
  const recent = useQuery({
    queryKey: ['ops', 'diagnostics'],
    queryFn: () => api.get<{ items: DiagnosticRun[] }>('/system/diagnostics').then((r) => r.items),
  });
  const start = useMutation({
    mutationFn: () => api.post<DiagnosticRun>('/system/diagnostics', {}),
    onSuccess: (r) => setRun(r),
    onError: (e) => reportFailure(e, 'The self-check'),
  });

  // Show the latest run when the page opens.
  useEffect(() => {
    if (!run && recent.data?.[0]) setRun(recent.data[0]);
  }, [recent.data, run]);

  const runId = run?.id;
  const live = run?.status === 'running';
  // biome-ignore lint/correctness/useExhaustiveDependencies: one stream per running run
  useEffect(() => {
    if (!runId || !live) return;
    return openStream({
      url: `${API_BASE}/system/diagnostics/${runId}/stream`,
      schema: Event,
      isTerminal: (e) => e.type === 'done',
      onEvent: (e) => {
        if (e.type === 'done') {
          setRun(e.run as DiagnosticRun);
          void recent.refetch();
          return;
        }
        setRun((r) => (r ? { ...r, checks: r.checks.map((c) => (c.id === e.check.id ? e.check : c)) } : r));
      },
    });
  }, [runId, live]);

  const checks = run?.checks ?? [];
  const finished = checks.filter((c) => !['pending', 'running'].includes(c.status));
  const passed = checks.filter((c) => c.status === 'passed').length;
  const problems = checks.filter((c) => c.status === 'failed' || c.status === 'warned');
  const verdict = !run
    ? 'idle'
    : run.status === 'running'
      ? 'running'
      : run.status === 'failed'
        ? 'down'
        : problems.length
          ? 'degraded'
          : 'ok';

  return (
    <div className="ops diag">
      <section className="ops-hero" data-status={verdict}>
        {run ? (
          <Ring done={finished.length} passed={passed} total={checks.length} status={verdict} />
        ) : (
          <span className="ops-hero__orb" aria-hidden="true" />
        )}
        <div className="ops-hero__text">
          <h2 className="ops-hero__title">
            {!run
              ? 'Check everything NVX Ancile depends on'
              : run.status === 'running'
                ? `Checking ${checks.length - finished.length} more`
                : run.status === 'failed'
                  ? `${checks.filter((c) => c.status === 'failed').length} ${checks.filter((c) => c.status === 'failed').length === 1 ? 'thing needs' : 'things need'} fixing`
                  : problems.length
                    ? 'All good, with a note or two'
                    : 'Everything checks out'}
          </h2>
          <p className="mute">
            {run
              ? `${run.status === 'running' ? 'Started' : 'Ran'} ${relative(run.started_at)}${run.finished_at ? `, took ${duration(Date.parse(run.finished_at) - Date.parse(run.started_at))}` : ''}.`
              : 'The database, every service and model, your memory files, stored keys, disk space and the boot tests. About 20 seconds.'}
          </p>
        </div>
        <div className="ops-hero__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => start.mutate()}
            disabled={start.isPending || live}
            data-busy={start.isPending || live || undefined}
          >
            <Icon name="factcheck" size={14} />
            {live ? 'Checking' : run ? 'Run again' : 'Run the self-check'}
          </button>
        </div>
      </section>

      {problems.length && !live ? (
        <section className="diag-fixes">
          {problems.map((c) => (
            <div key={c.id} className="diag-fix" data-status={c.status}>
              <Icon name={c.status === 'failed' ? 'alert' : 'warn'} size={15} />
              <div>
                <strong>{c.title}</strong>
                {c.detail ? <p className="mute">{c.detail}</p> : null}
                {c.fix ? <p className="diag-fix__fix">{c.fix}</p> : null}
              </div>
              {c.fix ? <CopyButton text={c.fix} small /> : null}
            </div>
          ))}
        </section>
      ) : null}

      {run ? (
        <div className="diag-groups">
          {GROUPS.map((g) => {
            const list = checks.filter((c) => c.group === g.id);
            if (!list.length) return null;
            return (
              <section key={g.id} className="diag-group m-glass">
                <h3 className="diag-group__h">
                  <Icon name={g.icon} size={14} />
                  {g.title}
                </h3>
                <ul>
                  {list.map((c) => (
                    <li key={c.id} className="diag-check" data-status={c.status}>
                      <span className="diag-check__icon" data-status={c.status}>
                        <Icon name={STATUS_ICON[c.status]} size={12} />
                      </span>
                      <span className="diag-check__title">{c.title}</span>
                      <span className="diag-check__detail mute">{c.detail ?? ''}</span>
                      <span className="diag-check__ms mute" data-num>
                        {c.ms !== null ? duration(c.ms) : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <EmptyState icon="factcheck" title="No self-check yet" body="Run one to see how everything stands." />
      )}

      {(recent.data?.length ?? 0) > 1 ? (
        <section className="diag-history">
          <h3 className="admin__h">Earlier checks</h3>
          <ul className="rows">
            {(recent.data ?? []).map((r) => {
              const failed = r.checks.filter((c) => c.status === 'failed').length;
              const notes = r.checks.filter((c) => c.status === 'warned').length;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className="row row--link"
                    data-active={r.id === run?.id || undefined}
                    onClick={() => setRun(r)}
                  >
                    <span
                      className="dot"
                      data-status={r.status === 'failed' ? 'down' : 'ok'}
                      aria-hidden="true"
                    />
                    <span className="row__title">
                      {failed
                        ? `${failed} failed`
                        : notes
                          ? `Passed, with ${notes} ${notes === 1 ? 'note' : 'notes'}`
                          : 'All passed'}
                    </span>
                    <span className="row__meta mute">{relative(r.started_at)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
