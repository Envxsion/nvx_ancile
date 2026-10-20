/**
 * ------------------------------------------------------------------
 *  Title    |  /providers/anthropic/credit and the credit settings
 *  Ref      |  docs/models.md (Monthly API credit) · roadmap CR1, RT1
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read Ancile's count of this cycle's monthly API credit,
 *           |  mark the Anthropic key as drawing on it, and switch the
 *           |  routing goal "Spend expiring credit first" on or off.
 *  How      |  Thin routes over the CreditLedger. Saving the credit
 *           |  refreshes the model registry, so the monthly-credit
 *           |  models appear or leave at once.
 *  Note     |  The figures are Ancile's own count from receipts, never
 *           |  Anthropic's balance (that needs an Admin key). No key is
 *           |  read or returned here.
 * ------------------------------------------------------------------
 */

import { CreditRouting, type CreditStatus, SavePlanCreditRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { validZone } from '../usage/report';
import type { CreditLedger } from './credit';
import type { ModelRegistry } from './registry';

/** What GET answers while the credit is not set up. */
export const NO_CREDIT: CreditStatus = {
  enabled: false,
  monthly_usd: 0,
  spent_usd: 0,
  left_usd: 0,
  used: 0,
  cycle_start: new Date(0).toISOString(),
  cycle_ends: new Date(0).toISOString(),
  days_left: 0,
  exhausted: false,
  counted_by_ancile: true,
  tz: 'UTC',
};

export function creditRoutes(deps: { ledger: CreditLedger; registry: Pick<ModelRegistry, 'refresh'> }) {
  const r = new Hono<AppEnv>();

  r.get('/providers/anthropic/credit', async (c) => c.json((await deps.ledger.status()) ?? NO_CREDIT));

  r.put('/credentials/anthropic/plan-credit', async (c) => {
    const req = await body(c, SavePlanCreditRequest);
    const tz = validZone(req.tz) ?? undefined;
    await deps.ledger.setConfig({
      enabled: req.enabled,
      monthly_usd: req.monthly_usd,
      resets_on_day: req.resets_on_day,
      ...(tz && { tz }),
    });
    await deps.registry.refresh();
    return c.json((await deps.ledger.status()) ?? NO_CREDIT);
  });

  r.get('/routing/credit-first', (c) => c.json(deps.ledger.routingGoal()));

  r.put('/routing/credit-first', async (c) => {
    await deps.ledger.setRouting(await body(c, CreditRouting));
    return c.json(deps.ledger.routingGoal());
  });

  return r;
}
