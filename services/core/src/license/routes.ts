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
 * ------------------------------------------------------------------
 */

import { ActivateLicenseRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { ProLicense } from '../pro/types';

export function licenseRoutes(deps: { license: ProLicense }) {
  const r = new Hono<AppEnv>();
  r.get('/license/details', async (c) => c.json(await deps.license.details()));
  r.post('/license/activate', async (c) => {
    const req = await body(c, ActivateLicenseRequest);
    return c.json(await deps.license.activate(req.key, { ...(req.transfer && { transfer: true }) }));
  });
  r.post('/license/deactivate', async (c) => c.json(await deps.license.deactivate()));
  r.post('/license/refresh', async (c) => c.json(await deps.license.refresh()));
  return r;
}
