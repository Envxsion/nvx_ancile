/**
 * ------------------------------------------------------------------
 *  Title    |  Images in threads
 *  Ref      |  docs/images.md · docs/scopes.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Everything a thread does with images, under its scope:
 *           |  attach one to a turn, make one with a provider, and
 *           |  load a remote one only after the person allowed its host.
 *  How      |  Attach and generate store through ImageStore. Generate
 *           |  runs only from the image_generate tool, after the
 *           |  permission gate allowed it (action image.generate, its
 *           |  resource the provider's URL, so the scope's network and
 *           |  data-leaves-machine rules apply); it checks the scope
 *           |  once more itself: where nothing may leave this machine,
 *           |  only a provider on this computer is used. Remote images
 *           |  are refused outright where nothing may leave.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type EffectiveScope,
  IMAGE_EMPTY_HINT,
  IMAGE_LIMITS,
  type ImageGenerateArgs,
  type ImageGenerateResult,
  type ImagePart,
  type ImageProviderConfig,
  type ImageProviderInfo,
  type ImageProviderKind,
  type ImageProviders,
  type ImageRecord,
  type ImageSource,
  type ImagesFile,
  type RemoteImageHosts,
} from '@nvx/contracts';
import { keepsLocal, type ScopeResolver } from '../scopes';
import type { ThreadRecord } from '../threads/repo';
import { DEFAULT_IMAGE_SECRET, endpointOf, type FetchLike, generateWith, providerInfo } from './providers';
import { fetchRemoteImage, parseRemote, type Resolve } from './remote';
import type { ImageStore } from './store';

export interface ImageServiceDeps {
  store: ImageStore;
  config: () => ImagesFile | null;
  secrets: { get(name: string): Promise<string | undefined> };
  scopes?: ScopeResolver;
  threads: { getThread(id: string): Promise<ThreadRecord | null | undefined> };
  fetch?: FetchLike;
  resolve?: Resolve;
  /** Telemetry: closed sets only (source, and the provider's kind for a generated image). */
  onImage?: (source: ImageSource, kind: ImageProviderKind | null) => void;
}

const noProvider = () =>
  new AncileError({
    code: 'image.no_provider',
    title: 'No image provider is set up.',
    hint: IMAGE_EMPTY_HINT,
    status: 409,
    errorClass: 'permanent',
  });

export const imageNotFound = () =>
  new AncileError({
    code: 'image.not_found',
    title: "That image doesn't exist.",
    hint: 'It may have been deleted with its thread. Attach or make it again.',
    status: 404,
    errorClass: 'permanent',
  });

const scopeRefusal = (scope: EffectiveScope, what: string) =>
  scope.private
    ? new AncileError({
        code: 'scope.private_notebook',
        title: `${what} would leave this machine, and this notebook is private.`,
        hint: 'Use an image provider on this computer (config/images.yaml, kind: local), or ask outside this notebook.',
        status: 403,
        errorClass: 'permanent',
      })
    : new AncileError({
        code: 'scope.data_stays_local',
        title: `${what} would leave this machine, and nothing may leave it here.`,
        hint: 'Use an image provider on this computer (config/images.yaml, kind: local), or change the scope.',
        status: 403,
        errorClass: 'permanent',
      });

export class ImageService {
  /** Providers known ready at the last look, so the tool's resource and its run pick the same one. */
  private ready = new Set<string>();

  constructor(private readonly deps: ImageServiceDeps) {}

  get store() {
    return this.deps.store;
  }

  private configured(): ImageProviderConfig[] {
    return (this.deps.config()?.providers ?? []).filter((p) => p.enabled);
  }

