/**
 * ------------------------------------------------------------------
 *  Title    |  Probes
 *  Ref      |  DESIGN.md §7.4, §14 (self-diagnostic)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the supervisor checks, and what to tell a person
 *           |  when a check keeps failing.
 * ------------------------------------------------------------------
 */

import { statfs } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { currentContext, tracedFetch } from '../context';
import type { Probe } from './supervisor';

async function httpReady(url: string, signal: AbortSignal, auth?: string): Promise<void> {
  // Periodic ticks run outside any request: mark them so the other services
  // log them at debug. A "Check now" runs inside the user's trace and is logged.
  const headers: Record<string, string> = {};
  if (!currentContext()) headers['x-ancile-probe'] = 'background';
  if (auth) headers.authorization = auth;
  let res: Response;
  try {
    res = await tracedFetch(url, { signal, headers });
  } catch (err) {
    throw new Error(explainFetchFailure(url, err));
  }
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} to its readiness check`);
}

/**
 * Undici reports every network failure as "fetch failed" and hides the
 * reason in `cause`. The health panel shows this text to a person, so say
 * what actually happened.
 */
export function explainFetchFailure(url: string, err: unknown): string {
  const host = new URL(url).host;
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code ?? (err as { name?: string } | undefined)?.name;
  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is answering at ${host} (connection refused). The service is not running.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `The host in ${host} could not be found. Check the service URL in settings.`;
    case 'ECONNRESET':
      return `${host} dropped the connection. The service may be restarting.`;
    case 'TimeoutError':
    case 'AbortError':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `${host} did not answer in time. The service may be overloaded or stuck.`;
    default:
      return `${host} could not be reached${code ? ` (${code})` : ''}.`;
  }
}

export function coreProbes(opts: {
  sql: Sql;
  knowledgeUrl: string;
  controllerUrl?: string | undefined;
  agent?: { url: string; token: string } | undefined;
  dataDir: string;
}): Probe[] {
  const probes: Probe[] = [
    {
      service: 'postgres',
      remediation:
        'Restart Ancile (`pnpm start` in development), which starts the embedded database. If you set DATABASE_URL yourself, check that server is running.',
      check: async () => {
        await opts.sql`select 1`;
      },
    },
    {
      service: 'knowledge',
      remediation:
        'Restart the Knowledge service. If it keeps failing, open Logs and filter by service "knowledge".',
      check: (signal) => httpReady(`${opts.knowledgeUrl}/ready`, signal),
    },
    {
      service: 'disk',
      remediation:
        'Free space on the drive that holds ANCILE_DATA_DIR, or run Settings → Storage → Clean up.',
      check: async () => {
        const s = await statfs(opts.dataDir);
        const freeGb = (s.bavail * s.bsize) / 1e9;
        if (freeGb < 2) throw new Error(`only ${freeGb.toFixed(1)} GB free in ${opts.dataDir}`);
      },
    },
  ];
  if (opts.agent) {
    // The engine guards even its health route; opencode's server uses Basic
    // auth until the Phase 2 auth patch swaps in Core-signed tokens.
    const auth = `Basic ${Buffer.from(`opencode:${opts.agent.token}`).toString('base64')}`;
    const url = `${opts.agent.url}/global/health`;
    probes.push({
      service: 'agent',
      remediation:
        'Restart Ancile so the lab starts again (it needs Bun: https://bun.sh). Chat and notebooks keep working without it.',
      check: (signal) => httpReady(url, signal, auth),
    });
  }
  if (opts.controllerUrl) {
    probes.push({
      service: 'controller',
      remediation: 'Restart the Controller. Chat keeps working on cloud models while it is down.',
      check: (signal) => httpReady(`${opts.controllerUrl}/ready`, signal),
    });
  }
  return probes;
}
