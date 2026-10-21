/**
 * ------------------------------------------------------------------
 *  Title    |  Settings → Usage
 *  Ref      |  docs/claude-code.md (Usage) · docs/api.md (Usage)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Where you see what you have used: the live context of
 *           |  the thread you last had open (where the status bar's
 *           |  meter leads), Claude Code's plan limits (as its own
 *           |  /usage shows them), then what NVX Ancile measured of
 *           |  Claude Code (tokens in, out and from cache today and
 *           |  over 7 days, the cache hit rate, the busiest threads,
 *           |  and how much came in with terminal sessions), then
 *           |  NVX Ancile's totals across every engine, today or over
 *           |  the last 7 or 30 days, by engine and by model. No block
 *           |  is ever blank: an empty one says why and what will
 *           |  appear, a slow one shows a skeleton, a failed one says
 *           |  so with Try again.
 *  How      |  LiveContext, usePlanLimits, useClaudeCodeUsage and useUsageReport. The bars are plain
 *           |  SVG, stacked by engine in the engines' own hues. GPU
 *           |  compute comes from the Controller's month (Admin →
 *           |  Compute). Pro's Insights, when unlocked, goes deeper.
 *  Note     |  Claude Code's cost reads "Included in your Claude plan"
 *           |  (usage/planCost.ts); its estimate at API list prices is
 *           |  never added to a total as if it were billed.
 * ------------------------------------------------------------------
 */

