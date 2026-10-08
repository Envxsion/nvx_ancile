/**
 * The permission vocabulary (DESIGN.md §5). Shared so the Cockpit can render
 * grants and decisions with the same types Core enforces them with.
 */
import { z } from 'zod';
import { Tier } from './events';

export { Tier };

export const Principal = z.union([
  z.literal('user'),
  z.string().regex(/^agent:[a-z0-9_-]+$/),
  z.string().regex(/^external:[a-z0-9_.-]+$/),
]);

export const GrantScope = z.enum(['thread', 'notebook', 'workspace', 'always']);
export type GrantScope = z.infer<typeof GrantScope>;

/** "once" is a decision scope, not a grant: nothing is remembered. */
export const DecisionScope = z.enum(['once', 'thread', 'notebook', 'workspace', 'always']);

export const Grant = z.object({
  id: z.string(),
  principal: Principal,
  action_pattern: z.string(),
  resource_pattern: z.string(),
  effect: z.enum(['allow', 'deny']),
  scope: GrantScope,
  scope_ref: z.string().nullable(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  uses: z.number().int(),
  last_used_at: z.string().nullable(),
  created_from_approval_id: z.string().nullable(),
  created_at: z.string(),
});
export type Grant = z.infer<typeof Grant>;

export const ApprovalDecisionRequest = z
  .object({
    decision: z.enum(['approve', 'deny']),
    scope: DecisionScope.default('once'),
    /** Edited or chosen pattern; must be at least as narrow as allowed by policy. */
    pattern: z.string().optional(),
    ttl_seconds: z.number().int().positive().optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export const DecisionOutcome = z.enum(['auto', 'grant', 'approved', 'denied', 'policy_deny', 'expired']);

export const Decision = z.object({
  id: z.string(),
  at: z.string(),
  principal: Principal,
  action: z.string(),
  resource: z.string(),
  tier: Tier,
  outcome: DecisionOutcome,
  grant_id: z.string().nullable(),
  approval_id: z.string().nullable(),
  policy_id: z.string().nullable(),
  run_id: z.string().nullable(),
  trace_id: z.string(),
});
export type Decision = z.infer<typeof Decision>;

export const PermissionPreset = z.enum(['careful', 'balanced', 'hands_off']);
