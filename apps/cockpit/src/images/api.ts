/**
 * ------------------------------------------------------------------
 *  Title    |  Images: the Cockpit's side of Core's image routes
 *  Ref      |  docs/images.md · contracts images.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Attach an image to the next turn, read the providers
 *           |  (or the one line saying what to set up), and the hosts
 *           |  whose remote images may load in a thread's notebook.
 *  How      |  TanStack Query for reads; attach is a multipart POST.
 *           |  A remote image is loaded through Core's proxy only, so
 *           |  the page's CSP never needs to allow another site.
 * ------------------------------------------------------------------
 */

import {
  CLIENT_ID_HEADER,
  type ImageProviders,
  type ImageRecord,
  type RemoteImageHosts,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { API_BASE, api, WINDOW_ID } from '../lib/api';
import { queryClient } from '../lib/query';

export const imageKeys = {
  providers: ['images', 'providers'] as const,
  hosts: (threadId: string) => ['images', 'hosts', threadId] as const,
};

export function useImageProviders(enabled = true) {
  return useQuery({
    queryKey: imageKeys.providers,
    queryFn: () => api.get<ImageProviders>('/images/providers'),
    enabled,
    staleTime: 60_000,
  });
}

export function useImageHosts(threadId: string | null) {
  return useQuery({
    queryKey: imageKeys.hosts(threadId ?? 'none'),
    queryFn: () => api.get<RemoteImageHosts>(`/threads/${threadId}/image-hosts`),
    enabled: !!threadId && threadId.startsWith('thr_'),
    staleTime: 30_000,
  });
}

export async function allowImageHost(threadId: string, host: string): Promise<RemoteImageHosts> {
  const r = await api.post<RemoteImageHosts>(`/threads/${threadId}/image-hosts`, { host });
  queryClient.setQueryData(imageKeys.hosts(threadId), r);
  return r;
}

/** The proxied address of a remote image, for a host already allowed. */
export const remoteImageSrc = (threadId: string, url: string) =>
  `${API_BASE}/threads/${encodeURIComponent(threadId)}/images/remote?url=${encodeURIComponent(url)}`;

/** Upload one image for the next turn. Rejects with Core's { title, hint } on a refusal. */
export async function attachImage(threadId: string, file: File): Promise<ImageRecord> {
  const form = new FormData();
  form.append('file', file, file.name || 'pasted image');
  const res = await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}/images`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', [CLIENT_ID_HEADER]: WINDOW_ID },
    body: form,
  });
  const body = (await res.json().catch(() => null)) as
    | ImageRecord
    | { error?: { title?: string; hint?: string } }
    | null;
  if (!res.ok) {
    const err = (body as { error?: { title?: string; hint?: string } } | null)?.error;
    throw Object.assign(new Error(err?.title ?? 'That image could not be attached.'), {
      hint: err?.hint ?? 'Check the file opens on this computer, then try again.',
    });
  }
  return body as ImageRecord;
}

/** Is this an address the page may load directly: this origin, data: or blob:? */
export function isLocalSrc(src: string): boolean {
  if (src.startsWith('data:image/') || src.startsWith('blob:')) return true;
  if (src.startsWith('/') && !src.startsWith('//')) return true;
  try {
    return new URL(src).origin === window.location.origin;
  } catch {
    return false;
  }
}
