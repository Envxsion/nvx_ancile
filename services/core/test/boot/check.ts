/**
 * ------------------------------------------------------------------
 *  Title    |  Boot check convention
 *  Ref      |  DESIGN.md §14, services/core/README.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Every boot test carries its own fix, so a failure at
 *           |  startup says what to do, not only what broke.
 *  How      |  The test's full name is "<what> | fix: <remediation>".
 *           |  scripts/boot.mjs runs `vitest --project boot --reporter
 *           |  json`, splits failed names on " | fix: " and prints both
 *           |  halves. Nothing else needs to be exported.
 * ------------------------------------------------------------------
 */

import { it } from 'vitest';

export const FIX_SEPARATOR = ' | fix: ';

export function bootCheck(what: string, fix: string, fn: () => unknown | Promise<unknown>, timeout?: number) {
  it(`${what}${FIX_SEPARATOR}${fix}`, fn, timeout);
}

/** In CI with no database, DB checks are skipped; at real boot they must run. */
export const atRealBoot = process.env.ANCILE_BOOT_CONTEXT === 'boot';
