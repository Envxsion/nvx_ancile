/**
 * ------------------------------------------------------------------
 *  Title    |  Remote images, fetched only after a yes
 *  Ref      |  docs/images.md (Remote images)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  An image URL in an answer is a beacon: loading it tells
 *           |  that host you read the answer. The Cockpit never loads
 *           |  one by itself (its CSP allows only 'self', data: and
 *           |  blob: images). After the person allows a host for the
 *           |  notebook, Core fetches the image here and hands back
 *           |  the bytes.
 *  How      |  http(s) only, on the default ports; the host must
 *           |  resolve to a public address (no loopback, private, link
 *           |  local or metadata addresses, checked again on every
 *           |  redirect, at most three); no cookies or referrer; at
 *           |  most IMAGE_LIMITS.remoteBytes, read as a stream and cut
 *           |  off past it; the bytes must be PNG, JPEG, WebP or GIF.
 *  Note     |  The resolver is checked before the request; a host that
 *           |  changes its answer between the two (DNS rebinding) is a
 *           |  residual risk the address check narrows but cannot close.
 * ------------------------------------------------------------------
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AncileError, IMAGE_LIMITS, type ImageMime, sniffImage } from '@nvx/contracts';
import { ClassifiedError, guarded } from '@nvx/resilience';
import type { FetchLike } from './providers';

export type Resolve = (host: string) => Promise<string[]>;

const defaultResolve: Resolve = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Addresses a remote image may never come from. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1] as string);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

export const remoteBlocked = (detail: string) =>
  new AncileError({
    code: 'image.remote_blocked',
    title: 'That image address cannot be loaded.',
    hint: `${detail}. Only public http and https addresses are fetched.`,
    status: 400,
    errorClass: 'permanent',
  });

const remoteFailed = (host: string, detail: string) =>
  new AncileError({
    code: 'image.remote_failed',
    title: `The image from ${host} could not be loaded.`,
    hint: `${detail.slice(0, 200)}. Open the link in your browser instead, if you trust it.`,
    status: 502,
    errorClass: 'transient',
    retryable: true,
  });

/** Parse and check an image URL the way the proxy will fetch it. */
export function parseRemote(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw remoteBlocked('It is not a web address');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw remoteBlocked('It is not http or https');
  if (u.port && u.port !== '80' && u.port !== '443') throw remoteBlocked('It names an unusual port');
  if (u.username || u.password) throw remoteBlocked('It carries a user name or password');
  return u;
}

export async function fetchRemoteImage(
  raw: string,
  deps: { fetch?: FetchLike; resolve?: Resolve; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<{ bytes: Buffer; mime: ImageMime }> {
  const fetcher: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const resolve = deps.resolve ?? defaultResolve;
  const max = deps.maxBytes ?? IMAGE_LIMITS.remoteBytes;
  let url = parseRemote(raw);
  const host0 = url.hostname;

  return guarded(
    {
      key: `image-remote:${host0}`,
      timeoutMs: IMAGE_LIMITS.remoteTimeoutS * 1000,
      retry: { maxAttempts: 1 },
      ...(deps.signal && { signal: deps.signal }),
    },
    async (signal) => {
      for (let hop = 0; hop < 4; hop++) {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const addrs = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
        if (!addrs.length) throw remoteFailed(host0, 'Its address could not be found');
        if (addrs.some(isPrivateAddress))
          throw remoteBlocked('It points inside your network or at this computer');
        const res = await fetcher(url.toString(), {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
          signal,
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc || hop === 3) throw remoteFailed(host0, 'It redirected too often');
          url = parseRemote(new URL(loc, url).toString());
          continue;
        }
        if (!res.ok) throw new ClassifiedError('permanent', `HTTP ${res.status}`, { status: res.status });
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > max) throw tooBig(max);
        const chunks: Buffer[] = [];
        let total = 0;
        const reader = res.body?.getReader();
        if (!reader) throw remoteFailed(host0, 'It sent nothing');
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > max) {
            await reader.cancel().catch(() => undefined);
            throw tooBig(max);
          }
          chunks.push(Buffer.from(value));
        }
        const bytes = Buffer.concat(chunks);
        const mime = sniffImage(bytes);
        if (!mime)
          throw new AncileError({
            code: 'image.type_not_allowed',
            title: `What ${host0} sent is not an image NVX Ancile shows.`,
            hint: 'Only PNG, JPEG, WebP and GIF images load here.',
            status: 415,
            errorClass: 'permanent',
          });
        return { bytes, mime };
      }
      throw remoteFailed(host0, 'It redirected too often');
    },
  ).catch((err: unknown) => {
    if (err instanceof AncileError) throw err;
    throw remoteFailed(host0, (err as Error).message || 'No answer');
  });
}

const tooBig = (max: number) =>
  new AncileError({
    code: 'image.too_large',
    title: 'That image is too large to load here.',
    hint: `Remote images can be up to ${Math.round(max / 1024 / 1024)} MB. Open the link in your browser instead.`,
    status: 413,
    errorClass: 'permanent',
  });