  async providers(): Promise<ImageProviders> {
    const names = new Set(
      this.configured()
        .map((p) => p.secret ?? DEFAULT_IMAGE_SECRET[p.api])
        .filter((s): s is string => !!s),
    );
    const have = new Set<string>();
    for (const n of names) if (await this.deps.secrets.get(n).catch(() => undefined)) have.add(n);
    const items: ImageProviderInfo[] = providerInfo(this.deps.config(), (n) => have.has(n));
    this.ready = new Set(items.filter((i) => i.ready).map((i) => i.id));
    const def = this.pick(undefined);
    return {
      items,
      default_id: def && this.ready.has(def.id) ? def.id : null,
      empty_hint: items.some((i) => i.ready) ? null : IMAGE_EMPTY_HINT,
    };
  }

  /** The provider a call uses: the one it names, else the configured default, else the first ready one. */
  pick(id: string | undefined): ImageProviderConfig | null {
    const all = this.configured();
    if (id) return all.find((p) => p.id === id) ?? null;
    const def = this.deps.config()?.default;
    return (
      (def ? all.find((p) => p.id === def) : undefined) ??
      all.find((p) => this.ready.has(p.id)) ??
      all[0] ??
      null
    );
  }

  /** The resource the permission gate checks: the provider's URL (http:…), so scopes see where it goes. */
  resource(args: unknown): string {
    const id =
      typeof (args as { provider?: unknown })?.provider === 'string'
        ? (args as { provider: string }).provider
        : undefined;
    const p = this.pick(id);
    return p ? `http:${endpointOf(p)}` : 'image:none';
  }

  /** What the tool's description lists, so a model can choose a provider by id. */
  describeProviders(): string {
    const all = this.configured();
    if (!all.length) return 'No image provider is set up yet.';
    return `Providers: ${all.map((p) => `${p.id} (${p.kind}${p.kind === 'local' ? ', stays on this computer' : ''})`).join(', ')}.`;
  }

  private async scopeOf(threadId: string | null): Promise<EffectiveScope | null> {
    if (!threadId || !this.deps.scopes) return null;
    const t = await this.deps.threads.getThread(threadId);
    return this.deps.scopes.effective({ threadId, notebookId: t?.notebook_id ?? null });
  }

  async generate(input: {
    threadId: string | null;
    args: ImageGenerateArgs;
    signal: AbortSignal;
  }): Promise<ImageGenerateResult> {
    if (!this.ready.size) await this.providers();
    const p = this.pick(input.args.provider);
    if (!p) {
      if (input.args.provider)
        throw new AncileError({
          code: 'image.provider_unknown',
          title: `There is no image provider called ${input.args.provider.slice(0, 80)}.`,
          hint: this.describeProviders(),
          status: 400,
          errorClass: 'permanent',
        });
      throw noProvider();
    }
    const scope = await this.scopeOf(input.threadId);
    // The gate checked the provider's URL; this is the floor again, by the provider's own kind.
    if (scope && keepsLocal(scope) && p.kind !== 'local')
      throw scopeRefusal(scope, `Making an image with ${p.display_name}`);
    const secret = p.secret ?? DEFAULT_IMAGE_SECRET[p.api];
    const apiKey = secret ? await this.deps.secrets.get(secret) : undefined;
    if (p.api !== 'a1111' && !apiKey) throw noProvider();
    const n = input.args.n ?? 1;
    const out = await generateWith(
      p,
      { prompt: input.args.prompt, ...(input.args.size && { size: input.args.size }), n },
      { apiKey, signal: input.signal, ...(this.deps.fetch && { fetch: this.deps.fetch }) },
    );
    const each = out.costUsd === null ? null : out.costUsd / out.images.length;
    const images: ImageGenerateResult['images'] = [];
    for (const bytes of out.images) {
      const r = await this.deps.store.put({
        threadId: input.threadId,
        bytes,
        source: 'generated',
        alt: input.args.prompt.slice(0, 500),
        prompt: input.args.prompt,
        model: p.model,
        provider: p.id,
        providerKind: p.kind,
        costUsd: each,
        what: `The image from ${p.display_name}`,
      });
      images.push({ id: r.id, url: r.url, width: r.width, height: r.height });
      this.deps.onImage?.('generated', p.kind);
    }
    return {
      images,
      prompt: input.args.prompt,
      model: p.model,
      provider: p.id,
      provider_kind: p.kind,
      cost_usd: out.costUsd,
    };
  }

