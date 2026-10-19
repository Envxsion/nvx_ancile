/**
 * ------------------------------------------------------------------
 *  Title    |  Model watch: reading and acting on model updates
 *  Ref      |  roadmap MD4, MD5 · guard rail GR16 · packages/contracts/src/modelwatch.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the daily check found (new models, a line moving
 *           |  to a newer model, prices, limits, abilities, models
 *           |  retired), and every action on it: check now, follow
 *           |  latest, use a model, go back, add a model, mark read.
 *  How      |  GET /models/watch is one query. Each action calls its
 *           |  endpoint, then refreshes the model list and this report.
 *           |  A failure is a notice with Core's title and hint.
 *           |  useModelChangeToasts says, once per change per session,
 *           |  when a line moved by itself or a model was retired.
 *  Note     |  Demo mode shows a fixed report and calls nothing. Line
 *           |  ids are `<provider>/<line>`: the path takes the two
 *           |  halves apart on the first slash.
 * ------------------------------------------------------------------
 */

import type { ModelChange, ModelLine, ModelWatchReport, WatchedModel } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { useDemoData } from '../lib/demoData';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';

export const watchKey = ['model-watch'] as const;

/** Refresh everything a model change can touch: the lists, the pickers and this report. */
export function refreshModels(): void {
  void queryClient.invalidateQueries({ queryKey: keys.models });
  void queryClient.invalidateQueries({ queryKey: ['flows', 'models'] });
  void queryClient.invalidateQueries({ queryKey: watchKey });
}

export function useModelWatch() {
  const demo = useUi((s) => s.demo);
  const sample = useDemoData(demo);
  const q = useQuery({
    queryKey: watchKey,
    staleTime: 30_000,
    retry: false,
    enabled: !demo,
    queryFn: () => api.get<ModelWatchReport>('/models/watch'),
  });
  return demo ? { ...q, data: sample?.demoWatch, isPending: !sample, isError: false, error: null } : q;
}

const failed = (error: unknown) =>
  notify({
    level: 'error',
    title: error instanceof ApiCallError ? error.body.error.title : 'NVX Ancile did not answer',
    body: error instanceof ApiCallError ? error.body.error.hint : 'Check that it is running, then try again.',
  });

/** `<provider>/<line>` to the two path halves. */
const linePath = (lineId: string) => {
  const i = lineId.indexOf('/');
  return `${encodeURIComponent(lineId.slice(0, i))}/${encodeURIComponent(lineId.slice(i + 1))}`;
};

async function act(call: () => Promise<unknown>): Promise<boolean> {
  if (useUi.getState().demo) return true;
  try {
    await call();
    refreshModels();
    return true;
  } catch (error) {
    failed(error);
    return false;
  }
}

/** Check every provider now, or one. At most once a minute each: Core says when it is too soon. */
export const checkNow = (provider?: string) =>
  act(() => api.post('/models/watch/check', provider ? { provider } : {}));

export const setFollow = (lineId: string, follow: boolean) =>
  act(() => api.put(`/models/lines/${linePath(lineId)}`, { follow }));

/** Move a line to a model now. */
export const moveLineTo = (lineId: string, modelId: string) =>
  act(() => api.put(`/models/lines/${linePath(lineId)}`, { use: modelId }));

export const goBack = (lineId: string) => act(() => api.post(`/models/lines/${linePath(lineId)}/back`, {}));

export const setOpenRouterPrices = (on: boolean) =>
  act(() => api.put('/models/watch/settings', { openrouter_prices: on }));

export const addModel = (modelId: string) => act(() => api.post('/models/watch/add', { model_id: modelId }));

/** Reading is not worth an error notice: the changes stay unread and show again. */
export async function markSeen(ids: string[]): Promise<void> {
  if (ids.length === 0 || useUi.getState().demo) return;
  try {
    await api.post('/models/watch/seen', { ids });
    refreshModels();
  } catch {
    /* they stay unread */
  }
}

/* ---- Reading a change ------------------------------------------------------ */

export const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A model's name by id: the report first, then the id itself. */
export function nameOf(report: ModelWatchReport, id: string | null | undefined): string {
  if (!id) return 'a newer model';
  return report.models.find((m) => m.id === id)?.display_name ?? id.slice(id.indexOf('/') + 1);
}

export const lineOf = (report: ModelWatchReport, change: ModelChange): ModelLine | undefined =>
  report.lines.find((l) => l.id === change.line_id);

export const watchedOf = (report: ModelWatchReport, id: string): WatchedModel | undefined =>
  report.models.find((m) => m.id === id);

/* ---- Toasts: said once per change per session -------------------------------- */

const toasted = new Set<string>();

/** For tests. */
export const forgetToasted = () => toasted.clear();

/** The words for a line that moved by itself, or a model retired. Null when it is not worth a toast. */
export function movedWords(report: ModelWatchReport, c: ModelChange): string | null {
  const line = lineOf(report, c);
  const lineName = line?.name ?? 'this line';
  if (c.kind === 'line_moved' && (c.reason === 'followed' || c.reason === 'retired')) {
    const now = nameOf(report, idOf(c.after) ?? line?.current_id);
    return `${now} now answers where you chose ${lineName}.`;
  }
  if (c.kind === 'retired') {
    const answers = line?.current_id ? nameOf(report, line.current_id) : null;
    return `${nameOf(report, c.model_id)} is retired.${answers ? ` ${answers} answers instead.` : ''}`;
  }
  return null;
}

/** Mounted once, in the shell: toasts new moves and retirements, each once per session. */
export function useModelChangeToasts(): void {
  const demo = useUi((s) => s.demo);
  const report = useModelWatch().data;
  useEffect(() => {
    if (demo || !report) return;
    for (const c of report.changes) {
      if (c.seen || toasted.has(c.id)) continue;
      const title = movedWords(report, c);
      if (!title) continue;
      toasted.add(c.id);
      const line = c.line_id && c.kind === 'line_moved' ? c.line_id : null;
      notify({
        id: `model-change-${c.id}`,
        level: 'info',
        title,
        ...(line && { action: { label: 'Go back', run: () => void goBack(line) } }),
      });
    }
  }, [demo, report]);
}
