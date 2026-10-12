/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code plan limits
 *  Ref      |  docs/claude-code.md (Usage)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  How much of a Claude plan's session and weekly limits is
 *           |  used, as Claude Code's own /usage says it: "Current
 *           |  session (5 hours): 42% used, resets at 3:40 pm".
 *  How      |  usePlanLimits. Each window is a calm meter (neutral,
 *           |  --warn from 70%, --fail from 90%) with its words, then
 *           |  "Updated 2 min ago" and Refresh. An API key sign-in is
 *           |  told plainly that plan limits do not apply.
 *  Note     |  No account, email or organisation is ever shown.
 * ------------------------------------------------------------------
 */

import type { ClaudeCodePlanLimits } from '@nvx/contracts';
import { useEffect, useState } from 'react';
import { Icon } from '../ui/Icon';
import { refreshPlanLimits, resetWords, toneOf, updatedWords, usePlanLimits, windowTitle } from './api';
import { Meter } from './Meter';

export const NOT_A_PLAN = 'Plan limits apply to Claude subscription sign-ins only.';

function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function PlanWindows({
  limits,
  compact = false,
  now,
}: {
  limits: ClaudeCodePlanLimits;
  compact?: boolean;
  now: number;
}) {
  const windows = compact ? limits.windows.filter((w) => w.kind !== 'other') : limits.windows;
  return (
    <ul className="u-plan" data-compact={compact || undefined}>
      {windows.map((w) => {
        const resets = resetWords(w.resets_at, now);
        const title = windowTitle(w);
        const note =
          w.status === 'rejected'
            ? ['Limit reached', resets].filter(Boolean).join(', ')
            : resets
              ? `${resets[0]?.toUpperCase()}${resets.slice(1)}`
              : null;
        return (
          <li key={w.id} className="u-plan__row" data-kind={w.kind}>
            <div className="u-plan__head">
              <span className="u-plan__title">{title}</span>
              <span className="u-plan__pct" data-num>
                {w.percent === null ? 'Not reported' : `${Math.round(w.percent)}% used`}
              </span>
            </div>
            <Meter
              percent={w.percent}
              tone={w.status === 'rejected' ? 'over' : toneOf(w.percent)}
              size={compact ? 'small' : 'large'}
              label={`${title}: ${w.percent === null ? 'not reported' : `${Math.round(w.percent)}% used`}`}
            />
            {note ? <span className="u-plan__reset">{note}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The plan limits block: in Settings → Usage, and folded into Claude Code's usage popover. */
export function PlanLimits({ compact = false }: { compact?: boolean }) {
  const q = usePlanLimits();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const limits = q.data;

  const refresh = async () => {
    setBusy(true);
    try {
      await refreshPlanLimits();
    } catch {
      /* the figures shown stay; the query reports its own errors */
    } finally {
      setBusy(false);
      setAsked(true);
    }
  };

  if (q.isLoading) return <p className="u-quiet">Reading Claude Code's limits…</p>;
  if (!limits)
    return <p className="u-quiet">Claude Code's limits could not be read. Try again in a moment.</p>;

  const refreshButton = limits.can_refresh ? (
    <button
      type="button"
      className="u-refresh"
      onClick={() => void refresh()}
      disabled={busy}
      aria-label="Refresh Claude Code's plan limits"
    >
      <Icon name="regenerate" size={12} />
      <span>{busy ? 'Asking Claude Code' : 'Refresh'}</span>
    </button>
  ) : null;

  if (limits.available === false)
    return (
      <div className="u-plan-empty">
        <p>{NOT_A_PLAN}</p>
        <p className="u-quiet">
          Claude Code is signed in with an API key or a cloud provider, so it is billed per token instead.
        </p>
      </div>
    );

  if (!limits.windows.length)
    return (
      <div className="u-plan-empty">
        <p>
          {limits.can_refresh
            ? asked
              ? 'Claude Code has not reported its limits yet. They appear after its next answer.'
              : "Claude Code's limits show here once it reports them."
            : 'Install and sign in to Claude Code (Settings → Claude Code) to see its plan limits here.'}
        </p>
        {refreshButton}
      </div>
    );

  return (
    <div className="u-plan-wrap">
      <PlanWindows limits={limits} compact={compact} now={now} />
      <div className="u-plan__foot">
        <span className="u-quiet">
          {updatedWords(limits.updated_at, now)}
          {limits.plan && !compact ? ` · ${limits.plan[0]?.toUpperCase()}${limits.plan.slice(1)} plan` : ''}
        </span>
        {refreshButton}
      </div>
    </div>
  );
}
