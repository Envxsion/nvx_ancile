/**
 * ------------------------------------------------------------------
 *  Title    |  /privacy/policy
 *  Ref      |  docs/privacy.md · docs/api.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read and change what private notebooks may use, for
 *           |  Settings → Private notebooks.
 *  How      |  GET answers the policy and a row for every capability.
 *           |  PUT changes the switchable ones; a locked or unknown
 *           |  capability in the body is refused (privacy.locked).
 * ------------------------------------------------------------------
 */

import { PutPrivacyPolicyRequest, SWITCHABLE_CAPABILITIES, type SwitchableCapability } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { lockedError, type PrivacyPolicies } from './policy';

export function privacyRoutes(policies: PrivacyPolicies) {
  const r = new Hono<AppEnv>();
  r.get('/privacy/policy', async (c) => c.json(await policies.settings()));
  r.put('/privacy/policy', async (c) => {
    const { policy } = await body(c, PutPrivacyPolicyRequest);
    const bad = Object.keys(policy).find((k) => !(SWITCHABLE_CAPABILITIES as readonly string[]).includes(k));
    if (bad) throw lockedError(bad);
    await policies.update(policy as Partial<Record<SwitchableCapability, { allowed_in_private: boolean }>>);
    return c.json(await policies.settings());
  });
  return r;
}
