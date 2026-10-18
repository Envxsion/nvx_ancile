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
  // PV1: first-class key-billed providers (services/core/src/gateway/profiles.ts).
  'deepseek',
  'moonshot',
  'minimax',
  'zai',
  'qwen',
  'xai',
  'mistral',
  'runpod',
  'huggingface',
  'github',
  'memory_remote',
  /** TypeSafe's Jev, Auto mode's reviewer when called directly (docs/auto-mode.md). */
  'typesafe',
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
  /** Anthropic only: the workspace a personal key bills (not a secret). */
  workspace_id: z.string().nullable().optional(),
  /**
   * Providers with regions only (Moonshot, MiniMax, Qwen, Z.ai): the region id
   * the key is used in (not a secret). Null when none is saved: the provider's
   * default region is used. An environment variable of the same name as the
   * `region_env_var` wins.
   */
  region: z.string().nullable().optional(),
  /** The environment variable that overrides the region (e.g. MOONSHOT_REGION), for providers with regions. */
  region_env_var: z.string().nullable().optional(),
});
export type CredentialStatus = z.infer<typeof CredentialStatus>;

export const CredentialList = z.object({ items: z.array(CredentialStatus) });
export type CredentialList = z.infer<typeof CredentialList>;

/**
 * An Anthropic workspace ID (`wrkspc_…` in the Claude Console). A personal
 * key (`sk-ant-usr-…`) is not tied to a workspace, so Anthropic asks every
 * call to name the one to bill in the `anthropic-workspace-id` header.
 */
export const AnthropicWorkspaceId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{4,128}$/, 'Paste the workspace ID only, such as wrkspc_01AbC…');

/** A personal Anthropic key, which needs a workspace ID beside it. */
export const isPersonalAnthropicKey = (value: string | undefined | null): boolean =>
  !!value && /^sk-ant-usr-/.test(value.trim());

/** A region id as the profile table names it: `global`, `china`, `singapore`... */
export const ProviderRegionId = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,23}$/, 'Pick one of the regions listed for this provider');

/** One region a provider's keys can belong to. */
export const ProviderRegion = z.object({ id: z.string(), label: z.string() });
export type ProviderRegion = z.infer<typeof ProviderRegion>;

/**
 * GET /providers: what the Cockpit needs to list model providers without
 * hard-coding them (PV3). Static facts only; no key or stored value.
 */
export const ProviderInfo = z.object({
  id: z.string(),
  name: z.string(),
  /** The regions a key can belong to; null when the provider has one endpoint. */
  regions: z.array(ProviderRegion).nullable(),
  default_region: z.string().nullable(),
  /** What a key looks like, in words ("starts with sk-"); never a real key. */
  key_hint: z.string(),
  /** The provider's own page for making an API key. */
  docs_url: z.string().nullable(),
  /** The provider answers a list of models (the daily model check can run). */
  has_models_list: z.boolean(),
  /** Id to use with /credentials/:id to save a key; null when keys for this provider are added with a model's secret in Admin → Models. */
  credential_id: CredentialId.nullable(),
  /** False for local servers and the generic OpenAI-compatible profile: no key is needed to start. */
  needs_key: z.boolean(),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;
export const ProviderInfoList = z.object({ items: z.array(ProviderInfo) });
export type ProviderInfoList = z.infer<typeof ProviderInfoList>;

/** PUT /credentials/:id. The value is checked, then stored encrypted. */
export const SaveCredentialRequest = z
  .object({
    value: z.string().trim().min(4).max(4000),
    /** Anthropic personal keys only; ignored for every other key. */
    workspace_id: AnthropicWorkspaceId.optional(),
    /** Providers with regions: where the key was made. Checked against the provider's regions; ignored for the rest. */
    region: ProviderRegionId.optional(),
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
