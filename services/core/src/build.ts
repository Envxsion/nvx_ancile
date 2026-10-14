/**
 * ------------------------------------------------------------------
 *  Title    |  Build flags
 *  Ref      |  DESIGN.md §9 (licensing)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What kind of build this is, fixed when it was built so
 *           |  nothing at run time (environment, settings) can change
 *           |  it.
 *  How      |  Release bundlers (tsup, the desktop's esbuild) replace
 *           |  __ANCILE_RELEASE__ with `true`, and __ANCILE_VERSION__
 *           |  with package.json's version. Running from source (tsx,
 *           |  vitest) leaves them undefined: a development build,
 *           |  whose version is read from package.json itself, so no
 *           |  version is ever written into the code by hand.
 *  Note     |  A release build trusts only the licence keys built in
 *           |  and ignores NVX_LICENSE_KEYS and NVX_TIER, so a key of
 *           |  your own cannot unlock Pro without changing the code.
 * ------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';

declare const __ANCILE_RELEASE__: boolean | undefined;
declare const __ANCILE_VERSION__: string | undefined;

export const RELEASE_BUILD: boolean =
  typeof __ANCILE_RELEASE__ !== 'undefined' && __ANCILE_RELEASE__ === true;

/** Core's own package.json version, read when running from source. */
function sourceVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

/** The version this Core was built as (package.json's, fixed by the bundler). */
export const BUILD_VERSION: string =
  typeof __ANCILE_VERSION__ !== 'undefined' && __ANCILE_VERSION__ ? __ANCILE_VERSION__ : sourceVersion();

/**
 * Which NVX Ancile this is: the desktop app says (ANCILE_APP_VERSION, its
 * own build's version), else the version Core was built as.
 */
export function appVersion(fromEnv = process.env.ANCILE_APP_VERSION): string {
  return fromEnv?.trim() || BUILD_VERSION;
}

/** The licence keys to trust: in a release build only the ones built in. */
export function trustedKeys<K>(official: K, fromEnv: K | null, release = RELEASE_BUILD): K {
  return !release && fromEnv ? fromEnv : official;
}

/** The edition asked for: a release build ignores NVX_TIER (it is what was bundled). */
export function chosenTier<T>(fromEnv: T | undefined, release = RELEASE_BUILD): T | undefined {
  return release ? undefined : fromEnv;
}

/** Where a release build sends usage statistics (only when the person opts in). */
export const OFFICIAL_TELEMETRY_URL = 'https://ancile.nvx.sh/api/telemetry';

/**
 * The statistics endpoint: NVX_TELEMETRY_URL when set; otherwise the
 * official one in a release build, and none in a development build, so
 * nothing you run from source ever reports anywhere.
 */
export function telemetryEndpoint(fromEnv: string | undefined, release = RELEASE_BUILD): string | undefined {
  return fromEnv ?? (release ? OFFICIAL_TELEMETRY_URL : undefined);
}
