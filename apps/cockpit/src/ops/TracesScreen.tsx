/**
 * ------------------------------------------------------------------
 *  Title    |  Traces and replay
 *  Ref      |  DESIGN.md §11.1, §11.2 · ROADMAP Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Open anything that happened as a waterfall: the request,
 *           |  the run it started, each step, model attempt and call to
 *           |  another service, with the log lines it wrote. For a run,
 *           |  step through it like a recording, and re-run it from any
 *           |  tool step with another model; the new answer appears
 *           |  beside the original in its thread, and no tool runs.
 *  How      |  The list pages newest first (errors only, or search by
 *           |  name or id). Bars are placed by start and length against
 *           |  the trace's span; depth comes from parent links. Replay
 *           |  plays at one step per 0.7 s; ←/→ step, Space plays.
 * ------------------------------------------------------------------
 */

import type { ReplayStep, RunReplay, SpanView, TraceDetail, TraceSummary } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useModels } from '../lib/data';
import { relative } from '../lib/format';
import { notify } from '../state/notify';
import { Range, Switch } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';
import { EmptyState, Kbd, Skeleton } from '../ui/primitives';
import { CopyButton, clock, duration, LoadFailed, reportFailure } from './common';

export function TracesScreen() {
  const search = useSearch({ strict: false }) as { trace?: string };
  const [selected, setSelected] = useState<string | null>(search.trace ?? null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['ops', 'traces', errorsOnly, q],
    refetchInterval: 10_000,
    queryFn: () =>
      api.get<{ items: TraceSummary[] }>(
        `/traces?limit=80${errorsOnly ? '&errors=1' : ''}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`,
      ),
  });
  useEffect(() => {
    if (search.trace) setSelected(search.trace);
  }, [search.trace]);
  useEffect(() => {
    if (!selected && list.data?.items[0]) setSelected(list.data.items[0].trace_id);
  }, [list.data, selected]);

  return (
    <div className="ops traces">
      <aside className="traces__list m-glass">
        <div className="traces__filters">
          <label className="logview__search">
            <Icon name="search" size={13} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name or trace id"
              aria-label="Find a trace"
            />
          </label>
          <span className="traces__errors">
            <Switch checked={errorsOnly} onChange={setErrorsOnly} label="Only traces with errors" />
            <span>Errors</span>
          </span>
        </div>
        {list.isPending ? (
          <Skeleton lines={8} label="Loading traces" />
        ) : list.isError && !list.data ? (
          <LoadFailed error={list.error} what="Traces" onRetry={() => void list.refetch()} />
        ) : !list.data.items.length ? (
          <EmptyState
            icon="tree"
            title={errorsOnly ? 'No errors recorded' : 'No traces yet'}
            body="Send a message, add a source or change a setting, and what happened is recorded here."
          />
        ) : (
          <ul className="traces__items">
            {list.data.items.map((t) => (
              <li key={t.trace_id}>
                <button
                  type="button"
                  className="trace-item"
                  data-active={selected === t.trace_id || undefined}
                  data-status={t.status}
                  onClick={() => setSelected(t.trace_id)}
                >
                  <span className="trace-item__dot" aria-hidden="true" />
                  <span className="trace-item__name">{t.name}</span>
                  <span className="trace-item__meta mute">
                    {relative(t.start_at)} · {t.spans} {t.spans === 1 ? 'span' : 'spans'}
                    {t.run_id ? ' · run' : ''}
                  </span>
                  <span className="trace-item__dur" data-num>
                    {duration(t.duration_ms)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="traces__main">
        {selected ? (
          <TraceView id={selected} />
        ) : (
          <EmptyState
            icon="tree"
            title="Pick a trace"
            body="Choose one on the left to see it as a waterfall."
          />
        )}
      </section>
    </div>
  );
}

const KIND_ICON: Record<string, IconName> = {
  server: 'arrowRight',
  client: 'ext',
  internal: 'dot',
};

interface Placed {
  span: SpanView;
  depth: number;
  left: number;
  width: number;
}

function place(spans: SpanView[]): { rows: Placed[]; total: number; start: number } {
  if (!spans.length) return { rows: [], total: 0, start: 0 };
  const start = Math.min(...spans.map((s) => Date.parse(s.start_at)));
  const end = Math.max(...spans.map((s) => (s.end_at ? Date.parse(s.end_at) : Date.parse(s.start_at))));
  const total = Math.max(1, end - start);
  const ids = new Set(spans.map((s) => s.span_id));
  const children = new Map<string, SpanView[]>();
  const roots: SpanView[] = [];
  for (const s of [...spans].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    if (s.parent_span_id && ids.has(s.parent_span_id)) {
      const list = children.get(s.parent_span_id) ?? [];
      list.push(s);
      children.set(s.parent_span_id, list);
    } else roots.push(s);
  }
  const rows: Placed[] = [];
  const walk = (s: SpanView, depth: number) => {
    const left = ((Date.parse(s.start_at) - start) / total) * 100;
    const width = Math.max(0.4, ((s.duration_ms ?? 0) / total) * 100);
    rows.push({ span: s, depth, left, width: Math.min(width, 100 - left) });
    for (const c of children.get(s.span_id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return { rows, total, start };
}

function TraceView({ id }: { id: string }) {
  const [focus, setFocus] = useState<string | null>(null);
  const [replayRun, setReplayRun] = useState<string | null>(null);
  const navigate = useNavigate();
  const trace = useQuery({
    queryKey: ['ops', 'trace', id],
    queryFn: () => api.get<TraceDetail>(`/traces/${id}`),
  });
  const placed = useMemo(() => place(trace.data?.spans ?? []), [trace.data]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new trace starts closed
  useEffect(() => {
    setFocus(null);
    setReplayRun(null);
  }, [id]);

  if (trace.isPending) return <Skeleton lines={8} label="Loading the trace" />;
  if (trace.isError && !trace.data)
    return <LoadFailed error={trace.error} what="That trace" onRetry={() => void trace.refetch()} />;
  const t = trace.data;
  const run = t.runs.find((r) => r.kind === 'chat_turn') ?? t.runs[0];
  const chosen = placed.rows.find((r) => r.span.span_id === focus)?.span ?? null;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="trace">
      <header className="trace__head">
        <div>
          <h2 className="trace__title">{placed.rows[0]?.span.name ?? 'Trace'}</h2>
          <p className="mute trace__sub">
            <span data-num>{duration(placed.total)}</span> · {t.spans.length} spans · {t.logs.length} log
            lines · <code>{id.slice(0, 16)}</code>
          </p>
        </div>
        <div className="trace__actions">
          <CopyButton text={id} label="Copy id" small />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() =>
              void navigate({
                to: '/admin/$section',
                params: { section: 'logs' },
                search: { trace: id } as never,
              })
            }
          >
            <Icon name="logs" size={13} />
            Its log lines
          </button>
          {run ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => setReplayRun(replayRun ? null : run.id)}
            >
              <Icon name="play" size={13} />
              {replayRun ? 'Close replay' : 'Replay the run'}
            </button>
          ) : null}
        </div>
      </header>

      {replayRun ? <ReplayView runId={replayRun} /> : null}

      <section className="waterfall" aria-label="Spans in time order">
        <div className="waterfall__ruler" aria-hidden="true">
          {ticks.map((f) => (
            <span key={f} style={{ left: `${f * 100}%` }}>
              {duration(placed.total * f)}
            </span>
          ))}
        </div>
        {placed.rows.map((r, i) => (
          <button
            key={r.span.span_id}
            type="button"
            className="wf-row"
            data-status={r.span.status}
            data-kind={r.span.kind}
            data-active={focus === r.span.span_id || undefined}
            style={{ animationDelay: `${Math.min(i, 30) * 18}ms` }}
            onClick={() => setFocus(focus === r.span.span_id ? null : r.span.span_id)}
          >
            <span className="wf-row__name" style={{ paddingLeft: `${8 + r.depth * 14}px` }}>
              <Icon name={KIND_ICON[r.span.kind] ?? 'dot'} size={11} />
              <span>{r.span.name}</span>
            </span>
            <span className="wf-row__track">
              <span
                className="wf-row__bar"
                data-late={r.left + r.width > 82 || undefined}
                style={{ left: `${r.left}%`, width: `${r.width}%` }}
              >
                <span className="wf-row__dur" data-num>
                  {duration(r.span.duration_ms)}
                </span>
              </span>
            </span>
          </button>
        ))}
      </section>

      {chosen ? (
        <div className="span-card m-glass">
          <div className="span-card__head">
            <strong>{chosen.name}</strong>
            <span className="mute">
              {chosen.kind} · {duration(chosen.duration_ms)} · started {clock(chosen.start_at)}
            </span>
          </div>
          <pre className="logline__json">{JSON.stringify(chosen.attrs, null, 2)}</pre>
        </div>
      ) : null}

      {t.logs.length ? (
        <section className="trace__logs">
          <h3 className="admin__h">Log lines</h3>
          {t.logs.slice(0, 200).map((l) => (
            <div key={l.id} className="logline" data-level={l.level}>
              <div className="logline__row logline__row--static">
                <span className="logline__time" data-num>
                  {clock(l.at)}
                </span>
                <span className="logline__level" data-level={l.level}>
                  {l.level}
                </span>
                <span className="logline__svc">{l.service}</span>
                <span className="logline__comp mute">{l.component ?? ''}</span>
                <span className="logline__msg">{l.msg}</span>
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

const STEP_ICON: Record<ReplayStep['kind'], IconName> = {
  text: 'text',
  reasoning: 'sparkle',
  tool: 'zap',
  model: 'model',
  fallback: 'regenerate',
  retrieval: 'sources',
  memory: 'memory',
  approval: 'shield',
  status: 'dot',
  other: 'dot',
};

function ReplayView({ runId }: { runId: string }) {
  const replay = useQuery({
    queryKey: ['ops', 'replay', runId],
    queryFn: () => api.get<RunReplay>(`/runs/${runId}/replay`),
  });
  const models = useModels({ all: true }).data ?? [];
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [model, setModel] = useState('');
  const navigate = useNavigate();
  const steps = replay.data?.steps ?? [];
  const step = steps[at];

  useEffect(() => {
    if (!playing) return;
    if (at >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setAt((n) => n + 1), 700);
    return () => clearTimeout(t);
  }, [playing, at, steps.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowRight') setAt((n) => Math.min(n + 1, steps.length - 1));
      else if (e.key === 'ArrowLeft') setAt((n) => Math.max(n - 1, 0));
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [steps.length]);

  const rerun = useMutation({
    mutationFn: () =>
      api.post<{ run_id: string }>(`/runs/${runId}/rerun`, { from_step: at, ...(model && { model }) }),
    onSuccess: () => {
      const threadId = replay.data?.thread_id;
      notify({
        level: 'success',
        title: 'Re-running',
        body: 'The new answer appears beside the original. Tools answer from the recording; nothing runs again.',
      });
      if (threadId) void navigate({ to: '/t/$threadId', params: { threadId } });
    },
    onError: (e) => reportFailure(e, 'The re-run'),
  });

  if (replay.isPending) return <Skeleton lines={4} label="Loading the replay" />;
  if (replay.isError && !replay.data)
    return <LoadFailed error={replay.error} what="The replay" onRetry={() => void replay.refetch()} />;
  if (!steps.length)
    return <EmptyState icon="play" title="Nothing to replay" body="This run recorded no steps." />;

  const chat = models.filter((m) => m.chat !== false);
  return (
    <section className="replay m-glass-thick" aria-label="Replay">
      <div className="replay__controls">
        <button
          type="button"
          className="icon-btn"
          aria-label="Previous step"
          onClick={() => setAt((n) => Math.max(0, n - 1))}
          disabled={at === 0}
        >
          <Icon name="chevronLeft" size={15} />
        </button>
        <button
          type="button"
          className="replay__play"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => {
            if (at >= steps.length - 1) setAt(0);
            setPlaying((p) => !p);
          }}
        >
          <Icon name={playing ? 'stop' : 'play'} size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Next step"
          onClick={() => setAt((n) => Math.min(steps.length - 1, n + 1))}
          disabled={at >= steps.length - 1}
        >
          <Icon name="chevronRight" size={15} />
        </button>
        <div className="replay__scrub">
          <Range
            label="Step"
            value={at}
            min={0}
            max={steps.length - 1}
            onChange={setAt}
            format={(v) => `Step ${v + 1} of ${steps.length}`}
          />
        </div>
        <span className="mute replay__keys">
          <Kbd keys="left" /> <Kbd keys="right" /> step · <Kbd keys="space" /> play
        </span>
      </div>

      <ol className="replay__strip" aria-label="Steps">
        {steps.map((s) => (
          <li key={s.n}>
            <button
              type="button"
              className="replay__pip"
              data-kind={s.kind}
              data-state={s.n < at ? 'past' : s.n === at ? 'now' : 'next'}
              aria-label={`Step ${s.n + 1}: ${s.title}`}
              title={s.title}
              onClick={() => setAt(s.n)}
            >
              <Icon name={STEP_ICON[s.kind]} size={11} />
            </button>
          </li>
        ))}
      </ol>

      {step ? (
        <article className="replay__step" key={step.n}>
          <header>
            <span className="replay__kind" data-kind={step.kind}>
              <Icon name={STEP_ICON[step.kind]} size={13} />
            </span>
            <strong>{step.title}</strong>
            {step.at ? <span className="mute">{clock(step.at)}</span> : null}
          </header>
          {step.tool ? (
            <div className="replay__tool">
              <div>
                <span className="svc__k">Asked with</span>
                <pre className="logline__json">{JSON.stringify(step.tool.args, null, 2)}</pre>
              </div>
              <div>
                <span className="svc__k">{step.tool.ok === false ? 'It failed with' : 'It returned'}</span>
                <pre className="logline__json">{String(step.tool.result ?? '')}</pre>
              </div>
            </div>
          ) : step.detail ? (
            <p className="replay__detail" dir="auto">
              {step.detail}
            </p>
          ) : null}
          {step.rerunnable && replay.data.kind === 'chat_turn' ? (
            <footer className="replay__rerun">
              <p className="mute">
                {step.n === 0
                  ? 'Answer the same question again, from the start.'
                  : 'Keep everything before this step and continue from here.'}{' '}
                Tools are answered from this recording; nothing runs again.
              </p>
              <select
                className="input input--sm"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                aria-label="Model for the re-run"
              >
                <option value="">The same model</option>
                {chat.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => rerun.mutate()}
                disabled={rerun.isPending}
                data-busy={rerun.isPending || undefined}
              >
                <Icon name="regenerate" size={13} />
                Re-run from here
              </button>
            </footer>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
