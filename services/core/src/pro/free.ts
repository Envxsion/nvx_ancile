/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: the free build
 *  Ref      |  DESIGN.md §9
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What runs when pro/ is empty: the licence screen says
 *           |  this is the free edition and how to get Pro, and
 *           |  turning Pro on explains why it cannot happen here.
 *  How      |  Inert. No network, no token is ever read. The device
 *           |  id is still made, so moving to a Pro build later keeps
 *           |  the same one.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { AncileError, type license, pro } from '@nvx/contracts';
import { FREE } from '../license/verify';
import type { SettingsStore } from '../settings';
import type { ProLicense } from './types';

export const DEVICE_KEY = 'license.device_id';

export function featureList(status: license.LicenseStatus): license.LicenseDetails['features'] {
  return pro.PRO_FEATURES.map((id) => ({
    id,
    ...pro.PRO_FEATURE_WORDS[id],
    unlocked: status.tier !== 'free' && status.features.includes(id),
  }));
}

export function freeModule(settings: SettingsStore): { build: 'free'; license: ProLicense } {
  let deviceId = '';
  const details = async (): Promise<license.LicenseDetails> => ({
    status: FREE,
    build: 'free',
    device_id: deviceId,
    key_held: false,
    checked_at: null,
    problem: null,
    features: featureList(FREE),
  });
  return {
    build: 'free',
    license: {
      async start() {
        deviceId = (await settings.get<string>(DEVICE_KEY)) ?? '';
        if (!deviceId) {
          deviceId = randomUUID();
          await settings.set(DEVICE_KEY, deviceId);
        }
      },
      stop() {},
      status: () => FREE,
      details,
      async activate() {
        throw new AncileError({
          code: 'license.free_build',
          title: 'This build has no Pro in it',
          hint: 'Download NVX Ancile from ancile.nvx.sh to use Pro. Everything here keeps working on the free edition.',
          status: 422,
          errorClass: 'permanent',
        });
      },
      refresh: details,
      deactivate: details,
    },
  };
}
