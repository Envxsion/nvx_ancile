/**
 * ------------------------------------------------------------------
 *  Title    |  Adding models
 *  Ref      |  DESIGN.md §16.7 · Settings → Models · flow model picker
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Any model, from anywhere: OpenRouter's catalogue, a
 *           |  direct provider's model ids beyond the defaults, or any
 *           |  OpenAI-compatible server (vLLM on a RunPod pod, LM Studio,
 *           |  a box on your network).
 *  How      |  Added models are ModelConfigs kept in settings and merged
 *           |  into the registry, so routing, the model switcher and
 *           |  flows see them at once. An endpoint's key goes into the
 *           |  encrypted secret store under its own name and is never
 *           |  returned. Config models (models.yaml) can only be
 *           |  switched on or off, and given a chip hue, here.
 *  Note     |  Removing an added model keeps it (and its key) in
 *           |  memory for ten minutes, so POST /models/restore can
 *           |  take the removal back without the key leaving Core.
 * ------------------------------------------------------------------
 */

import {
  AddModelRequest,
  AncileError,
  type CatalogueModel,
  CatalogueRequest,
  ModelConfig,
  type ModelSource,
  PatchModelRequest,
} from '@nvx/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import {
  type CatalogueSource,
  familyOf,
  filterCatalogue,
  liveCatalogue,
  toCatalogueFromEndpoint,
  toCatalogueFromOpenRouter,
} from '../gateway/catalogue';
import type { ModelRegistry } from '../gateway/registry';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import type { SecretStore } from '../secrets';

export interface ModelRouteDeps {
  registry: ModelRegistry;
  secrets: SecretStore;
  catalogue?: CatalogueSource;
}

const DEFAULTS: Record<Exclude<ModelSource, 'openai-compatible'>, { ctx: number; max: number }> = {
  openrouter: { ctx: 128_000, max: 8_192 },
  anthropic: { ctx: 200_000, max: 32_000 },
  openai: { ctx: 200_000, max: 32_000 },
  google: { ctx: 1_000_000, max: 32_000 },
};

