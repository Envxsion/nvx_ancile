/**
 * ------------------------------------------------------------------
 *  Title    |  Licence routes
 *  Ref      |  DESIGN.md §9 · Admin → Licence
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Admin → Licence: what this build is, what Pro adds,
 *           |  and turning it on, checking it and moving it.
 *  How      |  Thin: everything goes to the ProLicense the seam
 *           |  loaded (pro/ when present, the free stub otherwise).
 *           |  Details are told as the person asking may use them
 *           |  (their Pro seat in a team). Turning Pro on, checking it
 *           |  and moving it change the licence for everyone here, so
 *           |  they need an admin (the free build's owner is one).
 * ------------------------------------------------------------------
 */

import { ActivateLicenseRequest } from '@nvx/contracts';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { roleAllows, roleTooLow, signInRequired } from '../pro/routes';
import type { Principal, ProLicense } from '../pro/types';

/** Who may change the licence: an admin or an owner. */
function changer(c: Context<AppEnv>): Principal {
  const who = c.get('principal');
  if (!who) throw signInRequired();
  if (!roleAllows(who.role, 'admin')) throw roleTooLow('admin');
  return who;
}

export function licenseRoutes(deps: { license: ProLicense }) {
  const r = new Hono<AppEnv>();
  r.get('/license/details', async (c) => c.json(await deps.license.details(c.get('principal') ?? null)));
  r.post('/license/activate', async (c) => {
    const who = changer(c);
    const req = await body(c, ActivateLicenseRequest);
    await deps.license.activate(req.key, { ...(req.transfer && { transfer: true }) });
    return c.json(await deps.license.details(who));
  });
  r.post('/license/deactivate', async (c) => {
    const who = changer(c);
    await deps.license.deactivate();
    return c.json(await deps.license.details(who));
  });
  r.post('/license/refresh', async (c) => {
    const who = changer(c);
    await deps.license.refresh();
    return c.json(await deps.license.details(who));
  });
  return r;
}
