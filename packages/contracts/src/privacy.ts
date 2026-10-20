/**
 * ------------------------------------------------------------------
 *  Title    |  Private-notebook permissions
 *  Ref      |  DESIGN.md D29 · docs/privacy.md · docs/scopes.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Everything that could take work off this machine, in one
 *           |  list, and whether a private notebook may use it. One
 *           |  schema for Settings → Private notebooks, its two routes
 *           |  and the single helper every feature asks (core/privacy).
 *  How      |  PrivacyPolicy holds the capabilities a person may switch
 *           |  on for private notebooks; each is { allowed_in_private }
 *           |  and off by default. LOCKED_CAPABILITIES are the floors
 *           |  scopes already enforce (cloud models, Claude Code, the
 *           |  web, off-machine Auto reviewers): shown, never switchable.
 *  Note     |  Nothing here changes a notebook that is not private. A
 *           |  model or node on this machine, or the person's own GPU
 *           |  node, counts as private (ModelConfig.runs_on).
 * ------------------------------------------------------------------
 */
import { z } from 'zod';

/** What a person can switch on for private notebooks. */
export const SWITCHABLE_CAPABILITIES = [
  'decisions_off_machine',
  'passive_memory',
  'verdict_cache_global',
] as const;

/** Floors that scopes enforce today: listed here so everything is in one place, but never switchable. */
export const LOCKED_CAPABILITIES = [
  'cloud_models',
  'claude_code',
  'web',
  'auto_reviewer_off_machine',
] as const;

export const PrivacyCapability = z.enum([...SWITCHABLE_CAPABILITIES, ...LOCKED_CAPABILITIES]);
export type PrivacyCapability = z.infer<typeof PrivacyCapability>;
export type SwitchableCapability = (typeof SWITCHABLE_CAPABILITIES)[number];
export type LockedCapability = (typeof LOCKED_CAPABILITIES)[number];

const Entry = z
  .object({ allowed_in_private: z.boolean().default(false) })
  .default({ allowed_in_private: false });

/** Off in a private notebook unless the person turns it on. Each key parses to a complete object. */
export const PrivacyPolicy = z.object({
  /** Hosted decision models (Jev, Clef, Clef-flash in the cloud) choosing routes and checks. */
  decisions_off_machine: Entry,
  /** Learning from things said in passing. */
  passive_memory: Entry,
  /** Sharing fact-check verdicts across notebooks. */
  verdict_cache_global: Entry,
});
export type PrivacyPolicy = z.infer<typeof PrivacyPolicy>;

export const DEFAULT_PRIVACY_POLICY: PrivacyPolicy = PrivacyPolicy.parse({});

/** PUT /privacy/policy: the capabilities to change; others stay as they are. */
export const PutPrivacyPolicyRequest = z.object({
  policy: z
    .object({
      decisions_off_machine: z.object({ allowed_in_private: z.boolean() }).optional(),
      passive_memory: z.object({ allowed_in_private: z.boolean() }).optional(),
      verdict_cache_global: z.object({ allowed_in_private: z.boolean() }).optional(),
    })
    .passthrough(),
});
export type PutPrivacyPolicyRequest = z.infer<typeof PutPrivacyPolicyRequest>;

/** One row of Settings → Private notebooks. */
export const PrivacyRow = z.object({
  id: PrivacyCapability,
  label: z.string(),
  /** One line. */
  description: z.string(),
  /** Behind the help mark. */
  detail: z.string(),
  allowed_in_private: z.boolean(),
  /** A floor: shown, not switchable. */
  locked: z.boolean(),
  /** A model on this machine or the person's own node could serve this, so it runs there even when off. */
  local_available: z.boolean(),
});
export type PrivacyRow = z.infer<typeof PrivacyRow>;

export const PrivacySettings = z.object({
  policy: PrivacyPolicy,
  rows: z.array(PrivacyRow),
});
export type PrivacySettings = z.infer<typeof PrivacySettings>;
