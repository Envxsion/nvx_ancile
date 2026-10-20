/**
 * ------------------------------------------------------------------
 *  Title    |  Onboarding, models and routing
 *  Ref      |  DESIGN.md §13 (onboarding), §7.2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Get from a fresh install to a first answer without
 *           |  editing a file: test a key live, keep it encrypted, switch
 *           |  on that provider's models, choose a permissions preset.
 *  How      |  A key is only stored after a real call with it succeeds
 *           |  (one token, the provider's cheapest configured model).
 *           |  The tester is injected so tests never touch a network.
 *           |  Ollama has no key: it passes when its server answers.
 *           |  Routing chains are edited here too (Admin → Routing):
 *           |  a saved order wins over config/routing.yaml until reset.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  isPersonalAnthropicKey,
  ModelConfig,
  type ProviderId,
  ProviderTestRequest,
  type ProviderTestResponse,
  PutRoutingRequest,
  type RoutingChain,
  type RoutingList,
  SetupCompleteRequest,
  type SetupStatus,
  ShowModelRequest,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { tracedFetch } from '../context';
import type { CatalogueSource } from '../gateway/catalogue';
import { baseUrlFor, isRegion, knownProfile, type ProviderProfile, profileFor } from '../gateway/profiles';
import { classifyFailure, failureParts, failureWords } from '../gateway/provider-errors';
import { ANTHROPIC_WORKSPACE_SECRET, DEFAULT_SECRET } from '../gateway/providers';
import { canChat, type ModelRegistry, ollamaName } from '../gateway/registry';
import { body } from '../http/body';
import { type JsonGetter, type ListKind, list, liveJson } from '../models/watch/listers';
import { notFound } from '../obs/errors';
import type { SecretStore } from '../secrets';
import { SETTING, type SettingsStore } from '../settings';
import { keyCheckFor, offeredBy } from './key-check';
import { registerModelRoutes } from './models';

const PROVIDERS: { id: ProviderId; display_name: string; needs_key: boolean }[] = [
  { id: 'anthropic', display_name: 'Anthropic', needs_key: true },
  { id: 'openai', display_name: 'OpenAI', needs_key: true },
  { id: 'google', display_name: 'Google', needs_key: true },
  { id: 'openrouter', display_name: 'OpenRouter', needs_key: true },
  { id: 'ollama', display_name: 'Ollama (on this computer)', needs_key: false },
];

/** Run one tiny real request against the provider. Throws on any failure. */
export type ProviderTester = (input: {
  provider: ProviderId;
  key?: string;
  /** Anthropic personal keys: the workspace the test call bills. */
  workspaceId?: string;
  /** Providers with regions: the region the key was made in. */
  region?: string;
  baseUrl?: string;
  model?: ModelConfig;
  /** Every model configured for the provider, cheapest first: the tester may prefer one its list offers. */
  models?: ModelConfig[];
  /** Ollama: the models it has pulled (its tag names). */
}) => Promise<{
  /** The model that answered; null when the key was checked without a call to a model. */
  model: string | null;
  available?: string[];
  /** The provider's own model list, as read with this key (provider_model ids). Absent when none was read. */
  offered?: string[];
}>;

export interface SetupRouteDeps {
  registry: ModelRegistry;
  secrets: SecretStore;
  settings: SettingsStore;
  tester: ProviderTester;
  ollamaUrl?: string | undefined;
  /** The permission preset changed: reload the policies that depend on it. */
  onPreset?: (preset: 'careful' | 'balanced' | 'hands_off') => Promise<void>;
  /** Where model catalogues come from (tests pass recorded fixtures). */
  catalogue?: CatalogueSource;
}

/** Which configured models belong to a provider (Ollama models are any OpenAI-compatible model on its port, or ids under ollama/). */
export function modelsOf(registry: ModelRegistry, provider: ProviderId): ModelConfig[] {
  return registry
    .all()
    .filter((m) =>
      provider === 'ollama'
        ? m.id.startsWith('ollama/') || m.provider === 'ollama'
        : m.provider === provider && m.via === 'direct',
    );
}

