/**
 * ------------------------------------------------------------------
 *  Title    |  Private-notebook policy helper
 *  Ref      |  docs/privacy.md · DESIGN.md D29 · packages/contracts/src/privacy.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The one place that answers "may this notebook use this
 *           |  off-machine capability?". Every feature asks here; none
 *           |  reads the private flag and decides for itself.
 *  How      |  allowsUnder is a pure function of the saved policy, the
 *           |  capability and the call. PrivacyPolicies caches the
 *           |  saved policy (core.settings, key privacy.policy), looks
 *           |  a notebook's private flag up, and asks a hook whether a
 *           |  model on this machine or the person's own node could
 *           |  serve the capability. Not private: always allowed.
 *           |  Private: allowed when this call itself runs locally,
 *           |  when the person switched it on, or (decisions, passive
 *           |  memory) when a local model can serve it, in which case
 *           |  must_run_local tells the caller to use that model.
 *  Note     |  Locked capabilities are the floors scopes enforce
 *           |  already; only cloud_models and auto_reviewer_off_machine
 *           |  pass, and only when the call runs on a local model.
 *           |  Nothing here widens a scope: engine and tool checks
 *           |  still run after it.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  DEFAULT_PRIVACY_POLICY,
  LOCKED_CAPABILITIES,
  type LockedCapability,
  type PrivacyCapability,
  PrivacyPolicy,
  type PrivacyRow,
  type PrivacySettings,
  SWITCHABLE_CAPABILITIES,
  type SwitchableCapability,
} from '@nvx/contracts';
import type { SettingsStore } from '../settings';

/** core.settings key for the saved policy. */
export const PRIVACY_SETTING = 'privacy.policy';

/** What the caller knows about the work it wants to do. */
export interface PrivacyContext {
  /** The notebook the work belongs to. Looked up when `private` is not given. */
  notebookId?: string | null;
  /** Already known (from an EffectiveScope): skips the lookup. */
  private?: boolean;
  /** This very call runs on a model or node on this machine or the person's own GPU node. */
  local?: boolean;
}

export interface PrivacyAnswer {
  allowed: boolean;
  /** Why: not private, a local call, the person's setting, a local model, or the default refusal. */
  via: 'not_private' | 'local_call' | 'policy' | 'local_model' | 'denied';
  /** Allowed only because a local model can serve it: the caller must use that one. */
  must_run_local: boolean;
}

/** Capabilities a call on a local model satisfies. */
const LOCAL_SERVABLE: readonly PrivacyCapability[] = [
  'decisions_off_machine',
  'passive_memory',
  'cloud_models',
  'auto_reviewer_off_machine',
];
/** Capabilities a local model unlocks even when the setting is off. */
const LOCAL_FALLBACK: readonly PrivacyCapability[] = ['decisions_off_machine', 'passive_memory'];

const isLocked = (c: PrivacyCapability): c is LockedCapability =>
  (LOCKED_CAPABILITIES as readonly string[]).includes(c);

/** Pure: the whole rule. `localAvailable` says a local model could serve `capability` here. */
export function allowsUnder(
  policy: PrivacyPolicy,
  capability: PrivacyCapability,
  call: { private: boolean; local?: boolean; localAvailable?: boolean },
): PrivacyAnswer {
  if (!call.private) return { allowed: true, via: 'not_private', must_run_local: false };
  if (call.local && LOCAL_SERVABLE.includes(capability))
    return { allowed: true, via: 'local_call', must_run_local: false };
  if (isLocked(capability)) return { allowed: false, via: 'denied', must_run_local: false };
  if (policy[capability].allowed_in_private) return { allowed: true, via: 'policy', must_run_local: false };
  if (call.localAvailable && LOCAL_FALLBACK.includes(capability))
    return { allowed: true, via: 'local_model', must_run_local: true };
  return { allowed: false, via: 'denied', must_run_local: false };
}

/**
 * The floors only, for code that holds an EffectiveScope but no service: they are the
 * same whatever the person has switched on.
 */
export function allowsByDefault(
  capability: LockedCapability,
  call: { private: boolean; local?: boolean },
): boolean {
  return allowsUnder(DEFAULT_PRIVACY_POLICY, capability, call).allowed;
}

const WORDS: Record<PrivacyCapability, { label: string; description: string; detail: string }> = {
  decisions_off_machine: {
    label: 'Hosted decision models',
    description: 'Let Jev and hosted Clef choose routes and checks here.',
    detail:
      'Decision models read a short summary of the turn to pick a route or judge a check. Off, private notebooks use a decision model on this computer or your own GPU node if you have one, and the rules otherwise.',
  },
  passive_memory: {
    label: 'Learn from things said in passing',
    description: 'Remember small facts from chat without being asked.',
    detail:
      'Off here, nothing is remembered unless you say so, unless a model on this computer or your own GPU node can do the learning. Everywhere else it stays on.',
  },
  verdict_cache_global: {
    label: 'Share fact-check verdicts',
    description: 'Reuse verdicts from this notebook in your other notebooks.',
    detail:
      'Verdicts are kept per notebook. When shared, a claim checked here can answer the same claim elsewhere, and the other way round. Off, a private notebook keeps its verdicts to itself.',
  },
  cloud_models: {
    label: 'Cloud models',
    description: 'Always off. Private notebooks answer with models on this computer.',
    detail:
      'This is the private floor in docs/scopes.md. To use cloud models, turn off Private for the notebook.',
  },
  claude_code: {
    label: 'Claude Code',
    description: 'Always off. It sends your work to Anthropic.',
    detail: 'Claude Code is never used in a private notebook. Turn off Private for the notebook to use it.',
  },
  web: {
    label: 'Web search and fetch',
    description: 'Always off. Searches leave this computer.',
    detail:
      'Private notebooks never search or fetch from the web. Turn off Private for the notebook to allow it.',
  },
  auto_reviewer_off_machine: {
    label: 'Hosted Auto mode reviewers',
    description: 'Always off. Only local reviewers and the rules decide.',
    detail: 'Auto mode asks a model on this computer, or falls back to its rules (docs/auto-mode.md).',
  },
};

