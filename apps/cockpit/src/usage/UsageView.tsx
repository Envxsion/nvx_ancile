/**
 * ------------------------------------------------------------------
 *  Title    |  Settings → Usage
 *  Ref      |  docs/claude-code.md (Usage) · docs/api.md (Usage)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Where you see what you have used: Claude Code's plan
 *           |  limits first (as its own /usage shows them), then what
 *           |  NVX Ancile measured of Claude Code here (tokens in, out
 *           |  and from cache today and over 7 days, the cache hit
 *           |  rate, the busiest threads), then NVX Ancile's totals
 *           |  across every engine, today or over the last 7 or 30
 *           |  days, by engine and by model. No block is ever blank: an
 *           |  empty one says what will appear.
 *  How      |  usePlanLimits, useClaudeCodeUsage and useUsageReport. The bars are plain
 *           |  SVG, stacked by engine in the engines' own hues. GPU
 *           |  compute comes from the Controller's month (Admin →
 *           |  Compute). Pro's Insights, when unlocked, goes deeper.
 *  Note     |  Claude Code's cost is its own estimate at API list
 *           |  prices, never your bill, and the page says so.
 * ------------------------------------------------------------------
 */

import type { UsageRange, UsageReport } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { useContext, useState } from 'react';
import { useComputeStatus, useCosts } from '../compute/data';
import { useProFeature } from '../pro/slot';
import { matches, SearchContext } from '../routes/settings/rows';
import { Segmented } from '../ui/controls';
import { costWords, ENGINE_WORDS, modelWords, tokensWords, useClaudeCodeUsage, useUsageReport } from './api';
import { PlanLimits } from './PlanLimits';

const RANGES: { value: UsageRange; label: string }[] = [
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
];

const ENGINE_ORDER = ['gateway', 'claude_code', 'lab', 'other'] as const;

