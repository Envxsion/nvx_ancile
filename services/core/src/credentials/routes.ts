/**
 * ------------------------------------------------------------------
 *  Title    |  /credentials: Settings → API keys
 *  Ref      |  DESIGN.md §5.8 · docs/configuration.md (API keys)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Add, replace and remove every key and token NVX Ancile
 *           |  uses, kept encrypted in the secret store.
 *  How      |  One table maps each credential to its secret name, the
 *           |  environment variable that overrides it, and how a new
 *           |  value is checked before it is saved: a one-token model
 *           |  call (the setup tester), the Controller asking RunPod,
 *           |  the service's own "who am I", or only its shape.
 *  Note     |  A value never leaves this module towards the browser or
 *           |  a log: responses carry `set` and `last4` only, and any
 *           |  error raised while checking is scrubbed of the value
 *           |  before it is thrown on (the redactor is a second line,
 *           |  not the first).
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type CredentialCheck,
  CredentialId,
  type CredentialStatus,
  isPersonalAnthropicKey,
  last4,
  type PlanCredit,
  type ProviderId,
  type ProviderInfoList,
  SaveCredentialRequest,
} from '@nvx/contracts';
import { CircuitBreaker, ClassifiedError, classifyStatus, guarded } from '@nvx/resilience';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { RUNPOD_KEY_SECRET } from '../compute/routes';
import { tracedFetch } from '../context';
import { knownProfile, PROFILES, providerInfo, recogniseKey } from '../gateway/profiles';
import { ANTHROPIC_WORKSPACE_SECRET, DEFAULT_SECRET } from '../gateway/providers';
import type { ModelRegistry } from '../gateway/registry';
import { body } from '../http/body';
import { TYPESAFE_KEY_SECRET } from '../permissions/auto/wire';
import { GITHUB_TOKEN_SECRET } from '../repos/github';
import type { SecretStore } from '../secrets';
import { offeredBy } from '../setup/key-check';
import {
  modelsOf,
  type ProviderTester,
  regionFrom,
  saveRegion,
  testFailed,
  workspaceNeeded,
} from '../setup/routes';

export const HUGGINGFACE_TOKEN_SECRET = 'huggingface.token';
export const MEMORY_REMOTE_SECRET = 'memory.remote';

interface Definition {
  name: string;
  secret: string;
  env: string;
  check: CredentialCheck;
}

/** A key-billed provider's row, from its profile. */
function providerCredential(id: string): Definition {
  const p = knownProfile(id);
  const secret = p?.secret ?? DEFAULT_SECRET[id] ?? '';
  return { name: p?.name ?? id, secret, env: secret, check: 'provider' };
}

export const CREDENTIALS: Record<CredentialId, Definition> = {
  anthropic: {
    name: 'Anthropic',
    secret: DEFAULT_SECRET.anthropic ?? '',
    env: 'ANTHROPIC_API_KEY',
    check: 'provider',
  },
  openai: { name: 'OpenAI', secret: DEFAULT_SECRET.openai ?? '', env: 'OPENAI_API_KEY', check: 'provider' },
  google: {
    name: 'Google',
    secret: DEFAULT_SECRET.google ?? '',
    env: 'GOOGLE_GENERATIVE_AI_API_KEY',
    check: 'provider',
  },
  openrouter: {
    name: 'OpenRouter',
    secret: DEFAULT_SECRET.openrouter ?? '',
    env: 'OPENROUTER_API_KEY',
    check: 'provider',
  },
  runpod: { name: 'RunPod', secret: RUNPOD_KEY_SECRET, env: 'RUNPOD_API_KEY', check: 'controller' },
  // TODO(phase-5): hand the token to new GPU nodes (HF_TOKEN in the pod's environment) via the Controller.
  huggingface: { name: 'Hugging Face', secret: HUGGINGFACE_TOKEN_SECRET, env: 'HF_TOKEN', check: 'service' },
  github: { name: 'GitHub', secret: GITHUB_TOKEN_SECRET, env: 'GITHUB_TOKEN', check: 'service' },
  memory_remote: {
    name: 'Memory backup remote',
    secret: MEMORY_REMOTE_SECRET,
    env: 'ANCILE_MEMORY_REMOTE',
    check: 'format',
  },
  // Auto mode's reviewer, called directly (docs/auto-mode.md). Checked by shape only:
  // a test call would itself be a paid decision.
  // PV1: the profile table (gateway/profiles.ts) names each one's secret; the environment variable is the same name.
  deepseek: providerCredential('deepseek'),
  moonshot: providerCredential('moonshot'),
  minimax: providerCredential('minimax'),
  zai: providerCredential('zai'),
  qwen: providerCredential('qwen'),
  xai: providerCredential('xai'),
  mistral: providerCredential('mistral'),
  typesafe: { name: 'TypeSafe (Jev)', secret: TYPESAFE_KEY_SECRET, env: 'TYPESAFE_API_KEY', check: 'format' },
};

