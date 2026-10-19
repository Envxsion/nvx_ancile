/**
 * ------------------------------------------------------------------
 *  Title    |  Settings, Auto mode: Check my reviewers
 *  Ref      |  docs/auto-mode.md (Check my reviewers) · ROADMAP R2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Run Auto mode's built-in safety cases through the
 *           |  reviewers you set up, and see what each category
 *           |  caught, missed, and asked about for no reason.
 *  How      |  GET /auto/reviewer-check says what will be asked and
 *           |  the most it can cost, before anything happens. The
 *           |  button is the only thing that starts a run
 *           |  (POST /auto/reviewer-check with confirm true).
 *  Note     |  It reports. It changes no floor, threshold or setting.
 * ------------------------------------------------------------------
 */

import type { ReviewerCheckEstimate, ReviewerCheckResult } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';
import { ApiCallError, api } from '../lib/api';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import '../styles/auto.css';
import { LoadFailed } from '../ui/LoadFailed';
import { Skeleton } from '../ui/primitives';

const KEYWORDS = 'auto mode reviewer check safety injection jev evals test';

export const usd = (n: number) => (n === 0 ? '$0' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`);

/** What the button promises, in words, before it is pressed. */
export function costWords(e: ReviewerCheckEstimate): string {
  if (!e.costs_money)
    return e.first_reviewer
      ? 'It runs on this computer and costs nothing.'
      : 'No reviewer is set up, so only the built-in rules are checked. It costs nothing.';
  const basis =
    e.price_basis === 'assumed'
      ? ' Its price is not published, so this uses a cautious rate.'
      : ' That is worked out from its listed price.';
  return `About ${e.reviewer_calls} calls (around ${e.est_input_tokens.toLocaleString('en-GB')} tokens in) go to a paid reviewer, for no more than ${usd(e.est_usd_max)}.${basis} The run stops if the cost reported gets there. The cases are fixed examples, nothing from your work.`;
}

export function ResultTable({ r }: { r: ReviewerCheckResult }) {
  return (
    <>
      <table className="rcheck__table">
        <caption className="sr-only">Auto mode check results by category</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Caught</th>
            <th scope="col">Missed</th>
            <th scope="col">False alarms</th>
          </tr>
        </thead>
        <tbody>
          {r.categories.map((c) => (
            <tr key={c.category}>
              <th scope="row">{c.category}</th>
              <td data-num>
                {c.caught} of {c.injection_cases}
              </td>
              <td data-num className={c.missed ? 'rcheck__bad' : undefined}>
                {c.missed}
              </td>
              <td data-num>
                {c.false_alarms} of {c.normal_cases}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="rcheck__total">
            <th scope="row">All</th>
            <td data-num>
              {r.caught} of {r.injection_cases}
            </td>
            <td data-num className={r.missed ? 'rcheck__bad' : undefined}>
              {r.missed}
            </td>
            <td data-num>
              {r.false_alarms} of {r.normal_cases}
            </td>
          </tr>
        </tfoot>
      </table>
      <ul className="rcheck__facts">
        <li>
          {r.false_alarms_per_10} false alarms in every 10 ordinary calls. The built-in rules stopped{' '}
          {r.caught_by_rules} of the {r.caught} caught before a reviewer was asked.
        </li>
        <li>Cost {usd(r.cost_usd)}.</li>
        {r.stopped_at_ceiling ? (
          <li>It stopped asking the paid reviewer at its limit, so the rules decided the rest.</li>
        ) : null}
        {r.missed_names.length ? <li>Missed: {r.missed_names.join('; ')}.</li> : null}
        {r.false_alarm_names.length ? <li>Asked for nothing: {r.false_alarm_names.join('; ')}.</li> : null}
      </ul>
    </>
  );
}

export function CheckReviewers() {
  const q = useContext(SearchContext);
  const shown = matches(q, 'check my reviewers', KEYWORDS);
  const estimate = useQuery({
    queryKey: ['auto', 'reviewer-check'],
    queryFn: () => api.get<ReviewerCheckEstimate>('/auto/reviewer-check'),
    staleTime: 60_000,
    enabled: shown,
  });
  const run = useMutation({
    mutationFn: () => api.post<ReviewerCheckResult>('/auto/reviewer-check', { confirm: true }),
  });
  if (!shown) return null;
  const e = estimate.data;
  const problem =
    run.error instanceof ApiCallError
      ? `${run.error.body.error.title}. ${run.error.body.error.hint}`
      : run.error
        ? 'NVX Ancile did not answer. Check that it is running, then try again.'
        : null;
  return (
    <Block
      title="Check my reviewers"
      lede="Auto mode's safety checks normally run only when NVX Ancile is built. Run them here, against the reviewers you set up. No tool runs."
    >
      <div className="setting" data-stack>
        <div className="setting__words">
          {estimate.isError ? (
            <LoadFailed error={estimate.error} what="The check" onRetry={() => estimate.refetch()} />
          ) : !e ? (
            <Skeleton lines={2} />
          ) : (
            <>
              <p className="setting__desc">
                {e.injection_cases} cases carry an injection and {e.normal_cases} are an ordinary coding
                session. {costWords(e)}
              </p>
              <p className="setting__desc mute">
                Asked in this order:{' '}
                {e.reviewers.map((r) => `${r.label}${r.available ? '' : ' (not set up)'}`).join(', ')}.
              </p>
            </>
          )}
        </div>
        <div className="setting__control">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!e || run.isPending}
            aria-busy={run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending
              ? 'Checking'
              : e?.costs_money
                ? `Run the check (up to ${usd(e.est_usd_max)})`
                : 'Run the check'}
          </button>
        </div>
      </div>
      {problem ? (
        <p className="setting__desc" role="alert">
          {problem}
        </p>
      ) : null}
      {run.data ? (
        <div className="setting" data-stack>
          <div className="setting__words">
            <ResultTable r={run.data} />
          </div>
        </div>
      ) : null}
    </Block>
  );
}
