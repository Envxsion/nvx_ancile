/**
 * ------------------------------------------------------------------
 *  Title    |  Warm a model when it is picked
 *  Ref      |  ROADMAP LM1 · docs/models.md (Loaded now)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Picking an Ollama model starts loading it, so the
 *           |  first message after a pause does not wait on a cold
 *           |  start. A small dot beside the model says it is
 *           |  loading, and goes when it is in memory.
 *  How      |  warmOnPick(model) is called by chooseModel. It waits
 *           |  250 ms (rapid switching asks once, for the last
 *           |  pick), skips anything that is not an Ollama model on
 *           |  this setup, and skips entirely on battery. Core
 *           |  answers at once and loads in the background; the dot
 *           |  follows GET /local-models/loaded until the model is
 *           |  there, for at most two minutes.
 *  Note     |  The dot is calm ink, never the signal colour: loading
 *           |  is not live state. It is announced once, politely.
 * ------------------------------------------------------------------
 */

import type { LoadedModelsView, WarmResult } from '@nvx/contracts';
import { api } from '../lib/api';
import type { ModelView } from '../lib/types';
import { useWarming } from './warmStore';

export const DEBOUNCE_MS = 250;
export const POLL_MS = 2_000;
export const GIVE_UP_MS = 120_000;

/** Only Ollama on this setup is warmed: a cloud model or a GPU node has nothing to load here. */
export const warmable = (m: Pick<ModelView, 'id' | 'via' | 'offline'>) =>
  m.via === 'direct' && !m.offline && m.id.startsWith('ollama/');

interface BatteryManager {
  charging: boolean;
}

/** True when the computer says it is running on its battery. Unknown counts as plugged in. */
export async function onBattery(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
    if (!nav.getBattery) return false;
    return !(await nav.getBattery()).charging;
  } catch {
    return false;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

/** Start loading a model you just picked. Quiet when it cannot help; never throws. */
export function warmOnPick(model: Pick<ModelView, 'id' | 'via' | 'offline'>): void {
  clearTimeout(timer);
  const mine = ++generation;
  if (!warmable(model)) return;
  timer = setTimeout(() => void warm(model.id, mine), DEBOUNCE_MS);
}

async function warm(id: string, mine: number): Promise<void> {
  const stale = () => mine !== generation;
  try {
    // On battery nothing loads early: the model loads when the first message needs it.
    if (await onBattery()) return;
    if (stale()) return;
    const r = await api.post<WarmResult>('/local-models/warm', { model: id });
    if (r.state !== 'loading' || stale()) return;
    useWarming.getState().set(id, true);
    const until = Date.now() + GIVE_UP_MS;
    while (Date.now() < until) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      const v = await api.get<LoadedModelsView>('/local-models/loaded').catch(() => null);
      if (v?.state !== 'ok') break;
      if (v.items.some((i) => i.model_id === id)) break;
    }
  } catch {
    /* warming is a courtesy: a failure here changes nothing the person asked for */
  } finally {
    useWarming.getState().set(id, false);
  }
}
