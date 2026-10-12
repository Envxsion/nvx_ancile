/**
 * ------------------------------------------------------------------
 *  Title    |  Image providers
 *  Ref      |  docs/images.md (Generation) · config/images.yaml
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Make pictures from a prompt with the provider the
 *           |  person set up: OpenAI's images API, an OpenRouter image
 *           |  model, or an Automatic1111 / Forge server they run (on
 *           |  this computer or a GPU node). No model is bundled.
 *  How      |  One HTTP call per request, through @nvx/resilience
 *           |  (timeout, one attempt: a retried generation is paid
 *           |  twice). Each answer is decoded to bytes; the store then
 *           |  checks the real type and size.
 *  Note     |  TODO(phase-5): ComfyUI workflows; usage-based cost for
 *           |  OpenAI (it reports tokens, not dollars).
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  IMAGE_LIMITS,
  type ImageProviderConfig,
  type ImageProviderInfo,
  type ImageSize,
  type ImagesFile,
} from '@nvx/contracts';
import { ClassifiedError, classifyStatus, guarded } from '@nvx/resilience';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Generated {
  images: Buffer[];
  /** What the provider said it cost, else the configured estimate, else null. */
  costUsd: number | null;
}

export const DEFAULT_IMAGE_SECRET: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** The URL a call goes to: the permission check and the scope read it as its resource. */
export function endpointOf(p: ImageProviderConfig): string {
  const base = (p.base_url ?? BASE[p.api] ?? '').replace(/\/$/, '');
  if (p.api === 'openai') return `${base}/images/generations`;
  if (p.api === 'openrouter') return `${base}/chat/completions`;
  return `${base}/sdapi/v1/txt2img`;
}

export function providerInfo(
  file: ImagesFile | null,
  hasSecret: (name: string) => boolean,
): ImageProviderInfo[] {
  return (file?.providers ?? [])
    .filter((p) => p.enabled)
    .map((p) => {
      const secret = p.secret ?? DEFAULT_IMAGE_SECRET[p.api];
      let reason: string | null = null;
      if (p.api === 'a1111' && !p.base_url) reason = 'Set its base_url in config/images.yaml';
      else if (p.api !== 'a1111' && secret && !hasSecret(secret))
        reason = `Add ${secret} in Settings → API keys`;
      return {
        id: p.id,
        display_name: p.display_name,
        api: p.api,
        kind: p.kind,
        model: p.model,
        ready: reason === null,
        reason,
      };
    });
}

const sizeOf = (s: ImageSize | undefined) => {
  const [w, h] = (s ?? '1024x1024').split('x').map(Number);
  return { width: w ?? 1024, height: h ?? 1024 };
};

const fromDataUrl = (u: string): Buffer | null => {
  const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(u);
  return m ? Buffer.from(m[1] as string, 'base64') : null;
};

export function providerFailed(p: ImageProviderConfig, detail: string, status = 502): AncileError {
  return new AncileError({
    code: 'image.provider_failed',
    title: `${p.display_name} did not make the image.`,
    hint: `It said: ${detail.slice(0, 300)}. Check its key or address, or try another provider.`,
    status,
    errorClass: status === 429 || status >= 500 ? 'transient' : 'permanent',
    retryable: status === 429 || status >= 500,
  });
}

export async function generateWith(
  p: ImageProviderConfig,
  req: { prompt: string; size?: ImageSize; n: number },
  deps: { apiKey: string | undefined; fetch?: FetchLike; signal: AbortSignal },
): Promise<Generated> {
  const fetcher: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const url = endpointOf(p);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (deps.apiKey) headers.authorization = `Bearer ${deps.apiKey}`;
  const { width, height } = sizeOf(req.size);
  const body =
    p.api === 'openai'
      ? { model: p.model, prompt: req.prompt, n: req.n, size: req.size ?? '1024x1024' }
      : p.api === 'openrouter'
        ? {
            model: p.model,
            messages: [{ role: 'user', content: req.prompt }],
            modalities: ['image', 'text'],
            usage: { include: true },
          }
        : { prompt: req.prompt, width, height, batch_size: req.n, steps: 25 };

  const json = await guarded(
    {
      key: `image:${p.id}`,
      timeoutMs: IMAGE_LIMITS.generateTimeoutS * 1000,
      retry: { maxAttempts: 1 },
      signal: deps.signal,
    },
    async (signal) => {
      const res = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ClassifiedError(
          classifyStatus(res.status, text),
          text.slice(0, 300) || `HTTP ${res.status}`,
          {
            status: res.status,
          },
        );
      }
      return (await res.json()) as Record<string, unknown>;
    },
  ).catch((err: unknown) => {
    const status = (err as { status?: number }).status;
    throw providerFailed(p, (err as Error).message || 'no answer', status ?? 502);
  });

  const images: Buffer[] = [];
  let costUsd: number | null = null;
  if (p.api === 'openai') {
    for (const d of (json.data as { b64_json?: string }[] | undefined) ?? [])
      if (d.b64_json) images.push(Buffer.from(d.b64_json, 'base64'));
  } else if (p.api === 'openrouter') {
    const choices = (json.choices as { message?: { images?: { image_url?: { url?: string } }[] } }[]) ?? [];
    for (const c of choices)
      for (const img of c.message?.images ?? []) {
        const b = img.image_url?.url ? fromDataUrl(img.image_url.url) : null;
        if (b) images.push(b);
      }
    const cost = (json.usage as { cost?: unknown } | undefined)?.cost;
    if (typeof cost === 'number' && Number.isFinite(cost)) costUsd = cost;
  } else {
    for (const s of (json.images as string[] | undefined) ?? [])
      if (typeof s === 'string') images.push(Buffer.from(s.replace(/^data:[^,]*,/, ''), 'base64'));
    // Your own computer costs nothing per image; a node's time is counted by Compute.
    costUsd = p.kind === 'local' ? 0 : null;
  }
  if (!images.length) throw providerFailed(p, 'the answer held no image');
  if (costUsd === null && p.price_usd !== undefined) costUsd = p.price_usd * images.length;
  return { images: images.slice(0, req.n), costUsd };
}
