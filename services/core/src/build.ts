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
 *           |  __ANCILE_RELEASE__ with `true`. Running from source
 *           |  (tsx, vitest) leaves it undefined: a development build.
 *  Note     |  A release build trusts only the licence keys built in
 *           |  and ignores NVX_LICENSE_KEYS and NVX_TIER, so a key of
 *           |  your own cannot unlock Pro without changing the code.
 * ------------------------------------------------------------------
 */

declare const __ANCILE_RELEASE__: boolean | undefined;

export const RELEASE_BUILD: boolean =
  typeof __ANCILE_RELEASE__ !== 'undefined' && __ANCILE_RELEASE__ === true;

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
