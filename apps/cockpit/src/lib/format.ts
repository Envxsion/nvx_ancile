/** Small formatters. Data renders in Martian Mono via [data-num]. */

import { models as demoModels } from '../fixtures/demo';
import { queryClient } from './query';
import type { Hue, ModelView } from './types';

export const hueVar = (hue: Hue) => `var(--s-${hue})`;

/** Core's model list when it has answered, the demo list otherwise. */
export function modelById(id: string | null | undefined): ModelView | undefined {
  if (!id) return undefined;
  const live = queryClient.getQueryData<ModelView[]>(['models']);
  return live?.find((m) => m.id === id) ?? demoModels.find((m) => m.id === id);
}

export function modelName(id: string | null | undefined): string {
  return modelById(id)?.name ?? id ?? 'Unknown model';
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

export function percent(r: number): string {
  return `${Math.round(r * 100)}%`;
}
