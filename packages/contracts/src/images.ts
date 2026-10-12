/**
 * ------------------------------------------------------------------
 *  Title    |  Images: storage, vision input, generation, remote consent
 *  Ref      |  docs/images.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes Core and the Cockpit share for images in a
 *           |  thread: the stored record, the image_generate tool's
 *           |  arguments and result, the provider list, and the
 *           |  per-notebook list of hosts whose images may be loaded.
 *  How      |  Images are content-addressed (sha256) in the workspace
 *           |  data folder and indexed in core.images. A message names
 *           |  one by id in an ImagePart (`image_id`) and by its URL.
 *  Note     |  Remote images in answers are never fetched without a
 *           |  yes: a remote image is a beacon. After a yes, Core
 *           |  fetches it through /images/remote within IMAGE_LIMITS.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** Raster types only. SVG can carry script, so it is never stored or proxied as an image. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const ImageMime = z.enum(IMAGE_MIMES);
export type ImageMime = z.infer<typeof ImageMime>;

export const IMAGE_LIMITS = {
  /** One stored image (attached or generated). */
  bytes: 20 * 1024 * 1024,
  /** One remote image fetched through the proxy. */
  remoteBytes: 10 * 1024 * 1024,
  /** Images attached to one turn. */
  perTurn: 8,
  /** Seconds the proxy and the providers wait. */
  remoteTimeoutS: 15,
  generateTimeoutS: 180,
  /** A prompt for image_generate. */
  promptChars: 4_000,
  /** Images one image_generate call may ask for. */
  perCall: 4,
} as const;

/** Telemetry and storage: where an image came from (closed set). */
export const ImageSource = z.enum(['generated', 'attached', 'model_output']);
export type ImageSource = z.infer<typeof ImageSource>;

/** Telemetry and storage: where an image provider runs (closed set). */
export const ImageProviderKind = z.enum(['cloud', 'local', 'node']);
export type ImageProviderKind = z.infer<typeof ImageProviderKind>;

/** The URL Core serves a stored image at, relative to the Cockpit's origin. */
export const imageUrl = (id: string): string => `/api/v1/images/${encodeURIComponent(id)}`;
export const IMAGE_ID = /^img_[A-Za-z0-9]{1,40}$/;
/** The stored image a URL names, or null. */
export function imageIdOf(url: string): string | null {
  const m = /^\/api\/v1\/images\/(img_[A-Za-z0-9]{1,40})$/.exec(url);
  return m ? (m[1] as string) : null;
}

/** What the bytes are, from their first bytes alone (never from a header or a name). */
export function sniffImage(b: Uint8Array): ImageMime | null {
  const at = (i: number) => b[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return 'image/webp';
  return null;
}

export const ImageRecord = z.object({
  id: z.string(),
  thread_id: z.string().nullable(),
  sha256: z.string(),
  mime: ImageMime,
  bytes: z.number().int().nonnegative(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  source: ImageSource,
  alt: z.string(),
  /** Generated images: what was asked for, by which model on which provider, and what it cost. */
  prompt: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  provider_kind: ImageProviderKind.nullable(),
  cost_usd: z.number().nullable(),
  url: z.string(),
  created_at: z.string(),
});
export type ImageRecord = z.infer<typeof ImageRecord>;

/**
 * POST /threads/:id/images: multipart/form-data with the image as `file` (any image/* type,
 * up to IMAGE_LIMITS.bytes), `?alt=` optional. Answers the ImageRecord.
 */

// ---- image_generate ----

export const ImageSize = z.enum(['1024x1024', '1024x1536', '1536x1024', '512x512']);
export type ImageSize = z.infer<typeof ImageSize>;

export const ImageGenerateArgs = z
  .object({
    prompt: z.string().min(1).max(IMAGE_LIMITS.promptChars),
    size: ImageSize.optional(),
    n: z.number().int().min(1).max(IMAGE_LIMITS.perCall).optional(),
    /** A provider id from the list in the tool's description; absent: the default. */
    provider: z.string().max(80).optional(),
  })
  .strict();
export type ImageGenerateArgs = z.infer<typeof ImageGenerateArgs>;

export const ImageGenerateResult = z.object({
  images: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
    }),
  ),
  prompt: z.string(),
  model: z.string(),
  provider: z.string(),
  provider_kind: ImageProviderKind,
  cost_usd: z.number().nullable(),
});
export type ImageGenerateResult = z.infer<typeof ImageGenerateResult>;

/** config/images.yaml: the image providers image_generate may use. */
export const ImageProviderConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/),
  display_name: z.string().min(1).max(80),
  /**
   * The protocol: OpenAI's images API, OpenRouter's image models (chat
   * completions with image output), or the Automatic1111 / Forge txt2img API.
   */
  api: z.enum(['openai', 'openrouter', 'a1111']),
  /** Where it runs: a cloud service, this computer, or a GPU node you run (RunPod, a LAN machine). */
  kind: ImageProviderKind,
  model: z.string().min(1).max(200),
  base_url: z.string().url().optional(),
  /** Name of the stored key; cloud APIs default to OPENAI_API_KEY or OPENROUTER_API_KEY. */
  secret: z.string().max(80).optional(),
  /** Estimated price of one image, when the API does not say. */
  price_usd: z.number().nonnegative().optional(),
  enabled: z.boolean().default(true),
});
export type ImageProviderConfig = z.infer<typeof ImageProviderConfig>;

export const ImagesFile = z.object({
  version: z.literal(1),
  /** The provider used when a call names none; absent: the first ready one. */
  default: z.string().optional(),
  providers: z.array(ImageProviderConfig).default([]),
});
export type ImagesFile = z.infer<typeof ImagesFile>;

export const ImageProviderInfo = z.object({
  id: z.string(),
  display_name: z.string(),
  api: ImageProviderConfig.shape.api,
  kind: ImageProviderKind,
  model: z.string(),
  ready: z.boolean(),
  /** Why not, in words. */
  reason: z.string().nullable(),
});
export type ImageProviderInfo = z.infer<typeof ImageProviderInfo>;

/** GET /images/providers */
export const ImageProviders = z.object({
  items: z.array(ImageProviderInfo),
  default_id: z.string().nullable(),
  /** One line saying what to set up, when nothing is ready. */
  empty_hint: z.string().nullable(),
});
export type ImageProviders = z.infer<typeof ImageProviders>;

export const IMAGE_EMPTY_HINT =
  'No image provider is set up: add an OpenAI or OpenRouter key in Settings → API keys, or a local Automatic1111 or Forge address in config/images.yaml.';

// ---- remote images ----

/** GET/POST /threads/:id/image-hosts: hosts whose images may load here, remembered per notebook. */
export const RemoteImageHosts = z.object({
  /** Where the choice is kept: the thread's notebook, or the thread itself when it has none. */
  remembered_in: z.enum(['notebook', 'thread']),
  hosts: z.array(z.string()),
  /** False where nothing may leave this machine: remote images never load there. */
  allowed: z.boolean(),
});
export type RemoteImageHosts = z.infer<typeof RemoteImageHosts>;

export const AllowImageHostRequest = z
  .object({
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.-]+$/),
  })
  .strict();
export type AllowImageHostRequest = z.infer<typeof AllowImageHostRequest>;
