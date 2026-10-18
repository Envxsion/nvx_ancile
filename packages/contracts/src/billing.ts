/**
 * ------------------------------------------------------------------
 *  Title    |  Who pays for a model
 *  Ref      |  docs/claude-code.md (Plan or key) · roadmap MD3
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  How answers from a model are paid for. Kept apart from
 *           |  api.ts so a message's usage can record it as it was when
 *           |  the answer was written (roadmap WY1).
 * ------------------------------------------------------------------
 */
import { z } from 'zod';

/** How answers from a model are paid for (MD3). */
export const ModelBilling = z
  .object({
    /** plan: a subscription you are signed in to (counted against its limits); key: pay per use on an API key or cloud account; local: your own computer or network; rented: a GPU node you pay for by the hour; none: offline test models. */
    kind: z.enum(['plan', 'key', 'local', 'rented', 'none']),
    /** Who bills. plan: the plan name as Claude Code reports it ('max', 'pro', 'team', 'enterprise'…), null if unknown. key: the provider id ('anthropic', 'openai', 'openrouter'…) or the cloud ('bedrock', 'vertex', 'foundry') when Claude Code bills one. Otherwise null. */
    payer: z.string().max(60).nullable(),
  })
  .strict();
export type ModelBilling = z.infer<typeof ModelBilling>;