  async attach(threadId: string, bytes: Buffer, alt?: string): Promise<ImageRecord> {
    const r = await this.deps.store.put({
      threadId,
      bytes,
      source: 'attached',
      alt: alt ?? '',
      what: 'That file',
    });
    this.deps.onImage?.('attached', null);
    return r;
  }

  /** The image parts of a turn: each id must be an image of this thread. */
  async partsFor(threadId: string, ids: string[]): Promise<ImagePart[]> {
    if (ids.length > IMAGE_LIMITS.perTurn)
      throw new AncileError({
        code: 'image.too_many',
        title: `Up to ${IMAGE_LIMITS.perTurn} images can go with one message.`,
        hint: 'Remove some, or send them over more than one message.',
        status: 400,
        errorClass: 'permanent',
      });
    const out: ImagePart[] = [];
    for (const id of [...new Set(ids)]) {
      const got = await this.deps.store.rows.get(id);
      if (!got || got.thread_id !== threadId) throw imageNotFound();
      out.push({
        type: 'image',
        url: `/api/v1/images/${got.id}`,
        mime: got.mime,
        image_id: got.id,
        ...(got.alt && { alt: got.alt }),
        ...(got.width !== null && { width: got.width }),
        ...(got.height !== null && { height: got.height }),
      });
    }
    return out;
  }

  /** An image's bytes as base64, for an engine that takes image input inline (Claude Code). */
  async bytes(id: string): Promise<{ mime: string; data: string } | null> {
    const got = await this.deps.store.get(id);
    return got ? { mime: got.record.mime, data: got.bytes.toString('base64') } : null;
  }

  /** Where a thread's remote-image choices are kept: its notebook, else the thread. */
  private async hostKey(thread: ThreadRecord) {
    return thread.notebook_id
      ? { key: thread.notebook_id, in: 'notebook' as const }
      : { key: `thread:${thread.id}`, in: 'thread' as const };
  }

  async hosts(thread: ThreadRecord): Promise<RemoteImageHosts> {
    const k = await this.hostKey(thread);
    const scope = await this.scopeOf(thread.id);
    return {
      remembered_in: k.in,
      hosts: await this.deps.store.rows.hosts(k.key),
      allowed: !(scope && keepsLocal(scope)),
    };
  }

  async allowHost(thread: ThreadRecord, host: string): Promise<RemoteImageHosts> {
    const scope = await this.scopeOf(thread.id);
    if (scope && keepsLocal(scope)) throw scopeRefusal(scope, 'Loading an image from another site');
    const k = await this.hostKey(thread);
    await this.deps.store.rows.allowHost(k.key, host.toLowerCase());
    return this.hosts(thread);
  }

  /** A remote image for this thread, only from a host the person allowed here. */
  async remote(thread: ThreadRecord, url: string, signal?: AbortSignal) {
    const u = parseRemote(url);
    const scope = await this.scopeOf(thread.id);
    if (scope && keepsLocal(scope)) throw scopeRefusal(scope, 'Loading an image from another site');
    const k = await this.hostKey(thread);
    const allowed = await this.deps.store.rows.hosts(k.key);
    if (!allowed.includes(u.hostname.toLowerCase()))
      throw new AncileError({
        code: 'image.remote_not_allowed',
        title: `Images from ${u.hostname} have not been allowed here.`,
        hint: 'Choose "Load image" on the image first. The choice is remembered for this notebook.',
        status: 403,
        errorClass: 'permanent',
      });
    const got = await fetchRemoteImage(u.toString(), {
      ...(this.deps.fetch && { fetch: this.deps.fetch }),
      ...(this.deps.resolve && { resolve: this.deps.resolve }),
      ...(signal && { signal }),
    });
    this.deps.onImage?.('model_output', null);
    return got;
  }
}
