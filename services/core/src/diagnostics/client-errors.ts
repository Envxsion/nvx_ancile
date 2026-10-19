/**
 * ------------------------------------------------------------------
 *  Title    |  Client error log
 *  Ref      |  ROADMAP ER1 · GR19
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit's error boundaries tell Core that a panel
 *           |  failed, so the log shows it next to the trace.
 *  How      |  POST /system/client-errors takes the scope, the error
 *           |  class name, the app version and whether a chunk failed
 *           |  to load. Never message text or user content. Small body,
 *           |  20 a minute, written to the JSON log (redacted). It stays
 *           |  on this computer: nothing is sent anywhere (GR19).
 * ------------------------------------------------------------------
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { badRequest } from '../obs/errors';
import { logFor } from '../obs/logger';

const log = logFor('client-errors');
const MAX_BYTES = 1024;
const PER_MINUTE = 20;

const Report = z
  .object({
    scope: z.enum(['shell', 'route', 'panel', 'message', 'artifact', 'node', 'lazy']),
    kind: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
    version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
    chunk: z.boolean().default(false),
  })
  .strict();

export function clientErrorRoutes(now: () => number = Date.now) {
  const r = new Hono<AppEnv>();
  let stamps: number[] = [];

  r.post('/system/client-errors', async (c) => {
    if (Number(c.req.header('content-length') ?? 0) > MAX_BYTES) throw badRequest('The report is too large');
    const t = now();
    stamps = stamps.filter((s) => t - s < 60_000);
    if (stamps.length >= PER_MINUTE) return c.body(null, 429);
    stamps.push(t);
    const rep = await body(c, Report);
    log.warn({ trace_id: c.get('traceId'), ...rep }, 'a Cockpit panel failed');
    return c.body(null, 204);
  });
  return r;
}
