/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check types
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The contract shapes the fact-check module uses, in one
 *           |  place, so the pure pipeline does not reach into zod.
 * ------------------------------------------------------------------
 */

import type { ClaimEvidence, Factcheck, FactcheckClaim } from '@nvx/contracts';

export type { ClaimEvidence, Factcheck, FactcheckClaim };
export type FactsheetCounts = Factcheck['counts'];
