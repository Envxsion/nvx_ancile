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
import { FREE, verifyToken } from '../license/verify';
import { logFor } from '../obs/logger';
import { featureList, freeModule } from './free';
import type { CreatePro, ProHost, ProModule } from './types';

const log = logFor('pro');

/** pro/core/index.ts at the repository root. */
export const PRO_ENTRY = fileURLToPath(new URL('../../../../pro/core/index.ts', import.meta.url));

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
}): Promise<ProModule | ReturnType<typeof freeModule>> {
  const entry = opts.entry ?? PRO_ENTRY;
  const free = () => freeModule(opts.host.settings);
  if (opts.tier === 'free' || !proPresent(entry)) {
    if (opts.tier === 'pro') log.warn({ entry }, 'NVX_TIER=pro but pro/ is empty: running the free build');
    return free();
  }
  const host: ProHost = {
    fetch,
    AncileError,
    deviceLabel: deviceLabel(),
    log: logFor('pro'),
    freeStatus: FREE,
    featureList,
    verify: (token, deviceId) => verifyToken(token, { keys: opts.host.keys, build: 'pro', deviceId }),
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
