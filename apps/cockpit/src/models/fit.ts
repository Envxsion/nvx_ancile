/**
 * ------------------------------------------------------------------
 *  Title    |  Does the thread fit the model being picked
 *  Ref      |  ROADMAP.md HO1 · docs/prompt-caching.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Ask Core whether the whole thread fits a model before the
 *           |  switch, and keep the answer for the line that shows it
 *           |  (FitNotice.tsx).
 *  How      |  Picking a model asks GET /threads/:id/context-budget
 *           |  ?model= (chooseModel, lib/models.ts). If the answer says
 *           |  `fit.needs_summary`, the switch waits and this line shows
 *           |  under the composer notices with two words of choice:
 *           |  Switch and summarise (summarise for that window, then
 *           |  switch) or Pick another (stay where you are). A failed
 *           |  request means "no information": the switch goes ahead.
 *  Note     |  The full thread always stays; only what the model reads
 *           |  is shorter. Numbers are estimates.
 * ------------------------------------------------------------------
 */

import type { PathBudget } from '@nvx/contracts';
import { create } from 'zustand';
import { api } from '../lib/api';
import type { ModelView } from '../lib/types';
import { tokensShort } from './cacheState';

export interface FitAsk {
  threadId: string;
  model: ModelView;
  before: number;
  /** null: no summary can make it fit. */
  after: number | null;
  /** A summary that makes it fit already exists, so no model call is needed. */
  ready: boolean;
}

export const useFitAsk = create<{ ask: FitAsk | null }>()(() => ({ ask: null }));

/** True when the switch must wait for an answer (the line is showing); false: go ahead. */
export async function askFit(threadId: string, model: ModelView): Promise<boolean> {
  useFitAsk.setState({ ask: null });
  try {
    const b = await api.get<PathBudget>(
      `/threads/${threadId}/context-budget?model=${encodeURIComponent(model.id)}`,
    );
    const fit = b.fit;
    if (!fit?.needs_summary) return false;
    useFitAsk.setState({
      ask: { threadId, model, before: fit.tokens_now, after: fit.tokens_after, ready: fit.summary_ready },
    });
    return true;
  } catch {
    return false;
  }
}

export const fitLine = (a: Pick<FitAsk, 'before' | 'after' | 'model'>): string =>
  a.after === null
    ? `Too long for ${a.model.name}, even summarised. The full thread stays.`
    : `Needs summarising to fit (about ${tokensShort(a.before)} → ${tokensShort(a.after)}). The full thread stays.`;
