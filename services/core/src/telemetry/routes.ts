/**
 * ------------------------------------------------------------------
 *  Title    |  Telemetry routes
 *  Ref      |  docs/telemetry.md · Settings → Privacy
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Say yes or no, see exactly what would be sent next,
 *           |  and let the Cockpit hand over its counters.
 *  How      |  GET /telemetry, PUT /telemetry/consent {share},
 *           |  GET /telemetry/preview, POST /telemetry/ui. Counters
 *           |  from the Cockpit are dropped unless you said yes.
 * ------------------------------------------------------------------
 */

import { telemetry } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { Telemetry } from './service';

export function telemetryRoutes(deps: { telemetry: Telemetry }) {
  const r = new Hono<AppEnv>();
  r.get('/telemetry', async (c) => c.json(await deps.telemetry.status()));
  r.put('/telemetry/consent', async (c) => {
    const req = await body(c, telemetry.TelemetryConsentRequest);
    return c.json(await deps.telemetry.setConsent(req.share));
  });
  r.get('/telemetry/preview', async (c) => c.json(await deps.telemetry.preview()));
  r.post('/telemetry/ui', async (c) => {
    const req = await body(c, telemetry.TelemetryUiRequest);
    await deps.telemetry.ui(req);
    return c.body(null, 204);
  });
  return r;
}
