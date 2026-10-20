/** Small formatters. Data renders in Martian Mono via [data-num]. */

import { loadedDemo } from './demoData';
import { queryClient } from './query';
import type { Hue, ModelView } from './types';

export const hueVar = (hue: Hue) => `var(--s-${hue})`;

/** Core's model list when it has answered, the demo list (once loaded, in demo mode) otherwise. */
export function modelById(id: string | null | undefined): ModelView | undefined {
  if (!id) return undefined;
  const live = queryClient.getQueryData<ModelView[]>(['models']);
  return live?.find((m) => m.id === id) ?? loadedDemo()?.models.find((m) => m.id === id);
}

/**
 * A model id as a name, for when the model list has no entry for it:
 * "google/gemini-3.5-flash-lite" reads "Gemini 3.5 Flash Lite", never the raw id.
 */
export function prettyModelId(id: string): string {
  const tail = (id.split('/').at(-1) ?? id).split('__').at(-1) ?? id;
  const words = tail
    .replace(/:latest$/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (/^[a-z]+$/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w));
  return words.join(' ') || id;
}

export function modelName(id: string | null | undefined): string {
  if (!id) return 'Unknown model';
  return modelById(id)?.name ?? prettyModelId(id);
}

export function usd(n: number, digits = 2): string {
  return `$${n.toFixed(digits)}`;
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function relative(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/**
 * A message's time as Settings → Reading → Times asks: "5 min ago", "14:05"
 * (with the date once it is not today), or nothing.
 */
export function stamp(
  iso: string,
  mode: 'relative' | 'absolute' | 'hidden',
  now = Date.now(),
): string | null {
  const t = new Date(iso);
  if (mode === 'hidden' || Number.isNaN(t.getTime())) return null;
  if (mode === 'relative') return relative(iso, now);
  const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (t.toDateString() === new Date(now).toDateString()) return time;
  return `${t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
}

export function percent(r: number): string {
  return `${Math.round(r * 100)}%`;
}