/**
 * A failed key test, in words. The provider's profile reads the failure
 * (gateway/provider-errors.ts): a key is only called rejected on a 401 or 403
 * whose body sounds like authentication, never on a rate limit, a quota or
 * credit problem, or a wrong region, each of which has its own words. Matching
 * "API key" in the explanation misread other problems (an unscoped Anthropic
 * key's workspace request) as a bad key. `hide` is scrubbed from the provider's
 * explanation before it is shown; `region` is the one the key was tried in.
 */
export function testFailed(provider: string, err: unknown, hide?: string, region?: string): AncileError {
  if (err instanceof AncileError) return err;
  const said = providerSaid(err);
  const raw = (err instanceof Error ? err.message : String(err)) + (said ? `: ${said}` : '');
  const msg = (hide ? raw.split(hide).join('[hidden]') : raw).slice(0, 300);
  const profile = profileFor(provider);
  const seen = classifyFailure(profile, err);
  const name =
    PROVIDERS.find((p) => p.id === provider)?.display_name ?? knownProfile(provider)?.name ?? provider;
  if (provider === 'anthropic' && /anthropic-workspace-id/i.test(raw)) return workspaceNeeded(msg);
  if (provider === 'ollama') {
    return new AncileError({
      code: 'provider.unavailable',
      title: "Ollama isn't answering",
      hint: "If it isn't installed, get it from ollama.com/download. If it is, start it (ollama serve) and look again. It listens on http://localhost:11434 by default.",
      detail: msg,
      status: 502,
      errorClass: 'transient',
    });
  }
  // Google answers a bad key with a 400 whose reason is API_KEY_INVALID; the profile calls that a suspicion, here it is the answer.
  const kind = seen.suspectBadKey && /api_key_invalid|api key not valid/i.test(raw) ? 'bad_key' : seen.kind;
  // Out of credit, wrong region, a model this key may not use, a rejected key: each has a documented code.
  const words = failureWords(kind, profile, {
    region,
    regionHint: seen.regionHint === true,
    note: seen.note,
  });
  if (words)
    return new AncileError({
      code: words.code,
      title: words.title,
      hint: words.hint,
      detail: msg,
      status: 502,
      errorClass: 'permanent',
    });
  const limited = seen.kind === 'rate_limited' || seen.status === 429;
  if (limited)
    return new AncileError({
      code: 'provider.unavailable',
      title: `${name} is limiting requests right now`,
      hint: `The key may well be fine. Wait a minute, then test again; ${name}'s own explanation is below.`,
      detail: msg,
      status: 502,
      errorClass: 'transient',
    });
  // The key got through and the model it was tried on is not one it can use: the key is not the problem.
  const tried = (err as { triedModel?: string } | null)?.triedModel;
  if (isModelNotOffered(seen.status, raw))
    return new AncileError({
      code: 'provider.model_not_offered',
      title: `${name} accepted the key, but ${tried ?? 'the test model'} isn't offered to it`,
      hint: `The key was not the problem, and nothing was saved. ${name} does not serve that model to this key, so check that your plan or project there includes it, or add another ${name} model in Admin → Models, then test again.`,
      detail: msg,
      status: 502,
      errorClass: 'permanent',
    });
  if (isNetworkFailure(err))
    return new AncileError({
      code: 'provider.unavailable',
      title: `${name} didn't answer the test`,
      hint: `Check your connection, then test again. ${name}'s own explanation is below.`,
      detail: msg,
      status: 502,
      errorClass: 'transient',
    });
  // It answered but refused, or said it had a problem of its own: say so without blaming the connection.
  const theirs = seen.status >= 500 || seen.kind === 'server' || seen.kind === 'overloaded';
  return new AncileError({
    code: 'provider.unavailable',
    title: theirs ? `${name} had a problem answering the test` : `${name} turned the test down`,
    hint: theirs
      ? `The problem is on ${name}'s side. Wait a minute, then test again; its own explanation is below.`
      : `${name}'s own explanation is below${seen.suspectBadKey ? '. It may mean the key is wrong, so check it too' : ''}. Nothing was saved.`,
    detail: msg,
    status: 502,
    errorClass: theirs ? 'transient' : 'permanent',
  });
}

