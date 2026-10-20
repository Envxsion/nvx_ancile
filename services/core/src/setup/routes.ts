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
import { isRegion, knownProfile, type ProviderProfile, profileFor } from '../gateway/profiles';
import { classifyFailure, failureWords } from '../gateway/provider-errors';
import { ANTHROPIC_WORKSPACE_SECRET, DEFAULT_SECRET } from '../gateway/providers';
import { canChat, type ModelRegistry, ollamaName } from '../gateway/registry';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import type { SecretStore } from '../secrets';
import { SETTING, type SettingsStore } from '../settings';
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
  /** Ollama: the models it has pulled (its tag names). */
}) => Promise<{ model: string; available?: string[] }>;

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
  const raw = err instanceof Error ? err.message : String(err);
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
  // Out of credit, wrong region, a model this key may not use, a rejected key: each has a documented code.
  const words = failureWords(seen.kind, profile, {
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
  return new AncileError({
    code: 'provider.unavailable',
    title: limited ? `${name} is limiting requests right now` : `${name} didn't answer the test`,
    hint: limited
      ? `The key may well be fine. Wait a minute, then test again; ${name}'s own explanation is below.`
      : `Check your connection, then test again${seen.suspectBadKey ? ' (and check the key)' : ''}. ${name}'s own explanation is below.`,
    detail: msg,
    status: 502,
    errorClass: 'transient',
  });
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
    const cheapest = [...candidates].sort((a, b) => a.price.input_per_mtok - b.price.input_per_mtok)[0];
    const started = performance.now();
    let tested: { model: string; available?: string[] };
    try {
      tested = await deps.tester({
        provider: req.provider,
        ...(key !== undefined && { key }),
        ...(workspaceId && { workspaceId }),
        ...(region && { region }),
        ...((req.base_url ?? (req.provider === 'ollama' ? deps.ollamaUrl : undefined)) && {
          baseUrl: req.base_url ?? deps.ollamaUrl,
        }),
        ...(cheapest && { model: cheapest }),
      });
    } catch (err) {
      throw testFailed(req.provider, err, key, region);
    }
    const latency = Math.round(performance.now() - started);
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
        (m) => !registry.isDiscovered(m.id) && (!pulled || pulled.has(ollamaName(m.provider_model))),
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

/** The real tester: one token through the AI SDK, or Ollama's tag list. */
export function liveTester(
  languageModel: (
    m: ModelConfig,
    secrets: { get(name: string): Promise<string | undefined> },
  ) => Promise<import('ai').LanguageModel>,
): ProviderTester {
  return async ({ provider, key, workspaceId, region, baseUrl, model }) => {
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
    if (!model) throw new Error(`No ${provider} model is configured in models.yaml to test with`);
    const { generateText } = await import('ai');
    // Only the values under test: the key by any name, the workspace and region by their own.
    const regionSecret = profileFor(provider).regionSecret;
    const lm = await languageModel(ModelConfig.parse({ ...model, enabled: true }), {
      get: async (name) =>
        name === ANTHROPIC_WORKSPACE_SECRET ? workspaceId : name === regionSecret ? region : key,
    });
    await generateText({
      model: lm,
      prompt: 'Reply with OK.',
      maxOutputTokens: 1,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(15_000),
    });
    return { model: model.id };
  };
}
