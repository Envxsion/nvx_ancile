/**
 * ------------------------------------------------------------------
 *  Title    |  Desktop app: what the Cockpit asks Core
 *  Ref      |  ROADMAP rows DK1, NT1, DL1, UP1 · contracts/desktop.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit has no native access. Inside the desktop
 *           |  app everything native (closing to the tray, updates,
 *           |  quitting) is a request to Core, which the desktop
 *           |  shell picks up; this is that one conversation, and the
 *           |  words the screens use for it.
 *  How      |  Plain queries and one command sender. Nothing here
 *           |  does anything in a browser tab: every hook is off
 *           |  unless the shell set window.__NVX_DESKTOP__.
 *  Note     |  A link to a thread is ancile://thread/<id> in the
 *           |  desktop app (it opens in the app, whatever port Core
 *           |  has) and the page address in a browser.
 * ------------------------------------------------------------------
 */

import type { CloseBehaviour, DesktopCommandKind, DesktopState } from '@nvx/contracts';
import * as license from '@nvx/contracts/license';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { isDesktop } from '../lib/runtime';

export const desktopKeys = {
  state: ['desktop-state'] as const,
  offer: ['update-offer'] as const,
  channel: ['update-channel'] as const,
};

export function useDesktopState() {
  return useQuery({
    queryKey: desktopKeys.state,
    queryFn: () => api.get<DesktopState>('/system/desktop'),
    enabled: isDesktop(),
    staleTime: 10_000,
    // Quickly while services are still warming up, slowly after.
    refetchInterval: (q) => (q.state.data?.warming?.length ? 3000 : 60_000),
  });
}

export function useUpdateOffer() {
  return useQuery({
    queryKey: desktopKeys.offer,
    queryFn: () => api.get('/system/update-offer', license.UpdateOffer),
    enabled: isDesktop(),
    // Quickly while something is moving, slowly while nothing is.
    refetchInterval: (q) => {
      const state = q.state.data?.offer?.state;
      return state === 'downloading' || state === 'waiting' || state === 'installing' ? 1500 : 30_000;
    },
  });
}

export function useUpdateChannel() {
  return useQuery({
    queryKey: desktopKeys.channel,
    queryFn: () => api.get<{ channel: 'stable' | 'beta'; beta_available?: boolean }>('/system/updates'),
    enabled: isDesktop(),
    staleTime: 30_000,
  });
}

export async function setClose(close: CloseBehaviour): Promise<void> {
  const next = await api.put<DesktopState>('/system/desktop', { close });
  queryClient.setQueryData(desktopKeys.state, next);
}

export async function setChannel(channel: 'stable' | 'beta'): Promise<void> {
  await api.put('/system/updates', { channel });
  await queryClient.invalidateQueries({ queryKey: desktopKeys.channel });
}

/** Ask the desktop shell, through Core, to do something to the app itself. */
export async function command(kind: DesktopCommandKind): Promise<void> {
  await api.post('/system/desktop/command', { command: kind });
  // The shell picks it up within a couple of seconds: look again soon.
  for (const ms of [1500, 4000])
    setTimeout(() => void queryClient.invalidateQueries({ queryKey: desktopKeys.offer }), ms);
}

/** ancile://thread/<id> in the desktop app; the page address in a browser. */
export function threadLink(
  id: string,
  origin = typeof location === 'undefined' ? '' : location.origin,
): string {
  return isDesktop() ? `ancile://thread/${encodeURIComponent(id)}` : `${origin}/t/${id}`;
}

/* ---- words ----------------------------------------------------------------- */

export const CLOSE_WORDS: Record<CloseBehaviour, string> = {
  ask: 'Ask me',
  tray: 'Keep running in the tray',
  quit: 'Quit',
};

/** "48.2 MB", "1.3 GB"; empty for an unknown size. */
export function sizeText(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

type Offer = NonNullable<license.UpdateOffer['offer']>;

/** One line for the card and the pill. */
export function offerLine(o: Offer): string {
  const size = sizeText(o.size_bytes);
  switch (o.state) {
    case 'downloading':
      return `Downloading ${o.version}${o.progress != null ? `, ${Math.round(o.progress * 100)}%` : ''}`;
    case 'ready':
      return o.when === 'quit'
        ? `${o.version} is downloaded and installs when you quit`
        : o.when === 'tonight'
          ? `${o.version} is downloaded and installs tonight`
          : `${o.version} is downloaded`;
    case 'waiting':
      return `${o.version} installs when your runs have finished`;
    case 'installing':
      return `Installing ${o.version}`;
    case 'failed':
      return o.error ?? `${o.version} did not download`;
    default:
      return o.when === 'tonight'
        ? `${o.version} installs tonight`
        : o.when === 'quit'
          ? `${o.version} installs when you quit`
          : `${o.version} is ready${size ? ` (${size})` : ''}`;
  }
}

/** The time Tonight means, in this computer's words ("Tuesday 03:00"). */
export function tonightText(iso: string | null | undefined): string {
  if (!iso) return 'tonight';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'tonight';
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Is an update worth a pill in the status bar? */
export function pillShows(o: license.UpdateOffer['offer'] | undefined): o is Offer {
  return !!o;
}
