/**
 * ------------------------------------------------------------------
 *  Title    |  Prompt epochs
 *  Ref      |  ROADMAP.md CA2, CA3, CA4 · docs/prompt-caching.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Every provider caches a request by its exact start. An
 *           |  epoch is the stretch of a thread (one branch of it)
 *           |  where that start does not change: the system prompt,
 *           |  the tools, the memory snapshot. A new epoch starts only
 *           |  for a reason on a closed list, so a cache miss can be
 *           |  explained (CA7 reads the reason).
 *  How      |  provenance.epoch on an answer says which epoch it was
 *           |  written in and why that epoch began. The list of reasons
 *           |  below is the whole list: add one here before using it.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** Why an epoch began. Closed: nothing else may start one. */
export const EPOCH_REASONS = [
  'new_thread',
  'compaction',
  'model_family',
  'tools_changed',
  'memory_refresh',
  'thinking_toggled',
] as const;
export const EpochReason = z.enum(EPOCH_REASONS);
export type EpochReason = z.infer<typeof EpochReason>;

/** provenance.epoch on an answer. */
export const EpochProvenance = z.object({
  id: z.string(),
  reason: EpochReason,
  /** True when this answer began the epoch. */
  started: z.boolean(),
  model_family: z.string(),
  /** sha256 (hex) of the tools block the epoch declares. */
  tools_hash: z.string(),
  /** Short commit of the memory the epoch's snapshot was taken at, when it had any. */
  memory_commit: z.string().nullable(),
  /** Whether the varying context went at the end of the request (false: the family's switch is off). */
  end_context: z.boolean(),
});
export type EpochProvenance = z.infer<typeof EpochProvenance>;
