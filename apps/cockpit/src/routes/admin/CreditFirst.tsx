/**
 * ------------------------------------------------------------------
 *  Title    |  Routing goal: spend expiring credit first
 *  Ref      |  docs/models.md (Monthly API credit) · roadmap RT1, CR1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Unused monthly credit expires at the end of the cycle.
 *           |  This goal puts a model paid from it ahead of an equal
 *           |  model on another bill, in the last days of the cycle.
 *  How      |  GET and PUT /routing/credit-first. Shown in Admin →
 *           |  Routing only while the credit is set up. Off by default.
 * ------------------------------------------------------------------
 */

import type { CreditRouting } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useCreditStatus } from '../../credentials/PlanCredit';
import { api } from '../../lib/api';
import { queryClient } from '../../lib/query';
import { Switch } from '../../ui/controls';

const KEY = ['routing', 'credit-first'] as const;

export function CreditFirst() {
  const credit = useCreditStatus();
  const goal = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<CreditRouting>('/routing/credit-first'),
    enabled: credit.data?.enabled === true,
  });
  const save = useMutation({
    mutationFn: (next: CreditRouting) => api.put<CreditRouting>('/routing/credit-first', next),
    onSuccess: (next) => queryClient.setQueryData(KEY, next),
  });
  const noteId = useId();
  const daysId = useId();
  const [days, setDays] = useState<string | null>(null);
  if (!credit.data?.enabled || !goal.data) return null;
  const on = goal.data.spend_credit_first;
  const shown = days ?? String(goal.data.last_days);
  const n = Number(shown);
  const valid = Number.isInteger(n) && n >= 1 && n <= 31;
  return (
    <div className="route-goal">
      <div className="route-goal__head">
        <Switch
          checked={on}
          disabled={save.isPending}
          onChange={(v) => save.mutate({ ...goal.data, spend_credit_first: v })}
          label="Spend expiring credit first"
          describedBy={noteId}
        />
        <span className="route-goal__title">Spend expiring credit first</span>
      </div>
      <p id={noteId} className="mute">
        In the last days of a cycle, with credit left, a model paid from your monthly credit goes ahead of an
        equal model on another bill. Unused credit expires, so this uses it up. Off by default.
      </p>
      {on ? (
        <div className="route-goal__days">
          <label htmlFor={daysId}>Start this many days before the credit renews</label>{' '}
          <input
            id={daysId}
            className="input input--sm"
            inputMode="numeric"
            value={shown}
            aria-invalid={!valid || undefined}
            onChange={(e) => setDays(e.target.value)}
            onBlur={() => {
              if (valid && n !== goal.data.last_days) save.mutate({ ...goal.data, last_days: n });
              setDays(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