/** The provider's own sentence from an error body ({error:{message}}), when the failure carried one. */
function providerSaid(err: unknown): string {
  const { body } = failureParts(err);
  let parsed: unknown = body;
  if (typeof body === 'string')
    try {
      parsed = JSON.parse(body);
    } catch {
      return '';
    }
  const e = (parsed as { error?: unknown } | null)?.error;
  const m = typeof e === 'string' ? e : (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m.slice(0, 200) : '';
}

/** A model-not-found answer: a 404, or the words Google and others use when a model is not offered. */
export function isModelNotOffered(status: number, raw: string): boolean {
  if (status === 404) return true;
  return /(models\/\S+ is not found|not supported for generatecontent|model .{0,80}(does not exist|not found|is not available)|no such model|unknown model)/i.test(
    raw,
  );
}

const NETWORK_RE =
  /(fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_(CONNECT|SOCKET|HEADERS_TIMEOUT)|socket hang up|network error|cannot connect to api|timed out|timeout)/i;

/** A failure with no answer from the provider at all: DNS, refused or dropped connections, timeouts. */
export function isNetworkFailure(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === 'object' && i < 4; i++) {
    const x = e as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      statusCode?: unknown;
    };
    if (typeof x.statusCode === 'number') return false;
    if (x.name === 'AbortError' || x.name === 'TimeoutError') return true;
    if (
      NETWORK_RE.test(
        `${typeof x.code === 'string' ? x.code : ''} ${typeof x.message === 'string' ? x.message : ''}`,
      )
    )
      return true;
    e = x.cause;
  }
  return false;
}

/**
 * The region named in a request, checked against the provider's own list.
 * Undefined when the provider has no regions, or none was named (the default is used).
 */
export function regionFrom(profile: ProviderProfile, region: string | undefined): string | undefined {
  if (!profile.regions || !region) return undefined;
  if (isRegion(profile, region)) return region;
  throw new AncileError({
    code: 'request.invalid',
    title: `${profile.name} has no region called ${region}`,
    hint: `Pick one of: ${profile.regions.map((r) => r.id).join(', ')}.`,
    status: 400,
    errorClass: 'permanent',
  });
}

/** Keep (or clear) the region beside a provider's key, as the Anthropic workspace is kept. */
export async function saveRegion(
  secrets: Pick<SecretStore, 'set' | 'delete'>,
  profile: ProviderProfile,
  region: string | undefined,
): Promise<void> {
  if (!profile.regionSecret) return;
  if (region) await secrets.set(profile.regionSecret, region);
  else await secrets.delete(profile.regionSecret);
}

/** A personal Anthropic key (sk-ant-usr-) sent without the workspace it bills. */
export function workspaceNeeded(detail?: string): AncileError {
  return new AncileError({
    code: 'provider.workspace_needed',
    title: 'Anthropic needs to know which workspace this key bills',
    hint: 'This is a personal key (sk-ant-usr-), which is not tied to one workspace. In the Claude Console, open Settings → Workspaces, open the workspace and copy its ID (it starts with wrkspc_), then paste it beside the key. Nothing was saved.',
    status: 400,
    errorClass: 'permanent',
    ...(detail && { detail }),
  });
}

const PutModel = z.object({ enabled: z.boolean() }).strict();

