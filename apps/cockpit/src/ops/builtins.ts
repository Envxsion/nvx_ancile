/**
 * ------------------------------------------------------------------
 *  Title    |  Built-in switches, in the Cockpit
 *  Ref      |  services/core/src/automations/settings.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The built-in automations the Cockpit itself serves read
 *           |  their switch and settings here (Save drafts).
 *  How      |  The automations list, shared with Admin → Automations
 *           |  and cached; until it answers (or offline) each job does
 *           |  what it did before it had a switch.
 * ------------------------------------------------------------------
 */

import type { AutomationView } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export const AUTOMATIONS_KEY = ['ops', 'automations'] as const;

export function useAutomations(enabled = true) {
  return useQuery({
    queryKey: AUTOMATIONS_KEY,
    enabled,
    staleTime: 60_000,
    queryFn: () => api.get<{ items: AutomationView[] }>('/automations').then((r) => r.items),
  });
}

/** Save drafts: whether Core keeps a copy, and after how long a pause. */
export function draftAutosave(list: AutomationView[] | undefined): { on: boolean; afterMs: number } {
  const v = list?.find((a) => a.id === 'draft_autosave');
  if (!v) return { on: true, afterMs: 3_000 };
  const s = v.config.server_every_s;
  const secs = typeof s === 'number' && Number.isInteger(s) && s >= 1 && s <= 60 ? s : 3;
  return { on: v.enabled, afterMs: secs * 1000 };
}
