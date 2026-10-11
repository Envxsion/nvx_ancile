/**
 * ------------------------------------------------------------------
 *  Title    |  Credentials (Settings → API keys)
 *  Ref      |  DESIGN.md §5.8 · docs/configuration.md (API keys)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Every key and token NVX Ancile uses, in one list: model
 *           |  providers, RunPod, Hugging Face, GitHub and the memory
 *           |  backup remote. Add, replace and remove each one.
 *  How      |  A value goes in once (PUT) and never comes back out:
 *           |  the browser only ever sees `set` and the last four
 *           |  characters. A value set in the environment wins, and
 *           |  that row is read-only.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const CredentialId = z.enum([
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'runpod',
  'huggingface',
  'github',
  'memory_remote',
]);
export type CredentialId = z.infer<typeof CredentialId>;

/**
 * How a new value is checked before it is saved: one tiny model call
 * (`provider`), the Controller asking RunPod (`controller`), the service's
 * own "who am I" endpoint (`service`), or only its shape (`format`).
 */
export const CredentialCheck = z.enum(['provider', 'controller', 'service', 'format']);
export type CredentialCheck = z.infer<typeof CredentialCheck>;

export const CredentialStatus = z.object({
  id: CredentialId,
  /** A value exists, saved here or in the environment. */
  set: z.boolean(),
  /** The last four characters of the value in use; never more. */
  last4: z.string().max(4).nullable(),
  /** Where the value in use comes from; `environment` rows are read-only. */
  source: z.enum(['saved', 'environment']).nullable(),
  /** The environment variable that overrides this row. */
  env_var: z.string(),
  check: CredentialCheck,
  /** False when this install cannot use it yet (no Controller for RunPod). */
  available: z.boolean(),
  /** Why it is unavailable, in a sentence. */
  unavailable_reason: z.string().nullable(),
});
export type CredentialStatus = z.infer<typeof CredentialStatus>;

export const CredentialList = z.object({ items: z.array(CredentialStatus) });
export type CredentialList = z.infer<typeof CredentialList>;

/** PUT /credentials/:id. The value is checked, then stored encrypted. */
export const SaveCredentialRequest = z
  .object({
    value: z.string().trim().min(4).max(4000),
  })
  .strict();
export type SaveCredentialRequest = z.infer<typeof SaveCredentialRequest>;

/** The last four characters of a value, for "Saved, ends in 4f2a". */
export function last4(value: string | undefined | null): string | null {
  const v = value?.trim();
  if (!v) return null;
  // Short values would show most of themselves; show nothing instead.
  return v.length >= 12 ? v.slice(-4) : null;
}