/** Secret name → the environment variable that wins over it (for EnvFirstSecretStore). */
export const ENV_FOR_SECRET: Record<string, string> = {
  ...Object.fromEntries(Object.values(CREDENTIALS).map((d) => [d.secret, d.env])),
  // The workspace a personal Anthropic key bills, beside ANTHROPIC_API_KEY.
  [ANTHROPIC_WORKSPACE_SECRET]: 'ANTHROPIC_WORKSPACE_ID',
  // The region of a provider that has them (Moonshot, MiniMax, Qwen, Z.ai), beside its key.
  ...Object.fromEntries(
    PROFILES.flatMap((p) => (p.regionSecret ? [[p.regionSecret, p.regionSecret] as const] : [])),
  ),
};

/** Checks a token with the service it belongs to. Throws on any failure. */
export type ServiceCheck = (id: 'huggingface' | 'github', token: string) => Promise<void>;

const breaker = new CircuitBreaker();

/** The real service check: Hugging Face's and GitHub's own "who am I". */
export const liveServiceCheck: ServiceCheck = async (id, token) => {
  const url = id === 'github' ? 'https://api.github.com/user' : 'https://huggingface.co/api/whoami-v2';
  await guarded(
    { key: `credentials.${id}`, breaker, timeoutMs: 10_000, retry: { maxAttempts: 2 } },
    async (signal) => {
      const res = await tracedFetch(url, {
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(id === 'github' && { 'x-github-api-version': '2022-11-28' }),
        },
      });
      await res.body?.cancel();
      if (!res.ok)
        throw new ClassifiedError(classifyStatus(res.status), `${id} answered ${res.status}`, {
          status: res.status,
        });
    },
  );
};

export interface CredentialRouteDeps {
  /** The secret store, ideally the EnvFirstSecretStore main.ts builds. */
  secrets: SecretStore;
  /** Where environment overrides are read from (process.env in main.ts). */
  env: Record<string, string | undefined>;
  registry: ModelRegistry;
  /** The setup tester: one tiny real call with the key. */
  tester: ProviderTester;
  serviceCheck?: ServiceCheck;
  /** RunPod through the Controller; absent when there is no Controller. */
  runpod?: { connect(key: string): Promise<unknown>; disconnect(): Promise<unknown> } | undefined;
  /** CR1: the Anthropic key's monthly-credit setting, as saved (gateway/credit.ts). */
  planCredit?: () => PlanCredit | null;
  /** A credential changed: drop anything cached with the old value. */
  onChange?: (id: CredentialId) => void | Promise<void>;
}

const sanitise = (text: string | undefined, value: string) =>
  text && value ? text.split(value).join('[hidden]') : text;

/** Rethrow anything raised while checking, with the value scrubbed out of every field. */
function scrubbed(err: unknown, value: string, name: string): AncileError {
  if (err instanceof AncileError) {
    const detail = sanitise(err.detail, value);
    return new AncileError({
      code: err.code,
      title: sanitise(err.title, value) ?? err.title,
      hint: sanitise(err.hint, value) ?? err.hint,
      status: err.status,
      retryable: err.retryable,
      errorClass: err.errorClass,
      ...(detail !== undefined && { detail }),
    });
  }
  return checkFailed(name, sanitise(err instanceof Error ? err.message : String(err), value));
}

function checkFailed(name: string, detail?: string): AncileError {
  return new AncileError({
    code: 'credentials.check_failed',
    title: `Couldn't reach ${name} to check it`,
    hint: 'Check your connection, then try again. Nothing was saved.',
    status: 502,
    retryable: true,
    errorClass: 'transient',
    ...(detail && { detail: detail.slice(0, 300) }),
  });
}

