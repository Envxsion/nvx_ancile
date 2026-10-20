/**
 * ------------------------------------------------------------------
 *  Title    |  The plan's monthly API credit
 *  Ref      |  docs/models.md (Monthly API credit) · roadmap CR1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A Max or Team plan includes a monthly API credit. This
 *           |  is where the Anthropic key is marked as drawing on it,
 *           |  and the meter that shows this cycle's spend.
 *  How      |  GET /providers/anthropic/credit for the count and
 *           |  PUT /credentials/anthropic/plan-credit to save the amount
 *           |  and the reset day. The meter is the same one Usage uses.
 *  Note     |  The count is Ancile's own, from receipts. Anthropic's
 *           |  balance needs an Admin key, which Ancile never asks for,
 *           |  so the words say so.
 * ------------------------------------------------------------------
 */

import { type CreditStatus, PLAN_CREDIT_ARTICLE, type PlanCredit } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { ApiCallError, api } from '../lib/api';
import { usd } from '../lib/format';
import { queryClient } from '../lib/query';
import { Switch } from '../ui/controls';
import { toneOf } from '../usage/api';
import { Meter } from '../usage/Meter';

export const CREDIT_KEY = ['credit'] as const;

export function useCreditStatus(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: CREDIT_KEY,
    queryFn: () => api.get<CreditStatus>('/providers/anthropic/credit'),
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
}

const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The words under the meter, as plain figures. Pure, so the tests can pin them. */
export function creditWords(s: CreditStatus): { spent: string; left: string; renews: string } {
  return {
    spent: `${usd(s.spent_usd)} of ${usd(s.monthly_usd)} used`,
    left: `${usd(s.left_usd)} left`,
    renews: s.exhausted
      ? `Anthropic says it is used up. It renews ${dayMonth(s.cycle_ends)}`
      : `Renews ${dayMonth(s.cycle_ends)}`,
  };
}

/** "Ancile's own count", said once beside any meter. */
export const CREDIT_COUNT_NOTE =
  "This is Ancile's own count from your receipts. Anthropic's balance needs an Admin key, which Ancile never asks for.";

/** The meter and its words; shown on the key card and in Usage. */
export function CreditMeter({ status }: { status: CreditStatus }) {
  const w = creditWords(status);
  const percent = Math.min(100, status.used * 100);
  return (
    <div className="credit-meter">
      <Meter
        percent={percent}
        tone={status.exhausted ? 'over' : toneOf(percent, 100, 80)}
        size="large"
        label={`Monthly API credit: ${w.spent}`}
      />
      <p className="credit-meter__line" data-num>
        {w.spent} · {w.left} · {w.renews}
      </p>
      <p className="mute credit-meter__note">{CREDIT_COUNT_NOTE}</p>
    </div>
  );
}

function zone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Settings → API keys → Anthropic: "Draws from my plan's monthly credit". */
export function PlanCreditSetting({ saved }: { saved: PlanCredit | null | undefined }) {
  const ids = { amount: useId(), day: useId(), note: useId() };
  const [enabled, setEnabled] = useState(saved?.enabled ?? false);
  const [amount, setAmount] = useState(String(saved?.monthly_usd ?? 100));
  const [day, setDay] = useState(String(saved?.resets_on_day ?? 1));
  const status = useCreditStatus({ enabled: saved?.enabled === true });

  const amountNumber = Number(amount);
  const dayNumber = Number(day);
  const valid =
    Number.isFinite(amountNumber) &&
    amountNumber > 0 &&
    amountNumber <= 10_000 &&
    Number.isInteger(dayNumber) &&
    dayNumber >= 1 &&
    dayNumber <= 31;
  const dirty =
    enabled !== (saved?.enabled ?? false) ||
    (enabled && (amountNumber !== saved?.monthly_usd || dayNumber !== saved?.resets_on_day));

  const save = useMutation({
    mutationFn: (next: PlanCredit) => api.put<CreditStatus>('/credentials/anthropic/plan-credit', next),
    onSuccess: (s) => {
      queryClient.setQueryData(CREDIT_KEY, s);
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      void queryClient.invalidateQueries({ queryKey: ['flows', 'models'] });
      void queryClient.invalidateQueries({ queryKey: ['usage'] });
    },
  });

  const failure =
    save.error instanceof ApiCallError
      ? `${save.error.body.error.title}. ${save.error.body.error.hint}`
      : save.error
        ? 'NVX Ancile did not answer. Check that it is running, then try again.'
        : null;

  return (
    <div className="credit-setting">
      <div className="credit-setting__head">
        <Switch
          checked={enabled}
          onChange={(v) => {
            save.reset();
            setEnabled(v);
          }}
          label="Draws from my plan's monthly credit"
          describedBy={ids.note}
        />
        <span className="credit-setting__title">Draws from my plan's monthly credit</span>
      </div>
      <p id={ids.note} className="setting__desc">
        Max and Team plans include a monthly API credit in one Claude Console organisation. Any API key from
        it spends the credit first, and requests stop, never charged to your plan, when it runs out.{' '}
        <a className="credential__get" href={PLAN_CREDIT_ARTICLE} target="_blank" rel="noreferrer">
          How the credit works
        </a>
      </p>
      {enabled ? (
        <div className="credit-setting__fields">
          <div>
            <label htmlFor={ids.amount} className="setting__label">
              Monthly credit (US dollars)
            </label>
            <input
              id={ids.amount}
              className="input input--sm"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                save.reset();
                setAmount(e.target.value);
              }}
              aria-invalid={!valid || undefined}
            />
          </div>
          <div>
            <label htmlFor={ids.day} className="setting__label">
              Resets on day of the month
            </label>
            <input
              id={ids.day}
              className="input input--sm"
              inputMode="numeric"
              value={day}
              onChange={(e) => {
                save.reset();
                setDay(e.target.value);
              }}
              aria-invalid={!valid || undefined}
            />
          </div>
        </div>
      ) : null}
      {enabled && !valid ? (
        <p className="setting__desc" role="alert">
          Enter an amount above $0 and a day from 1 to 31.
        </p>
      ) : null}
      {dirty ? (
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={(enabled && !valid) || save.isPending}
          onClick={() =>
            save.mutate({
              enabled,
              monthly_usd: enabled && valid ? amountNumber : (saved?.monthly_usd ?? 100),
              resets_on_day: enabled && valid ? dayNumber : (saved?.resets_on_day ?? 1),
              ...(zone() && { tz: zone() as string }),
            })
          }
        >
          {save.isPending ? 'Saving…' : 'Save credit settings'}
        </button>
      ) : null}
      {failure ? (
        <p className="setting__desc" role="alert">
          {failure}
        </p>
      ) : null}
      {saved?.enabled && status.data?.enabled ? <CreditMeter status={status.data} /> : null}
    </div>
  );
}