import type { UsageRange, UsageReport } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { useContext, useState } from 'react';
import { openClaudeCodeSessions } from '../claudecode/SessionsDialog';
import { useComputeStatus, useCosts } from '../compute/data';
import { CreditMeter } from '../credentials/PlanCredit';
import { useProFeature } from '../pro/slot';
import { matches, SearchContext } from '../routes/settings/rows';
import { Segmented } from '../ui/controls';
import { LoadFailed } from '../ui/LoadFailed';
import { Skeleton } from '../ui/primitives';
import { costWords, ENGINE_WORDS, modelWords, tokensWords, useClaudeCodeUsage, useUsageReport } from './api';
import { LiveContext } from './LiveContext';
import { PlanLimits } from './PlanLimits';
import { IN_PLAN, useClaudeBilling } from './planCost';

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
  tour,
}: {
  title: string;
  tour?: string;
  rows: { key: string; label: string; engine: string; tokens: number; cost: number; answers: number }[];
  total: number;
}) {
  const billed = useClaudeBilling(rows.some((r) => r.engine === 'claude_code'));
  return (
    <section className="u-break" aria-label={title} data-tour={tour}>
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
            {r.engine === 'claude_code' && !billed ? (
              <span className="u-break__num u-quiet" title={IN_PLAN}>
                <span aria-hidden="true">In plan</span>
                <span className="sr-only">{IN_PLAN}</span>
              </span>
            ) : (
              <span className="u-break__num u-quiet" data-num>
                {costWords(r.cost)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What a model call was for, in plain words. */
const PURPOSE_WORDS: Record<string, string> = {
  chat: 'Chat answers',
  factcheck: 'Fact-checks',
  memory: 'Memory',
  decision: 'Decisions',
  permission: 'Permission checks',
  title: 'Titles',
  compare: 'Comparisons',
  thread: 'Thread tools',
  web: 'Web lookups',
  knowledge: 'Sources',
  other: 'Other',
};

export function AncileUsage({ report, provider = '' }: { report: UsageReport; provider?: string }) {
  const t = report.totals;
  const billed = useClaudeBilling(report.estimated_cost_usd > 0);
  // Claude Code's estimate is not a bill when your Claude plan covers it, so it stays out of the total.
  const cost = billed ? t.cost_usd : Math.max(0, t.cost_usd - report.estimated_cost_usd);
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
  // Shown only once something besides chat answers has spent tokens: until then it would say nothing.
  const purposes = report.by_purpose ?? [];
  const purposeRows = purposes.map((p) => ({
    key: p.purpose,
    label: PURPOSE_WORDS[p.purpose] ?? p.purpose,
    engine: 'gateway',
    tokens: p.input_tokens + p.output_tokens,
    cost: p.cost_usd,
    answers: p.calls,
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
          <dd data-num>{costWords(cost)}</dd>
          {report.estimated_cost_usd > 0 ? (
            <dd className="u-quiet">
              {billed
                ? `${costWords(report.estimated_cost_usd)} of it is Claude Code's estimate at API list prices, billed to ${billed}`
                : `Claude Code is included in your Claude plan (about ${costWords(report.estimated_cost_usd)} at API list prices, not added here)`}
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
          {purposes.some((p) => p.purpose !== 'chat') ? (
            <Breakdown title="By purpose" rows={purposeRows} total={tokens} tour="usage-purpose" />
          ) : null}
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
      ) : (
        <p className="u-quiet u-empty-line">
          {provider
            ? `Nothing served by ${provider} in this range.`
            : 'Once something answers in this range, its tokens and cost split here by engine, by model and by OpenRouter provider.'}
        </p>
      )}
    </div>
  );
}

const inOut = (t: { input_tokens: number; output_tokens: number; cached_tokens: number }) =>
  `${tokensWords(t.input_tokens)} in · ${tokensWords(t.output_tokens)} out · ${tokensWords(t.cached_tokens)} from cache`;

/** What NVX Ancile measured of Claude Code on this computer: its own count, not the plan's. */
export function ClaudeCodeMeasured() {
  const q = useClaudeCodeUsage();
  if (q.isPending) return <Skeleton lines={3} label="Adding up Claude Code's usage" />;
  if (q.isError || !q.data)
    return <LoadFailed compact error={q.error} what="Claude Code's usage" onRetry={() => q.refetch()} />;
  const u = q.data;
  if (u.week.answers === 0)
    return (
      <div className="u-plan-empty">
        <p>No Claude Code answers in the last 7 days.</p>
        <p className="u-quiet">
          Once Claude Code answers in a thread, as a model, or in a terminal session brought in here, this
          shows its tokens in, out and from cache today and over the week, how much its prompt cache saved,
          and its busiest threads.
        </p>
        <p className="u-quiet">
          <button type="button" className="link-btn" onClick={() => openClaudeCodeSessions()}>
            See Claude Code sessions
          </button>
        </p>
      </div>
    );
  const imported = u.imported ?? null;
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
      {imported && imported.answers > 0 ? (
        <p className="u-quiet u-empty-line" data-num>
          {`Includes ${tokensWords(imported.input_tokens + imported.output_tokens + imported.cached_tokens)} tokens from ${imported.sessions.toLocaleString('en-GB')} ${imported.sessions === 1 ? 'session' : 'sessions'} run in the terminal and brought in.`}
        </p>
      ) : (
        <p className="u-quiet u-empty-line">
          All of it from Claude Code here. A session run in the terminal counts too once it is brought in.{' '}
          <button type="button" className="link-btn" onClick={() => openClaudeCodeSessions()}>
            See sessions
          </button>
        </p>
      )}
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
      ) : (
        <p className="u-quiet u-empty-line">No single thread stands out this week.</p>
      )}
    </div>
  );
}

function ComputeMonth() {
  const status = useComputeStatus();
  const on = !!status.data?.configured && !!status.data.reachable;
  const costs = useCosts(on);
  const c = costs.data;
  // Not set up: GPU compute is not part of this page, so nothing to explain.
  if (!status.data?.configured) return null;
  if (!on)
    return (
      <p className="u-compute">
        <span>GPU compute this month</span>
        <span className="u-quiet">The Controller is not answering, so it is not counted here.</span>
      </p>
    );
  if (costs.isError)
    return (
      <div className="u-compute">
        <LoadFailed compact error={costs.error} what="GPU compute costs" onRetry={() => costs.refetch()} />
      </div>
    );
  if (!c) return null;
  if (c.nodes.length === 0)
    return (
      <p className="u-compute">
        <span>GPU compute this month</span>
        <span className="u-quiet">No GPU node has run this month.</span>
      </p>
    );
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
  if (
    !matches(
      q,
      'Usage',
      'plan limits session week tokens cost context cache threads pace Claude Code monthly credit',
    )
  )
    return null;
  return (
    <div className="u-view">
      <section className="setting-block" aria-labelledby="u-context-title">
        <header className="setting-block__head">
          <h2 id="u-context-title">Context now</h2>
          <p className="mute">How full the thread you last had open is, and when it compacts.</p>
        </header>
        <div className="u-card m-raised">
          <LiveContext />
        </div>
      </section>

      {all.data?.credit?.enabled ? (
        <section className="setting-block" aria-labelledby="u-credit-title">
          <header className="setting-block__head">
            <h2 id="u-credit-title">Monthly API credit</h2>
            <p className="mute">The credit that comes with your plan, spent by your Anthropic key.</p>
          </header>
          <div className="u-card m-raised">
            <CreditMeter status={all.data.credit} />
          </div>
        </section>
      ) : null}

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
            Measured from Claude Code answers on this computer. Use on claude.ai, and terminal sessions not
            brought in, is not counted.
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
            <AncileUsage report={report.data} provider={provider} />
          ) : report.isError ? (
            <LoadFailed compact error={report.error} what="Usage" onRetry={() => report.refetch()} />
          ) : (
            <Skeleton lines={4} label="Adding up usage" />
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