export function setupRoutes(deps: SetupRouteDeps) {
  const r = new Hono<AppEnv>();
  const { registry, secrets, settings } = deps;

  const status = async (): Promise<SetupStatus> => {
    const names = new Set(await secrets.names());
    // Set up once an Ollama model can answer: switched on is not enough when Ollama does not have it.
    const ollamaReady = modelsOf(registry, 'ollama').some(
      (m) => canChat(m) && registry.status(m) === 'ready',
    );
    return {
      complete: (await settings.get<boolean>(SETTING.setupComplete)) === true,
      preset: (await settings.get<SetupStatus['preset']>(SETTING.preset)) ?? null,
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        display_name: p.display_name,
        needs_key: p.needs_key,
        configured: p.id === 'ollama' ? ollamaReady : names.has(DEFAULT_SECRET[p.id] ?? ''),
      })),
      offline_model: registry.offline,
    };
  };

  r.get('/setup', async (c) => c.json(await status()));

  r.post('/setup/providers/test', async (c) => {
    const req = await body(c, ProviderTestRequest);
    const meta = PROVIDERS.find((p) => p.id === req.provider);
    const profile = profileFor(req.provider);
    // "Test the saved key" (a new region for a key already kept): read it here; it is never sent back.
    const saved =
      !req.key && req.use_saved && DEFAULT_SECRET[req.provider]
        ? await secrets.get(DEFAULT_SECRET[req.provider] as string)
        : undefined;
    if ((meta?.needs_key ?? profile.needsKey) && !req.key && !saved) {
      throw new AncileError({
        code: 'request.invalid',
        title: 'Paste a key to test',
        hint: `${meta?.display_name ?? profile.name} needs an API key.`,
        status: 400,
        errorClass: 'permanent',
      });
    }
    const key = req.key?.trim() ?? saved;
    // Only a personal Anthropic key takes a workspace; any other key bills its own.
    const workspaceId =
      req.provider === 'anthropic' && isPersonalAnthropicKey(key) ? req.workspace_id : undefined;
    if (req.provider === 'anthropic' && isPersonalAnthropicKey(key) && !workspaceId) throw workspaceNeeded();
    const region = regionFrom(profile, req.region);
    const candidates = modelsOf(registry, req.provider);
    const byPrice = [...candidates].sort((a, b) => a.price.input_per_mtok - b.price.input_per_mtok);
    const cheapest = byPrice[0];
    const started = performance.now();
    let tested: Awaited<ReturnType<ProviderTester>>;
    try {
      tested = await deps.tester({
        provider: req.provider,
        ...(key !== undefined && { key }),
        ...(workspaceId && { workspaceId }),
        ...(region && { region }),
        ...((req.base_url ?? (req.provider === 'ollama' ? deps.ollamaUrl : undefined)) && {
          baseUrl: req.base_url ?? deps.ollamaUrl,
        }),
        ...(cheapest && { model: cheapest, models: byPrice }),
      });
    } catch (err) {
      throw testFailed(req.provider, err, key, region);
    }
    const latency = Math.round(performance.now() - started);
    // Models the provider's own list does not offer to this key stay off.
    const split = offeredBy(candidates, tested.offered);
    const missing = new Set(split.missing.map((m) => m.id));
    let enabled: string[] = [];
    if (req.save) {
      const secret = DEFAULT_SECRET[req.provider];
      if (secret && key) await secrets.set(secret, key);
      if (req.provider === 'anthropic' && key) {
        if (workspaceId) await secrets.set(ANTHROPIC_WORKSPACE_SECRET, workspaceId);
        else await secrets.delete(ANTHROPIC_WORKSPACE_SECRET);
      }
      if (key) await saveRegion(secrets, profile, region);
      // Ollama: only the models it has pulled, wherever they are configured to be
      // served from; one it does not have could not answer. Models found in Ollama
      // are on already, and one you turned off stays off.
      const pulled = tested.available ? new Set(tested.available.map(ollamaName)) : null;
      const ready = candidates.filter(
        (m) =>
          !registry.isDiscovered(m.id) &&
          (!pulled || pulled.has(ollamaName(m.provider_model))) &&
          !missing.has(m.id),
      );
      enabled = ready.map((m) => m.id);
      await registry.setEnabled(Object.fromEntries(enabled.map((id) => [id, true])));
      if (req.provider === 'ollama') {
        await registry.refreshOllama();
        // What is on because Ollama works: the models above, and those it lists by itself.
        enabled = modelsOf(registry, 'ollama')
          .filter((m) => canChat(m) && registry.status(m) === 'ready')
          .map((m) => m.id);
      }
    }
    const out: z.infer<typeof ProviderTestResponse> = {
      ok: true,
      provider: req.provider,
      model: tested.model,
      latency_ms: latency,
      enabled,
      not_offered: split.missing.map((m) => ({ id: m.id, display_name: m.display_name })),
    };
    return c.json(out);
  });

  r.post('/setup/complete', async (c) => {
    const req = await body(c, SetupCompleteRequest);
    await settings.set(SETTING.preset, req.preset);
    if (req.memory_capture) await settings.set(SETTING.memoryCapture, req.memory_capture);
    if (req.about?.trim()) await settings.set(SETTING.memoryAbout, req.about.trim());
    await deps.onPreset?.(req.preset);
    await settings.set(SETTING.setupComplete, true);
    return c.json(await status());
  });

  r.get('/models', async (c) => {
    await registry.refresh();
    return c.json({ items: registry.info(), next_cursor: null });
  });

  /** MD2: "Add more models" shows a model beyond a provider's starter three; the same call hides it again. */
  r.post('/models/shown', async (c) => {
    const req = await body(c, ShowModelRequest);
    const m = registry.getExact(req.id);
    if (!m) throw notFound('That model');
    await registry.setShown(m.id, req.shown);
    await registry.refresh();
    return c.json(registry.info().find((x) => x.id === m.id));
  });

  r.put('/models/:id{.+}', async (c) => {
    const id = c.req.param('id');
    const m = registry.getExact(id);
    if (!m) throw notFound('That model');
    const req = await body(c, PutModel);
    await registry.setEnabled({ [id]: req.enabled });
    return c.json(registry.info().find((x) => x.id === id));
  });

  registerModelRoutes(r, { registry, secrets, ...(deps.catalogue && { catalogue: deps.catalogue }) });

  /** One class as Admin → Routing shows it: the saved or YAML order, and who can answer now. */
  const routingOf = (tc: string): RoutingChain => {
    const saved = registry.savedChain(tc);
    const def = registry.defaultChain(tc);
    let chain: string[] = [];
    let ok = true;
    try {
      chain = registry.chain(tc).map((m) => m.id);
    } catch {
      ok = false;
    }
    return { task_class: tc, chain, ok, configured: saved ?? def, default: def, custom: saved !== undefined };
  };

  const knownClass = (tc: string): string => {
    if (registry.taskClassNames().includes(tc)) return tc;
    throw new AncileError({
      code: 'routing.task_class_unknown',
      title: `There is no task class called ${tc}`,
      hint: 'Pick one of the task classes listed in Admin → Routing.',
      status: 404,
      errorClass: 'permanent',
    });
  };

  r.get('/routing', (c) => {
    const out: RoutingList = { items: registry.taskClassNames().map(routingOf) };
    return c.json(out);
  });

  r.put('/routing/:task_class', async (c) => {
    const tc = knownClass(c.req.param('task_class'));
    const req = await body(c, PutRoutingRequest);
    const ids = [...new Set(req.chain.map((id) => id.trim()))];
    if (ids.length === 0) {
      throw new AncileError({
        code: 'routing.chain_empty',
        title: 'A chain needs at least one model',
        hint: 'Add a model before saving, or reset the chain to its default.',
        status: 400,
        errorClass: 'permanent',
      });
    }
    // Ids the class already lists may stay even when no model has them yet (a YAML entry for a node not set up).
    const listed = new Set([...registry.defaultChain(tc), ...(registry.savedChain(tc) ?? [])]);
    for (const id of ids) {
      const m = registry.get(id);
      if (!m && listed.has(id)) continue;
      if (!m) {
        throw new AncileError({
          code: 'routing.model_unknown',
          title: `${id} isn't one of your models`,
          hint: 'Add it in Admin → Models first, or pick a model from the list.',
          status: 400,
          errorClass: 'permanent',
          context: { model: id },
        });
      }
      if (!canChat(m)) {
        throw new AncileError({
          code: 'model.not_chat',
          title: `${m.display_name} can't answer messages`,
          hint: 'It is an embedding or rerank model; pick a chat model for this chain.',
          status: 422,
          errorClass: 'permanent',
          context: { model: id },
        });
      }
    }
    await registry.saveChain(tc, ids);
    return c.json(routingOf(tc));
  });

  r.delete('/routing/:task_class', async (c) => {
    const tc = knownClass(c.req.param('task_class'));
    await registry.saveChain(tc, null);
    return c.json(routingOf(tc));
  });

  return r;
}

