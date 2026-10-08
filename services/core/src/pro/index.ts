/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: the loader
 *  Ref      |  DESIGN.md §9
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Load Pro when this checkout has it, and run the free
 *           |  product, complete and unchanged, when it does not.
 *  How      |  Pro is a private repository mounted at pro/ (a git
 *           |  submodule, empty in a public clone). NVX_TIER=free
 *           |  never looks; NVX_TIER=pro, or no tier with pro/ there,
 *           |  imports pro/core/index.ts and calls createPro(host).
 *           |  If that fails, Core starts free and says why: Pro
 *           |  failing must never take the product down with it.
 * ------------------------------------------------------------------
 */

import { existsSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AncileError } from '@nvx/contracts';
import { RELEASE_BUILD } from '../build';
import type { LicenceClock } from '../license/clock';
import { FREE, verifyToken } from '../license/verify';
import { logFor } from '../obs/logger';
import { featureList, freeModule } from './free';
import type { CreatePro, ProHost, ProModule } from './types';

const log = logFor('pro');

/**
 * From source: pro/core/index.ts at the repository root. In a release
 * bundle: pro.js next to Core's main.js, present only in the Pro edition.
 */
export const PRO_ENTRY = fileURLToPath(
  RELEASE_BUILD
    ? new URL('./pro.js', import.meta.url)
    : new URL('../../../../pro/core/index.ts', import.meta.url),
);

export function proPresent(entry = PRO_ENTRY): boolean {
  return existsSync(entry);
}

function deviceLabel(): string {
  try {
    return `${userInfo().username}@${hostname()}`.slice(0, 64);
  } catch {
    return hostname().slice(0, 64);
  }
}

export async function loadPro(opts: {
  tier: 'free' | 'pro' | undefined;
  host: Omit<
    ProHost,
    'verify' | 'AncileError' | 'deviceLabel' | 'fetch' | 'log' | 'freeStatus' | 'featureList'
  > &
    Partial<ProHost>;
  entry?: string;
  /** The time expiry is checked against (never earlier than anything seen). */
  clock?: LicenceClock;
}): Promise<ProModule | ReturnType<typeof freeModule>> {
  const entry = opts.entry ?? PRO_ENTRY;
  const free = () => freeModule(opts.host.settings);
  if (opts.tier === 'free' || !proPresent(entry)) {
    if (opts.tier === 'pro') log.warn({ entry }, 'NVX_TIER=pro but pro/ is empty: running the free build');
    return free();
  }
  const clock = opts.clock;
  const licenceOrigin = (() => {
    try {
      return new URL(opts.host.licenseUrl).origin;
    } catch {
      return null;
    }
  })();
  // Replies from nvx.sh carry the true time: it feeds the licence clock.
  const timedFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (clock && licenceOrigin && url.startsWith(licenceOrigin)) clock.observeHeader(res.headers.get('date'));
    return res;
  };
  const host: ProHost = {
    fetch: timedFetch,
    AncileError,
    deviceLabel: deviceLabel(),
    log: logFor('pro'),
    freeStatus: FREE,
    featureList,
    verify: (token, deviceId) => {
      const r = verifyToken(token, {
        keys: opts.host.keys,
        build: 'pro',
        deviceId,
        ...(clock && { now: clock.now() }),
      });
      // A genuine token's issue time is a moment that has certainly passed.
      if (clock && r.claims && r.failure !== 'bad_token' && r.failure !== 'unknown_kid')
        clock.observe(r.claims.iat * 1000);
      return r;
    },
    ...opts.host,
  };
  try {
    const mod = (await import(pathToFileURL(entry).href)) as { createPro?: CreatePro };
    if (typeof mod.createPro !== 'function') throw new Error('pro/core/index.ts has no createPro export');
    const pro = await mod.createPro(host);
    log.info({}, 'Pro is loaded');
    return pro;
  } catch (err) {
    log.warn({ err }, 'Pro could not be loaded: running the free build');
    return free();
  }
}