/** A registry id: lowercase prefix, then the model with any `/` as `__` (ids hold one slash). */
const idPart = (s: string) => s.replace(/\//g, '__').replace(/[^A-Za-z0-9._:-]/g, '-');

/** endpoint-<host>, e.g. endpoint-abc123-8000-proxy-runpod-net */
export function endpointProvider(baseUrl: string): string {
  const u = new URL(baseUrl);
  const slug = `${u.hostname}${u.port ? `-${u.port}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `endpoint-${slug || 'local'}`;
}

/** The secret name that holds an endpoint's key. */
export const endpointSecret = (provider: string) => `${provider.toUpperCase().replace(/-/g, '_')}_KEY`;

const conflict = (id: string) =>
  new AncileError({
    code: 'model.exists',
    title: `${id} is already in your models`,
    hint: 'Edit the one you have, or remove it first.',
    status: 409,
    errorClass: 'permanent',
  });

const notCustom = (name: string) =>
  new AncileError({
    code: 'model.not_custom',
    title: `${name} comes from models.yaml`,
    hint: 'Only models you added here can be edited or removed. You can still switch it on or off, and change its colour.',
    status: 409,
    errorClass: 'permanent',
  });

const needsUrl = () =>
  new AncileError({
    code: 'model.needs_base_url',
    title: 'An OpenAI-compatible model needs the server address',
    hint: 'Give its base URL, ending in /v1, for example https://abc123-8000.proxy.runpod.net/v1.',
    status: 400,
    errorClass: 'permanent',
  });

const notEndpoint = (name: string) =>
  new AncileError({
    code: 'model.not_endpoint',
    title: `${name} is not on your own server`,
    hint: 'Only OpenAI-compatible models have an address and a key to change here. Provider keys live in Settings → Models.',
    status: 409,
    errorClass: 'permanent',
  });

const secretMissing = (name: string) =>
  new AncileError({
    code: 'model.secret_missing',
    title: `No key called ${name} is stored`,
    hint: 'Check the name, or paste the key itself instead.',
    status: 422,
    errorClass: 'permanent',
  });

const restoreExpired = () =>
  new AncileError({
    code: 'model.restore_expired',
    title: 'Too late to undo that removal',
    hint: 'Add the model again from Admin → Models.',
    status: 410,
    errorClass: 'permanent',
  });

/** How long a removed model can be put back. */
export const RESTORE_WINDOW_MS = 10 * 60_000;

const RestoreModel = z.object({ id: z.string().min(1) }).strict();

const catalogueFailed = (source: string, err: unknown) =>
  new AncileError({
    code: 'model.catalogue_failed',
    title: `Could not list the models ${source} offers`,
    hint:
      source === 'OpenRouter'
        ? 'Check your connection, then try again. You can still add a model by its id.'
        : 'Check the address and key, and that the server is running. It must answer GET /models.',
    detail: err instanceof Error ? err.message : String(err),
    status: 502,
    errorClass: 'transient',
  });

export function registerModelRoutes(r: Hono<AppEnv>, deps: ModelRouteDeps): void {
  const { registry, secrets } = deps;
  const source = deps.catalogue ?? liveCatalogue;
  const addedIds = () => new Set(registry.all().map((m) => m.provider_model));
  /** Recently removed models, with their key, for undo. Never leaves Core. */
  const removed = new Map<string, { config: ModelConfig; key?: string; at: number }>();

  async function openRouterCatalogue(): Promise<CatalogueModel[]> {
    try {
      return toCatalogueFromOpenRouter(await source.openRouter(), addedIds());
    } catch (err) {
      throw catalogueFailed('OpenRouter', err);
    }
  }

  r.post('/models/catalogue', async (c) => {
    const req = await body(c, CatalogueRequest);
    let items: CatalogueModel[] = [];
    if (req.source === 'openrouter') items = await openRouterCatalogue();
    else if (req.source === 'openai-compatible') {
      if (!req.base_url) throw needsUrl();
      // A model already added for this endpoint lends its stored key.
      const provider = endpointProvider(req.base_url);
      const key = req.api_key ?? (await secrets.get(endpointSecret(provider)));
      try {
        items = toCatalogueFromEndpoint(await source.endpoint(req.base_url, key), addedIds());
      } catch (err) {
        throw catalogueFailed(new URL(req.base_url).host, err);
      }
    }
    // Direct providers: type the model id; their listings need a key and differ per provider.
    return c.json({ items: filterCatalogue(items, req.q).slice(0, 500) });
  });

  r.post('/models', async (c) => {
    const req = await body(c, AddModelRequest);
    let provider: string = req.source;
    let secret: string | undefined;
    let found: CatalogueModel | undefined;
    if (req.source === 'openai-compatible') {
      if (!req.base_url) throw needsUrl();
      provider = endpointProvider(req.base_url);
      if (req.api_key) {
        secret = endpointSecret(provider);
        await secrets.set(secret, req.api_key.trim());
      } else if ((await secrets.names()).includes(endpointSecret(provider))) {
        secret = endpointSecret(provider);
      }
    } else if (req.source === 'openrouter') {
      // Fill in price, context and capabilities from the catalogue when it answers.
      found = await openRouterCatalogue()
        .then((all) => all.find((m) => m.provider_model === req.provider_model))
        .catch(() => undefined);
    }
    const id = `${provider}/${idPart(req.provider_model)}`;
    if (registry.get(id)) throw conflict(id);
    const d = req.source === 'openai-compatible' ? { ctx: 32_000, max: 4_096 } : DEFAULTS[req.source];
    const config = ModelConfig.parse({
      id,
      provider,
      provider_model: req.provider_model,
      display_name: req.display_name ?? found?.display_name ?? req.provider_model,
      via: 'direct',
      family:
        req.family ??
        found?.family ??
        (req.source === 'openai-compatible' || req.source === 'openrouter'
          ? familyOf(req.provider_model)
          : req.source),
      context_window: req.context_window ?? found?.context_window ?? d.ctx,
      max_output: req.max_output ?? found?.max_output ?? d.max,
      capabilities: req.capabilities ?? found?.capabilities ?? ['tools'],
      price: req.price ?? found?.price ?? { input_per_mtok: 0, output_per_mtok: 0 },
      enabled: req.enabled,
      ...(req.base_url && { base_url: req.base_url }),
      ...(secret && { secret }),
      ...(req.hue && { hue: req.hue }),
    });
    await registry.saveCustom([...registry.custom(), config]);
    return c.json(
      registry.info().find((m) => m.id === id),
      201,
    );
  });

  r.patch('/models/:id{.+}', async (c) => {
    const id = c.req.param('id');
    const m = registry.get(id);
    if (!m) throw notFound('That model');
    const req = await body(c, PatchModelRequest);
    if (!registry.isCustom(id)) {
      const { enabled, hue, ...rest } = req;
      if (Object.keys(rest).length) throw notCustom(m.display_name);
      if (enabled !== undefined) await registry.setEnabled({ [id]: enabled });
      if (hue !== undefined) await registry.setHue(id, hue);
      return c.json(registry.info().find((x) => x.id === id));
    }
    const { api_key, secret: keyName, enabled, hue, ...fields } = req;
    const touchesEndpoint = api_key !== undefined || keyName !== undefined || fields.base_url !== undefined;
    if (touchesEndpoint && !m.base_url) throw notEndpoint(m.display_name);
    const before = m.secret;
    let secret = m.secret;
    if (keyName !== undefined) {
      if (keyName === null) secret = undefined;
      else if (!api_key && !(await secrets.names()).includes(keyName)) throw secretMissing(keyName);
      else secret = keyName;
    }
    if (api_key) {
      secret = secret ?? endpointSecret(m.provider);
      await secrets.set(secret, api_key.trim());
    }
    const { secret: _s, hue: _h, ...base } = m;
    const nextHue = hue === undefined ? m.hue : (hue ?? undefined);
    const next = ModelConfig.parse({
      ...base,
      ...fields,
      ...(enabled !== undefined && { enabled }),
      ...(secret && { secret }),
      ...(nextHue && { hue: nextHue }),
    });
    const rest = registry.custom().map((x) => (x.id === id ? next : x));
    await registry.saveCustom(rest);
    // The endpoint's own key goes when nothing uses it any more.
    if (
      before &&
      before !== secret &&
      before === endpointSecret(m.provider) &&
      !rest.some((x) => x.secret === before)
    )
      await secrets.delete(before);
    // A switch you flipped earlier would override the stored value.
    if (enabled !== undefined) await registry.setEnabled({ [id]: enabled });
    return c.json(registry.info().find((x) => x.id === id));
  });

  r.delete('/models/:id{.+}', async (c) => {
    const id = c.req.param('id');
    const m = registry.get(id);
    if (!m) throw notFound('That model');
    if (!registry.isCustom(id)) throw notCustom(m.display_name);
    const rest = registry.custom().filter((x) => x.id !== id);
    const dropKey = Boolean(m.secret && m.base_url && !rest.some((x) => x.secret === m.secret));
    const key = dropKey && m.secret ? await secrets.get(m.secret) : undefined;
    await registry.saveCustom(rest);
    // The endpoint's key goes too, unless another added model still uses it.
    if (dropKey && m.secret) await secrets.delete(m.secret);
    const now = Date.now();
    for (const [k, v] of removed) if (now - v.at > RESTORE_WINDOW_MS) removed.delete(k);
    removed.set(id, { config: m, ...(key && { key }), at: now });
    return c.body(null, 204);
  });

  /** Undo a removal: the model and its key come back as they were. */
  r.post('/models/restore', async (c) => {
    const { id } = await body(c, RestoreModel);
    const hit = removed.get(id);
    if (!hit || Date.now() - hit.at > RESTORE_WINDOW_MS) throw restoreExpired();
    if (registry.get(id)) throw conflict(id);
    if (hit.key && hit.config.secret) await secrets.set(hit.config.secret, hit.key);
    await registry.saveCustom([...registry.custom(), hit.config]);
    removed.delete(id);
    return c.json(
      registry.info().find((x) => x.id === id),
      201,
    );
  });
}
