/**
 * ------------------------------------------------------------------
 *  Title    |  Logs
 *  Ref      |  DESIGN.md §11.5 · ROADMAP Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every service's log in one list. Narrow it by level,
 *           |  service, component, words and time; follow it live; open
 *           |  a line to see everything it carried; jump to its trace;
 *           |  take the view away as JSON or CSV.
 *  How      |  A page from GET /logs, then (when Live is on) new lines
 *           |  from /logs/stream with the same filters, newest at the
 *           |  top. Scrolled away from the top, new lines wait behind a
 *           |  "N new lines" button instead of moving what you read.
 *           |  `/` searches, `l` toggles Live.
 * ------------------------------------------------------------------
 */

import { type LogLevel, type LogLine, LogLine as LogLineSchema, type LogPage } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { API_BASE, api } from '../lib/api';
import { openStream } from '../lib/sse';
import { Segmented, Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { EmptyState, Kbd, Skeleton } from '../ui/primitives';
import { clock, LoadFailed } from './common';

const LEVELS: { value: LogLevel; label: string }[] = [
  { value: 'debug', label: 'All' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warnings' },
  { value: 'error', label: 'Errors' },
];

const RANGES = [
  { value: '15m', label: '15 min', ms: 15 * 60_000 },
  { value: '1h', label: 'Hour', ms: 3_600_000 },
  { value: '24h', label: 'Day', ms: 86_400_000 },
  { value: '7d', label: 'Week', ms: 7 * 86_400_000 },
] as const;
type Range = (typeof RANGES)[number]['value'];

const MAX_LINES = 1_500;

/** An HTTP access line says what was asked and how it went. */
function messageOf(l: LogLine): string {
  const d = l.data as { method?: unknown; path?: unknown; status?: unknown; ms?: unknown };
  if (l.msg === 'request' && typeof d.method === 'string' && typeof d.path === 'string')
    return `${d.method} ${d.path} → ${String(d.status ?? '')}${typeof d.ms === 'number' ? ` in ${d.ms} ms` : ''}`;
  return l.msg;
}

const StreamEvent = z.object({ seq: z.number(), type: z.literal('log'), line: LogLineSchema });

function params(f: {
  level: LogLevel;
  service: string;
  component: string;
  q: string;
  trace: string;
  range: Range;
}) {
  const p = new URLSearchParams();
  if (f.level !== 'debug') p.set('level', f.level);
  if (f.service) p.set('service', f.service);
  if (f.component) p.set('component', f.component);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.trace) p.set('trace', f.trace);
  const r = RANGES.find((x) => x.value === f.range);
  if (r) p.set('since', new Date(Date.now() - r.ms).toISOString());
  return p;
}

export function LogsScreen({ initialTrace = '' }: { initialTrace?: string }) {
  const [level, setLevel] = useState<LogLevel>('info');
  const [service, setService] = useState('');
  const [component, setComponent] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [trace, setTrace] = useState(initialTrace);
  const [range, setRange] = useState<Range>('1h');
  const [live, setLive] = useState(true);
  const [fresh, setFresh] = useState<LogLine[]>([]);
  const [waiting, setWaiting] = useState<LogLine[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [atTop, setAtTop] = useState(true);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Type, then a short pause, then the search runs.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // The time window is fixed when a filter changes (not on every render), so
  // the query key and the live stream stay put until you change something.
  const qs = useMemo(
    () => params({ level, service, component, q: query, trace, range }).toString(),
    [level, service, component, query, trace, range],
  );
  const page = useQuery({
    queryKey: ['ops', 'logs', qs],
    queryFn: () => api.get<LogPage>(`/logs?${qs}&limit=300`),
  });

  // A new filter starts a new stream.
  useEffect(() => {
    setFresh([]);
    setWaiting([]);
    if (!live) return;
    const streamQs = new URLSearchParams(qs);
    streamQs.delete('since');
    return openStream({
      url: `${API_BASE}/logs/stream?${streamQs.toString()}`,
      schema: StreamEvent,
      onEvent: (e) => {
        if (list.current && list.current.scrollTop > 40)
          setWaiting((w) => [e.line, ...w].slice(0, MAX_LINES));
        else setFresh((f) => [e.line, ...f].slice(0, MAX_LINES));
      },
    });
  }, [qs, live]);

  // `/` searches, `l` toggles live: only when not typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === '/') {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === 'l' && !e.metaKey && !e.ctrlKey) setLive((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const lines = useMemo(() => {
    const seen = new Set<number>();
    return [...fresh, ...(page.data?.items ?? [])].filter((l) => !seen.has(l.id) && seen.add(l.id));
  }, [fresh, page.data]);
  const facets = page.data?.facets ?? { services: [], components: [] };
  const exportHref = (format: 'json' | 'csv') => `${API_BASE}/logs/export?${qs}&format=${format}`;

  const showWaiting = () => {
    setFresh((f) => [...waiting, ...f].slice(0, MAX_LINES));
    setWaiting([]);
    list.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="ops logview">
      <div className="logview__bar m-glass">
        <label className="logview__search">
          <Icon name="search" size={13} />
          <input
            ref={search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search messages and fields"
            aria-label="Search the logs"
          />
          {q ? (
            <button
              type="button"
              className="icon-btn icon-btn--xs"
              aria-label="Clear the search"
              onClick={() => setQ('')}
            >
              <Icon name="close" size={10} />
            </button>
          ) : (
            <Kbd keys="/" />
          )}
        </label>
        <Segmented label="Level" size="sm" value={level} options={LEVELS} onChange={setLevel} />
        <select
          className="input input--sm logview__select"
          value={service}
          onChange={(e) => setService(e.target.value)}
          aria-label="Service"
        >
          <option value="">Every service</option>
          {facets.services.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="input input--sm logview__select"
          value={component}
          onChange={(e) => setComponent(e.target.value)}
          aria-label="Component"
        >
          <option value="">Every component</option>
          {facets.components.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <Segmented
          label="Time"
          size="sm"
          value={range}
          options={RANGES.map(({ value, label }) => ({ value, label }))}
          onChange={setRange}
        />
        <span className="logview__spacer" />
        <span className="logview__live" data-on={live || undefined}>
          <Switch checked={live} onChange={setLive} label="Follow live" />
          <span>Live</span>
          <Kbd keys="l" />
        </span>
        <a className="btn btn--ghost btn--sm" href={exportHref('json')} download>
          <Icon name="download" size={13} />
          JSON
        </a>
        <a className="btn btn--ghost btn--sm" href={exportHref('csv')} download>
          <Icon name="download" size={13} />
          CSV
        </a>
      </div>

      {trace ? (
        <div className="logview__trace">
          <Icon name="tree" size={13} />
          Lines from trace <code>{trace.slice(0, 12)}</code>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setTrace('')}>
            Show every trace
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() =>
              void navigate({
                to: '/admin/$section',
                params: { section: 'traces' },
                search: { trace } as never,
              })
            }
          >
            Open the trace
          </button>
        </div>
      ) : null}

      {waiting.length ? (
        <button type="button" className="logview__waiting" onClick={showWaiting}>
          <Icon name="arrowUp" size={12} />
          {waiting.length} new {waiting.length === 1 ? 'line' : 'lines'}
        </button>
      ) : null}

      {page.isPending ? (
        <Skeleton lines={10} label="Loading logs" />
      ) : page.isError && !page.data ? (
        <LoadFailed error={page.error} what="The logs" onRetry={() => void page.refetch()} />
      ) : lines.length === 0 ? (
        <EmptyState
          icon="logs"
          title="Nothing matches"
          body={
            live
              ? 'New lines appear here as they are written. Widen the time or level to see more.'
              : 'Widen the time or level to see more.'
          }
        />
      ) : (
        <div
          ref={list}
          className="logview__list"
          role="log"
          aria-live="off"
          onScroll={(e) => setAtTop(e.currentTarget.scrollTop < 40)}
          data-at-top={atTop || undefined}
        >
          {lines.map((l) => {
            const expanded = open === l.id;
            const fields = Object.keys(l.data).length;
            return (
              <div key={l.id} className="logline" data-level={l.level} data-open={expanded || undefined}>
                <button
                  type="button"
                  className="logline__row"
                  onClick={() => setOpen(expanded ? null : l.id)}
                  aria-expanded={expanded}
                >
                  <span className="logline__time" data-num>
                    {clock(l.at)}
                  </span>
                  <span className="logline__level" data-level={l.level}>
                    {l.level}
                  </span>
                  <span className="logline__svc">{l.service}</span>
                  <span className="logline__comp mute">{l.component ?? ''}</span>
                  <span className="logline__msg" dir="auto">
                    {messageOf(l)}
                  </span>
                  {fields ? <span className="logline__fields mute">{fields}</span> : null}
                </button>
                {expanded ? (
                  <div className="logline__detail">
                    <pre className="logline__json">{JSON.stringify(l.data, null, 2)}</pre>
                    <div className="logline__meta">
                      <span className="mute">{new Date(l.at).toLocaleString('en-GB')}</span>
                      {l.trace_id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setTrace(l.trace_id ?? '')}
                          >
                            <Icon name="filter" size={12} />
                            Only this trace
                          </button>
                          <button
                            type="button"
                            className="btn btn--quiet btn--sm"
                            onClick={() =>
                              void navigate({
                                to: '/admin/$section',
                                params: { section: 'traces' },
                                search: { trace: l.trace_id } as never,
                              })
                            }
                          >
                            <Icon name="tree" size={12} />
                            Open trace
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