export interface PrivacyDeps {
  settings: SettingsStore;
  /** Is this notebook private? Wire to ScopeStore.isPrivate. */
  isPrivate?: (notebookId: string) => Promise<boolean>;
  /**
   * Could a model on this machine, or on the person's own GPU node, serve `capability`?
   * Hook for the decision-model work: the default says no.
   */
  localAvailable?: (capability: PrivacyCapability) => boolean | Promise<boolean>;
}

export class PrivacyPolicies {
  private cache: PrivacyPolicy | null = null;
  private localHook: NonNullable<PrivacyDeps['localAvailable']>;

  constructor(private readonly deps: PrivacyDeps) {
    this.localHook = deps.localAvailable ?? (() => false);
  }

  /** Replace the "a local model is available" hook (the decision-model code sets it at start). */
  setLocalAvailable(fn: NonNullable<PrivacyDeps['localAvailable']>): void {
    this.localHook = fn;
  }

  async policy(): Promise<PrivacyPolicy> {
    if (!this.cache) {
      const saved = await this.deps.settings.get<unknown>(PRIVACY_SETTING);
      this.cache = PrivacyPolicy.parse(saved ?? {});
    }
    return this.cache;
  }

  /** Change some switchable capabilities; the rest stay as they are. */
  async update(
    patch: Partial<Record<SwitchableCapability, { allowed_in_private: boolean }>>,
  ): Promise<PrivacyPolicy> {
    const next = structuredClone(await this.policy());
    for (const k of Object.keys(patch)) {
      if (!(SWITCHABLE_CAPABILITIES as readonly string[]).includes(k)) throw lockedError(k);
      const v = patch[k as SwitchableCapability];
      if (v) next[k as SwitchableCapability] = { allowed_in_private: v.allowed_in_private };
    }
    await this.deps.settings.set(PRIVACY_SETTING, next);
    this.cache = next;
    return next;
  }

  /** The full answer, with why and whether the caller must use a local model. */
  async resolve(capability: PrivacyCapability, ctx: PrivacyContext = {}): Promise<PrivacyAnswer> {
    const priv =
      ctx.private ??
      (ctx.notebookId && this.deps.isPrivate ? await this.deps.isPrivate(ctx.notebookId) : false);
    const localAvailable =
      priv && LOCAL_FALLBACK.includes(capability) ? await this.localHook(capability) : false;
    return allowsUnder(await this.policy(), capability, { private: priv, local: ctx.local, localAvailable });
  }

  /** May this work happen? The one question every feature asks. */
  async allows(capability: PrivacyCapability, ctx: PrivacyContext = {}): Promise<boolean> {
    return (await this.resolve(capability, ctx)).allowed;
  }

  /** Throw `privacy.denied` unless allowed. */
  async require(capability: PrivacyCapability, ctx: PrivacyContext = {}): Promise<PrivacyAnswer> {
    const a = await this.resolve(capability, ctx);
    if (!a.allowed) throw deniedError(capability);
    return a;
  }

  /** Settings → Private notebooks: the policy with a row for every capability. */
  async settings(): Promise<PrivacySettings> {
    const policy = await this.policy();
    const rows: PrivacyRow[] = [];
    for (const id of [...SWITCHABLE_CAPABILITIES, ...LOCKED_CAPABILITIES]) {
      const locked = isLocked(id);
      rows.push({
        id,
        ...WORDS[id],
        locked,
        allowed_in_private: locked ? false : policy[id].allowed_in_private,
        local_available: LOCAL_FALLBACK.includes(id) ? await this.localHook(id) : false,
      });
    }
    return { policy, rows };
  }
}

export function deniedError(capability: PrivacyCapability): AncileError {
  return new AncileError({
    code: 'privacy.denied',
    title: 'This notebook is private, so that stayed on this computer',
    hint: isLocked(capability)
      ? 'Turn off Private for the notebook, or use a model on this computer.'
      : 'Allow it in Settings → Private notebooks, or use a model on this computer.',
    detail: `${WORDS[capability].label} is not allowed in a private notebook.`,
    status: 403,
    errorClass: 'permanent',
    context: { capability },
  });
}

export function lockedError(capability: string): AncileError {
  return new AncileError({
    code: 'privacy.locked',
    title: 'That cannot be switched on for private notebooks',
    hint: 'Private notebooks always keep cloud models, Claude Code, web access and hosted Auto reviewers off. Turn off Private for the notebook to use them.',
    status: 422,
    errorClass: 'permanent',
    context: { capability },
  });
}