/** Nothing to test with: no list could be read and no model is configured for the provider. */
export function noTestModel(provider: string): AncileError {
  const name = knownProfile(provider)?.name ?? provider;
  return new AncileError({
    code: 'setup.no_test_model',
    title: `NVX Ancile has no ${name} model to test the key with`,
    hint: `${name} does not offer a way to check a key without a model. Add a ${name} model in Admin → Models, then test again. Nothing was saved.`,
    status: 422,
    errorClass: 'permanent',
  });
}

/**
 * The real tester. Ollama: its tag list. A provider whose own list needs the key
 * (key-check.ts): read that list, which proves the key without spending a token
 * and says which models it is offered. Anything else: one token on a configured
 * model, one the provider's list (read if it answers) offers when there is one.
 */
export function liveTester(
  languageModel: (
    m: ModelConfig,
    secrets: { get(name: string): Promise<string | undefined> },
  ) => Promise<import('ai').LanguageModel>,
  get: JsonGetter = liveJson,
): ProviderTester {
  return async ({ provider, key, workspaceId, region, baseUrl, model, models }) => {
    if (provider === 'ollama') {
      const base = (baseUrl ?? 'http://localhost:11434').replace(/\/v1\/?$/, '').replace(/\/$/, '');
      const res = await tracedFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4_000) });
      if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
      const tags = (await res.json()) as { models?: { name: string }[] };
      return {
        model: tags.models?.[0]?.name ?? 'ollama',
        available: (tags.models ?? []).map((m) => m.name).filter(Boolean),
      };
    }
    const profile = profileFor(provider);
    const plan = keyCheckFor(provider);
    const root = baseUrl ?? baseUrlFor(profile, region);
    // The getter's own error (with its status and body) is what testFailed reads, not the lister's summary.
    let raw: unknown;
    const spy: JsonGetter = async (...args) => {
      try {
        return await get(...args);
      } catch (err) {
        raw = err;
        throw err;
      }
    };
    const kind: ListKind = profile.sdk;
    let offered: string[] | undefined;
    if (root && plan.via === 'key') {
      // OpenRouter: /key answers only for a good key (/models is public).
      await spy(`${root.replace(/\/+$/, '')}${profile.check.path}`, { authorization: `Bearer ${key ?? ''}` });
      return { model: null };
    }
    if (root && (plan.via === 'list' || profile.modelsPath)) {
      try {
        const target = {
          kind,
          baseUrl: root,
          key: key ?? null,
          workspaceId,
          path: profile.modelsPath,
        };
        offered = (await list(target, spy)).map((m) => m.provider_model);
      } catch (err) {
        // A list we trust must accept the key. Any other list is only a help, so its failure is not the key's.
        // A 403 is a scope, not a bad key: a restricted OpenAI key may answer without model.read, and
        // a key may be barred from listing only. Those fall through to the one-token test.
        const status = (raw as { status?: number } | undefined)?.status;
        if (plan.via === 'list' && status !== 403) throw raw ?? err;
      }
      if (plan.via === 'list' && offered) return { model: null, offered };
    }
    // Prefer a configured model the list offers; otherwise the cheapest configured one is tried as it stands.
    const test = (offered?.length ? offeredBy(models ?? [], offered).offered[0] : undefined) ?? model;
    if (!test) throw noTestModel(provider);
    const { generateText } = await import('ai');
    // Only the values under test: the key by any name, the workspace and region by their own.
    const regionSecret = profile.regionSecret;
    const lm = await languageModel(ModelConfig.parse({ ...test, enabled: true }), {
      get: async (name) =>
        name === ANTHROPIC_WORKSPACE_SECRET ? workspaceId : name === regionSecret ? region : key,
    });
    try {
      await generateText({
        model: lm,
        prompt: 'Reply with OK.',
        maxOutputTokens: 1,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (err && typeof err === 'object') (err as { triedModel?: string }).triedModel = test.display_name;
      throw err;
    }
    return { model: test.id, ...(offered?.length && { offered }) };
  };
}