function rejected(name: string, what: string, where: string): AncileError {
  return new AncileError({
    code: 'credentials.rejected',
    title: `${name} rejected the ${what}`,
    hint: `Check you copied all of it and that it is still active, or make a new one at ${where}. Nothing was saved.`,
    status: 502,
    errorClass: 'permanent',
  });
}

function fromEnvironment(d: Definition): AncileError {
  return new AncileError({
    code: 'credentials.from_environment',
    title: `${d.name} is set in the environment`,
    hint: `Change or remove ${d.env} where NVX Ancile is started, then restart it.`,
    status: 409,
    errorClass: 'permanent',
  });
}

export const GIT_REMOTE =
  /^(https?:\/\/[^\s]+|ssh:\/\/[^\s]+|git:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+|file:\/\/[^\s]+)$/;

export function credentialRoutes(deps: CredentialRouteDeps) {
  const r = new Hono<AppEnv>();
  const { secrets, env, registry } = deps;
  const serviceCheck = deps.serviceCheck ?? liveServiceCheck;

  const definition = (raw: string): [CredentialId, Definition] => {
    const id = CredentialId.safeParse(raw);
    if (!id.success)
      throw new AncileError({
        code: 'credentials.unknown',
        title: 'There is no key by that name',
        hint: 'Pick one from Settings → API keys.',
        status: 404,
        errorClass: 'permanent',
      });
    return [id.data, CREDENTIALS[id.data]];
  };

  const statusOf = async (id: CredentialId, saved: Set<string>): Promise<CredentialStatus> => {
    const d = CREDENTIALS[id];
    const envValue = env[d.env]?.trim() || undefined;
    const value = envValue ?? (saved.has(d.secret) ? await secrets.get(d.secret) : undefined);
    const unavailable = id === 'runpod' && !deps.runpod;
    const profile = d.check === 'provider' ? knownProfile(id) : undefined;
    return {
      id,
      set: !!value,
      last4: last4(value),
      source: envValue ? 'environment' : value ? 'saved' : null,
      env_var: d.env,
      check: d.check,
      available: !unavailable,
      unavailable_reason: unavailable ? 'Compute is not set up on this install (no Controller).' : null,
      ...(id === 'anthropic' && {
        workspace_id: value ? ((await secrets.get(ANTHROPIC_WORKSPACE_SECRET)) ?? null) : null,
        plan_credit: value ? (deps.planCredit?.() ?? null) : null,
      }),
      ...(profile?.regionSecret && {
        region: value ? ((await secrets.get(profile.regionSecret)) ?? null) : null,
        region_env_var: profile.regionSecret,
      }),
    };
  };

  const list = async (): Promise<CredentialStatus[]> => {
    const saved = new Set(await secrets.names());
    return Promise.all(CredentialId.options.map((id) => statusOf(id, saved)));
  };

  const changed = async (id: CredentialId) => {
    await registry.refresh();
    await deps.onChange?.(id);
  };

  r.get('/credentials', async (c) => c.json({ items: await list() }));

  // What the Cockpit needs to list model providers without hard-coding them (PV3, PV1).
  r.get('/providers', (c) => c.json({ items: PROFILES.map(providerInfo) } as ProviderInfoList));

  r.put('/credentials/:id', async (c) => {
    const [id, d] = definition(c.req.param('id'));
    if (env[d.env]?.trim()) throw fromEnvironment(d);
    const { value, workspace_id, region: askedRegion } = await body(c, SaveCredentialRequest);
    const wasSet = (await secrets.names()).includes(d.secret);
    let notOffered: { id: string; display_name: string }[] = [];

    try {
      if (d.check === 'provider') {
        const provider = id as ProviderId;
        const profile = knownProfile(provider);
        // The key's own shape can tell it is for another provider, or cannot send a message (an admin key).
        const shape = recogniseKey(value, provider);
        if (shape?.confirmed && shape.provider !== provider)
          throw new AncileError({
            code: 'credentials.invalid',
            title: `That key is for ${knownProfile(shape.provider)?.name ?? shape.provider}, not ${d.name}`,
            hint: `Paste a ${d.name} key here, or add this one under ${knownProfile(shape.provider)?.name ?? shape.provider}. Nothing was saved.`,
            status: 400,
            errorClass: 'permanent',
          });
        if (shape && !shape.usable)
          throw new AncileError({
            code: 'credentials.invalid',
            title: `That is an ${shape.kind} key, which cannot send messages`,
            hint: `Make a normal API key at ${profile?.docsUrl ?? "the provider's site"} and paste that. Nothing was saved.`,
            status: 400,
            errorClass: 'permanent',
          });
        const region = profile ? regionFrom(profile, askedRegion) : undefined;
        // Only a personal Anthropic key takes a workspace; any other key bills its own.
        const personal = provider === 'anthropic' && isPersonalAnthropicKey(value);
        const workspaceId = personal ? workspace_id : undefined;
        if (personal && !workspaceId) throw workspaceNeeded();
        const candidates = modelsOf(registry, provider);
        const byPrice = [...candidates].sort((a, b) => a.price.input_per_mtok - b.price.input_per_mtok);
        const cheapest = byPrice[0];
        let tested: Awaited<ReturnType<typeof deps.tester>>;
        try {
          tested = await deps.tester({
            provider,
            key: value,
            ...(workspaceId && { workspaceId }),
            ...(region && { region }),
            ...(cheapest && { model: cheapest, models: byPrice }),
          });
        } catch (err) {
          throw testFailed(provider, err, value, region);
        }
        await secrets.set(d.secret, value);
        if (profile) await saveRegion(secrets, profile, region);
        if (provider === 'anthropic') {
          if (workspaceId) await secrets.set(ANTHROPIC_WORKSPACE_SECRET, workspaceId);
          else await secrets.delete(ANTHROPIC_WORKSPACE_SECRET);
        }
        // A first key switches its provider's models on, as setup does; a
        // replacement leaves your choices alone.
        // Models its own list does not offer to this key stay off, and the answer says which.
        const split = offeredBy(candidates, tested.offered);
        notOffered = split.missing.map((m) => ({ id: m.id, display_name: m.display_name }));
        if (!wasSet && split.offered.length)
          await registry.setEnabled(Object.fromEntries(split.offered.map((m) => [m.id, true])));
      } else if (d.check === 'controller') {
        if (!deps.runpod)
          throw new AncileError({
            code: 'credentials.unavailable',
            title: 'Compute is not set up here',
            hint: 'RunPod is managed by the Controller. Start NVX Ancile with CONTROLLER_URL set, then add the key.',
            status: 503,
            errorClass: 'permanent',
          });
        await deps.runpod.connect(value); // the Controller checks it with RunPod, then it is saved
      } else if (d.check === 'service') {
        const service = id as 'huggingface' | 'github';
        try {
          await serviceCheck(service, value);
        } catch (err) {
          const status = err instanceof ClassifiedError ? err.status : undefined;
          if (status === 401 || status === 403)
            throw service === 'github'
              ? rejected('GitHub', 'token', 'github.com/settings/tokens')
              : rejected('Hugging Face', 'token', 'huggingface.co/settings/tokens');
          throw err;
        }
        await secrets.set(d.secret, value);
      } else if (id !== 'memory_remote') {
        if (/\s/.test(value) || value.length < 16)
          throw new AncileError({
            code: 'credentials.invalid',
            title: `That doesn't look like a ${d.name} key`,
            hint: 'Paste the whole key, with no spaces. Nothing was saved.',
            status: 400,
            errorClass: 'permanent',
          });
        await secrets.set(d.secret, value);
      } else {
        if (!GIT_REMOTE.test(value))
          throw new AncileError({
            code: 'credentials.invalid',
            title: "That doesn't look like a git remote",
            hint: 'Use an address git can push to, such as git@github.com:you/memory.git or https://github.com/you/memory.git.',
            status: 400,
            errorClass: 'permanent',
          });
        await secrets.set(d.secret, value);
      }
    } catch (err) {
      throw scrubbed(err, value, d.name);
    }

    await changed(id);
    const saved = await statusOf(id, new Set(await secrets.names()));
    return c.json(notOffered.length ? { ...saved, not_offered: notOffered } : saved);
  });

  r.delete('/credentials/:id', async (c) => {
    const [id, d] = definition(c.req.param('id'));
    if (env[d.env]?.trim()) throw fromEnvironment(d);
    if (d.check === 'controller' && deps.runpod) await deps.runpod.disconnect();
    else await secrets.delete(d.secret);
    if (id === 'anthropic') await secrets.delete(ANTHROPIC_WORKSPACE_SECRET);
    const gone = d.check === 'provider' ? knownProfile(id)?.regionSecret : null;
    if (gone) await secrets.delete(gone);
    await changed(id);
    return c.json(await statusOf(id, new Set(await secrets.names())));
  });

  return r;
}
