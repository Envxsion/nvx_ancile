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
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  ModelConfig,
  type ProviderId,
  ProviderTestRequest,
  type ProviderTestResponse,
  SetupCompleteRequest,
  type SetupStatus,
} from '@nvx/contracts';
import { ClassifiedError } from '@nvx/resilience';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { tracedFetch } from '../context';
import type { CatalogueSource } from '../gateway/catalogue';
import { DEFAULT_SECRET } from '../gateway/providers';
import type { ModelRegistry } from '../gateway/registry';
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
  baseUrl?: string;
  model?: ModelConfig;
}) => Promise<{ model: string }>;

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

export function testFailed(provider: string, err: unknown): AncileError {
  const msg = err instanceof Error ? err.message : String(err);
  const auth =
    (err instanceof ClassifiedError && (err.status === 401 || err.status === 403)) ||
    /401|403|api key|unauthor|invalid.*key/i.test(msg);
  const name = PROVIDERS.find((p) => p.id === provider)?.display_name ?? provider;
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
  return new AncileError({
    code: auth ? 'provider.auth_failed' : 'provider.unavailable',
    title: auth ? `${name} rejected the API key` : `${name} didn't answer the test`,
    hint: auth
      ? 'Check you copied the whole key, and that it is active in your provider account.'
      : 'Check your connection, then test again.',
    detail: msg,
    status: 502,
    errorClass: auth ? 'permanent' : 'transient',
  });
}

const PutModel = z.object({ enabled: z.boolean() }).strict();

export function setupRoutes(deps: SetupRouteDeps) {
  const r = new Hono<AppEnv>();
  const { registry, secrets, settings } = deps;

  const status = async (): Promise<SetupStatus> => {
    const names = new Set(await secrets.names());
    const ollamaReady = registry.all().some((m) => m.id.startsWith('ollama/') && registry.enabled(m));
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
    if (meta?.needs_key && !req.key) {
      throw new AncileError({
        code: 'request.invalid',
        title: 'Paste a key to test',
        hint: `${meta.display_name} needs an API key.`,
        status: 400,
        errorClass: 'permanent',
      });
    }
    const candidates = modelsOf(registry, req.provider);
    const cheapest = [...candidates].sort((a, b) => a.price.input_per_mtok - b.price.input_per_mtok)[0];
    const started = performance.now();
    let tested: { model: string };
    try {
      tested = await deps.tester({
        provider: req.provider,
        ...(req.key !== undefined && { key: req.key.trim() }),
        ...((req.base_url ?? (req.provider === 'ollama' ? deps.ollamaUrl : undefined)) && {
          baseUrl: req.base_url ?? deps.ollamaUrl,
        }),
        ...(cheapest && { model: cheapest }),
      });
    } catch (err) {
      throw testFailed(req.provider, err);
    }
    const latency = Math.round(performance.now() - started);
    let enabled: string[] = [];
    if (req.save) {
      const secret = DEFAULT_SECRET[req.provider];
      if (secret && req.key) await secrets.set(secret, req.key.trim());
      enabled = candidates.map((m) => m.id);
      await registry.setEnabled(Object.fromEntries(enabled.map((id) => [id, true])));
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

  r.put('/models/:id{.+}', async (c) => {
    const id = c.req.param('id');
    const m = registry.get(id);
    if (!m) throw notFound('That model');
    const req = await body(c, PutModel);
    await registry.setEnabled({ [id]: req.enabled });
    return c.json(registry.info().find((x) => x.id === id));
  });

  registerModelRoutes(r, { registry, secrets, ...(deps.catalogue && { catalogue: deps.catalogue }) });

  r.get('/routing', async (c) => {
    const classes = ['chat.default', 'chat.deep', 'utility'];
    const items = classes.map((tc) => {
      try {
        return { task_class: tc, chain: registry.chain(tc).map((m) => m.id), ok: true };
      } catch {
        return { task_class: tc, chain: [], ok: false };
      }
    });
    return c.json({ items });
  });

  return r;
}

/** The real tester: one token through the AI SDK, or Ollama's tag list. */
export function liveTester(
  languageModel: (m: ModelConfig, key: string | undefined) => Promise<import('ai').LanguageModel>,
): ProviderTester {
  return async ({ provider, key, baseUrl, model }) => {
    if (provider === 'ollama') {
      const base = (baseUrl ?? 'http://localhost:11434').replace(/\/v1\/?$/, '').replace(/\/$/, '');
      const res = await tracedFetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4_000) });
      if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
      const tags = (await res.json()) as { models?: { name: string }[] };
      return { model: tags.models?.[0]?.name ?? 'ollama' };
    }
    if (!model) throw new Error(`No ${provider} model is configured in models.yaml to test with`);
    const { generateText } = await import('ai');
    const lm = await languageModel(ModelConfig.parse({ ...model, enabled: true }), key);
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