/** "14:00" for an hour, "Mon 12" for a day. */
function bucketLabel(start: string, bucket: 'hour' | 'day'): string {
  if (bucket === 'hour') return start.slice(11, 16);
  const d = new Date(`${start}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function UsageChart({ report }: { report: UsageReport }) {
  const series = report.series;
  const max = Math.max(1, ...series.map((s) => s.tokens));
  const w = 100 / Math.max(1, series.length);
  const gap = Math.min(w * 0.25, 1.2);
  const every = report.bucket === 'hour' ? 6 : series.length > 10 ? 5 : 1;
  const empty = series.every((s) => s.tokens === 0);
  return (
    <figure className="u-chart" aria-label={`Tokens by ${report.bucket}`}>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-hidden={empty || undefined}>
        <title>{`Tokens by ${report.bucket}`}</title>
        {series.map((s, i) => {
          let y = 40;
          return (
            <g key={s.start}>
              <title>{`${bucketLabel(s.start, report.bucket)}: ${tokensWords(s.tokens)} tokens`}</title>
              {ENGINE_ORDER.map((e) => {
                const v = s.by_engine[e] ?? 0;
                if (!v) return null;
                const h = Math.max(0.6, (v / max) * 38);
                y -= h;
                return (
                  <rect
                    key={e}
                    className="u-chart__bar"
                    data-engine={e}
                    x={i * w + gap / 2}
                    y={y}
                    width={w - gap}
                    height={h}
                    rx={0.4}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <figcaption className="u-chart__axis" aria-hidden="true">
        {series.map((s, i) => (
          <span key={s.start} style={{ left: `${(i + 0.5) * w}%` }}>
            {i % every === 0 ? bucketLabel(s.start, report.bucket) : ''}
          </span>
        ))}
      </figcaption>
      {empty ? <p className="u-chart__empty">Nothing used in this range yet.</p> : null}
    </figure>
  );
}

function Breakdown({
  title,
  rows,
  total,
}: {
  title: string;
  rows: { key: string; label: string; engine: string; tokens: number; cost: number; answers: number }[];
  total: number;
}) {
  return (
    <section className="u-break" aria-label={title}>
      <h3 className="u-h3">{title}</h3>
      <ul>
        {rows.map((r) => (
          <li key={r.key} className="u-break__row">
            <span className="u-break__swatch" data-engine={r.engine} aria-hidden="true" />
            <span className="u-break__label">{r.label}</span>
            <span className="u-break__bar" aria-hidden="true">
              <span data-engine={r.engine} style={{ transform: `scaleX(${total ? r.tokens / total : 0})` }} />
            </span>
            <span className="u-break__num" data-num>
              {tokensWords(r.tokens)}
            </span>
            <span className="u-break__num u-quiet" data-num>
              {costWords(r.cost)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AncileUsage({ report }: { report: UsageReport }) {
  const t = report.totals;
  const tokens = t.input_tokens + t.output_tokens;
  const engines = report.by_engine.map((e) => ({
    key: e.engine,
    label: ENGINE_WORDS[e.engine] ?? e.engine,
    engine: e.engine,
    tokens: e.input_tokens + e.output_tokens,
    cost: e.cost_usd,
    answers: e.answers,
  }));
  const models = report.by_model.map((m) => ({
    key: `${m.engine}|${m.model_id ?? 'rest'}`,
    label: modelWords(m.model_id),
    engine: m.model_id ? m.engine : 'other',
    tokens: m.input_tokens + m.output_tokens,
    cost: m.cost_usd,
    answers: m.answers,
  }));
  return (
    <div className="u-ancile">
      <dl className="u-totals">
        <div>
          <dt>Tokens</dt>
          <dd data-num>{tokensWords(tokens)}</dd>
          <dd className="u-quiet" data-num>
            {tokensWords(t.input_tokens)} in · {tokensWords(t.output_tokens)} out
            {t.cached_tokens ? ` · ${tokensWords(t.cached_tokens)} from cache` : ''}
          </dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd data-num>{costWords(t.cost_usd)}</dd>
          {report.estimated_cost_usd > 0 ? (
            <dd className="u-quiet">
              {costWords(report.estimated_cost_usd)} of it is Claude Code's estimate at API list prices, not
              your bill
            </dd>
          ) : null}
        </div>
        <div>
          <dt>Answers</dt>
          <dd data-num>{t.answers.toLocaleString('en-GB')}</dd>
        </div>
      </dl>
      <UsageChart report={report} />
      {engines.length ? (
        <div className="u-breaks">
          <Breakdown title="By engine" rows={engines} total={tokens} />
          <Breakdown title="By model" rows={models} total={tokens} />
          {report.by_provider.length ? (
            <Breakdown
              title="By OpenRouter provider"
              rows={report.by_provider.map((p) => ({
                key: p.provider,
                label: p.provider,
                engine: 'gateway',
                tokens: p.input_tokens + p.output_tokens,
                cost: p.cost_usd,
                answers: p.answers,
              }))}
              total={tokens}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const inOut = (t: { input_tokens: number; output_tokens: number; cached_tokens: number }) =>
  `${tokensWords(t.input_tokens)} in · ${tokensWords(t.output_tokens)} out · ${tokensWords(t.cached_tokens)} from cache`;

/** What NVX Ancile measured of Claude Code on this computer: its own count, not the plan's. */
export function ClaudeCodeMeasured() {
  const q = useClaudeCodeUsage();
  if (q.isPending) return <p className="u-quiet">Adding up Claude Code's usage…</p>;
  if (!q.data)
    return <p className="u-quiet">Claude Code's usage could not be read. Try again in a moment.</p>;
  const u = q.data;
  if (u.week.answers === 0)
    return (
      <div className="u-plan-empty">
        <p>No Claude Code answers in NVX Ancile in the last 7 days.</p>
        <p className="u-quiet">
          Once Claude Code answers in a thread, this shows its tokens in, out and from cache today and over
          the week, how much its prompt cache saved, and its busiest threads.
        </p>
      </div>
    );
  return (
    <div className="u-ancile">
      <dl className="u-totals">
        <div>
          <dt>Today</dt>
          <dd data-num>
            {tokensWords(u.today.input_tokens + u.today.output_tokens + u.today.cached_tokens)}
          </dd>
          <dd className="u-quiet" data-num>
            {inOut(u.today)}
          </dd>
        </div>
        <div>
          <dt>Last 7 days</dt>
          <dd data-num>{tokensWords(u.week.input_tokens + u.week.output_tokens + u.week.cached_tokens)}</dd>
          <dd className="u-quiet" data-num>
            {inOut(u.week)}
          </dd>
        </div>
        <div>
          <dt>From cache</dt>
          <dd data-num>{u.cache_hit_rate === null ? 'n/a' : `${Math.round(u.cache_hit_rate * 100)}%`}</dd>
          <dd className="u-quiet">of what it read this week</dd>
        </div>
      </dl>
      {u.by_thread.length ? (
        <section aria-label="Busiest Claude Code threads">
          <h3 className="u-h3">Busiest threads this week</h3>
          <ul className="u-cc-threads">
            {u.by_thread.map((t) => (
              <li key={t.thread_id}>
                <Link to="/t/$threadId" params={{ threadId: t.thread_id }}>
                  {t.title || 'Untitled thread'}
                </Link>
                <span data-num>{tokensWords(t.input_tokens + t.output_tokens + t.cached_tokens)}</span>
                <span className="u-quiet" data-num>
                  {t.answers.toLocaleString('en-GB')} {t.answers === 1 ? 'answer' : 'answers'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ComputeMonth() {
  const status = useComputeStatus();
  const on = !!status.data?.configured && !!status.data.reachable;
  const costs = useCosts(on);
  const c = costs.data;
  if (!on || !c || c.nodes.length === 0) return null;
  return (
    <p className="u-compute">
      <span>GPU compute this month</span>
      <span data-num>{costWords(c.total_to_date)}</span>
      <span className="u-quiet" data-num>
        projected {costWords(c.projected_total)}
      </span>
      <Link to="/admin/$section" params={{ section: 'compute' }} className="link-btn link-btn--quiet">
        Open Compute
      </Link>
    </p>
  );
}

export function UsageGroup() {
  const q = useContext(SearchContext);
  const [range, setRange] = useState<UsageRange>('day');
  const [provider, setProvider] = useState('');
  const all = useUsageReport(range);
  const report = useUsageReport(range, { provider });
  const providers = all.data?.by_provider.map((p) => p.provider) ?? [];
  const insights = useProFeature('insights');
  if (!matches(q, 'Usage', 'plan limits session week tokens cost context cache threads pace Claude Code')) return null;
  return (
    <div className="u-view">
      <section className="setting-block" aria-labelledby="u-plan-title">
        <header className="setting-block__head">
          <h2 id="u-plan-title">Claude Code plan limits</h2>
          <p className="mute">
            How much of your Claude plan's limits Claude Code has used, as its own /usage shows.
          </p>
        </header>
        <div className="u-card m-raised">
          <PlanLimits />
        </div>
      </section>

      <section className="setting-block" aria-labelledby="u-cc-title">
        <header className="setting-block__head">
          <h2 id="u-cc-title">Claude Code in NVX Ancile</h2>
          <p className="mute">
            What NVX Ancile measured from Claude Code's answers on this computer. Use elsewhere (the terminal,
            claude.ai) is not counted here.
          </p>
        </header>
        <div className="u-card m-raised">
          <ClaudeCodeMeasured />
        </div>
      </section>

      <section className="setting-block" aria-labelledby="u-ancile-title">
        <header className="setting-block__head u-head-row">
          <div>
            <h2 id="u-ancile-title">NVX Ancile usage</h2>
            <p className="mute">
              Tokens and recorded cost on this computer, across chat, flows, the lab and Claude Code.
            </p>
          </div>
          <div className="u-head-controls">
            {providers.length || provider ? (
              <select
                className="input input--sm"
                aria-label="OpenRouter provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="">Every provider</option>
                {[...new Set([...providers, ...(provider ? [provider] : [])])].map((p) => (
                  <option key={p} value={p}>
                    Served by {p}
                  </option>
                ))}
              </select>
            ) : null}
            <Segmented label="Range" value={range} options={RANGES} onChange={setRange} size="sm" />
          </div>
        </header>
        <div className="u-card m-raised">
          {report.data ? (
            <AncileUsage report={report.data} />
          ) : report.isError ? (
            <p className="u-quiet">Usage could not be read. Try again in a moment.</p>
          ) : (
            <p className="u-quiet">Adding up usage…</p>
          )}
          <ComputeMonth />
        </div>
        {insights.unlocked ? (
          <p className="u-more">
            <Link to="/admin/$section" params={{ section: 'insights' }} className="link-btn link-btn--quiet">
              More in Insights
            </Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}
