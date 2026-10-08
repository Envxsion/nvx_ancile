/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: the contract
 *  Ref      |  DESIGN.md §9, packages/contracts/src/pro.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What Core hands Pro (ProHost) and what Pro gives back
 *           |  (ProModule). Public, so the free build and the private
 *           |  pro/ repository agree on one shape.
 *  How      |  Pro is given everything it needs: it imports no npm
 *           |  package and no Core internals at run time, so a change
 *           |  inside Core cannot break it silently.
 * ------------------------------------------------------------------
 */

import type { AncileError, license } from '@nvx/contracts';
import type { KeyMap, Verified } from '../license/verify';
import type { SecretStore } from '../secrets';
import type { SettingsStore } from '../settings';

export interface ProLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** What Core lends Pro. */
export interface ProHost {
  settings: SettingsStore;
  /** Encrypted at rest (the claim key lives here, never in settings). */
  secrets: SecretStore;
  log: ProLog;
  fetch: typeof fetch;
  AncileError: typeof AncileError;
  /** Offline token check (public: services/core/src/license/verify.ts). */
  verify: (token: string, deviceId: string) => Verified;
  keys: KeyMap;
  /** The free edition's status, and how each Pro feature is described. */
  freeStatus: license.LicenseStatus;
  featureList: (status: license.LicenseStatus) => license.LicenseDetails['features'];
  licenseUrl: string;
  /** A name for this computer the licence server can show ("Ana's laptop"). */
  deviceLabel: string;
  version: string;
}

/** Turning Pro on and keeping it on: Admin → Licence talks to this. */
export interface ProLicense {
  start(): Promise<void>;
  stop(): void;
  status(): license.LicenseStatus;
  details(): Promise<license.LicenseDetails>;
  activate(key: string, opts?: { transfer?: boolean }): Promise<license.LicenseDetails>;
  refresh(): Promise<license.LicenseDetails>;
  deactivate(): Promise<license.LicenseDetails>;
}

/** The private module's default export: `createPro(host)`. */
export interface ProModule {
  build: 'pro';
  license: ProLicense;
}

export type CreatePro = (host: ProHost) => ProModule | Promise<ProModule>;
