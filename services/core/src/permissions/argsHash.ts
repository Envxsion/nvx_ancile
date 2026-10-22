/**
 * ------------------------------------------------------------------
 *  Title    |  The hash an approval is bound to
 *  Ref      |  docs/permissions.md (An approval belongs to the call you saw)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  An approval says yes to one call with one set of
 *           |  arguments. The hash is how a run that resumes tells that
 *           |  the call it is about to run is that call.
 *  How      |  SHA-256 over the canonical JSON of the arguments (object
 *           |  keys sorted at every depth, the same function the MCP
 *           |  fingerprints use), after the same clean-up the database
 *           |  gives them, so what was stored and what is read back
 *           |  hash alike.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { pgSafe } from '../db/json';
import { canonicalJson } from '../mcp/fingerprint';

export function hashArgs(args: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(pgSafe(args ?? null)))
    .digest('hex');
}

/** Is this the call a person approved? An approval with no hash (made before hashes) vouches for nothing. */
export function approvedFor(approval: { approved_args_hash: string | null }, args: unknown): boolean {
  return approval.approved_args_hash !== null && approval.approved_args_hash === hashArgs(args);
}
