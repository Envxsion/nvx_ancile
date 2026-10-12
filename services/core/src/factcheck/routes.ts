/**
 * ------------------------------------------------------------------
 *  Title    |  Trust routes: fact-check and explain
 *  Ref      |  DESIGN.md §4.1 (Trust), §10, §11.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  POST /messages/:id/factcheck  start (or join) a check
 *           |  GET  /messages/:id/factcheck  the latest result
 *           |  GET  /messages/:id/explain    why it said this
 *           |  GET  /messages/:id/citations  each citation, checked
 *           |       against its source now (current, changed, removed)
 *  How      |  A check is a durable run; the POST answers 202 with its
 *           |  run and the stream to follow. The GET answers 404 with
 *           |  factcheck.none until one has been started. A re-run's
 *           |  GET carries the check before it (previous), with a note
 *           |  when its sources were removed or changed since.
 * ------------------------------------------------------------------
 */

import { AncileError, type CitationStatus, type EffectiveScope } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { assembleExplain } from '../explain/assemble';
import type { SourceIntegrity } from '../knowledge/integrity';
import { notFound } from '../obs/errors';
import type { PermissionStore } from '../permissions/store';
import type { RunStore } from '../runs/engine';
import type { ThreadRepo } from '../threads/repo';
import { startFactcheck } from './handler';
import { previousView } from './history';
import { toView } from './pipeline';
import type { FactcheckStore } from './store';

export interface TrustRouteDeps {
  workspaceId: string;
  repo: ThreadRepo;
  runs: RunStore;
  store: FactcheckStore;
  worker: { kick(): void };
  permissions: Pick<PermissionStore, 'decisionsForRun'>;
  familyOf: (modelId: string | null) => string | null;
  modelName: (modelId: string | null) => string | null;
  /** The permission action a tool runs under, to pair calls with decisions. */
  actionOf: (tool: string) => string | undefined;
  /** The thread's effective scope, for the Why view's scope reasons (docs/scopes.md). */
  scopeOf?: (ref: { threadId: string }) => Promise<EffectiveScope>;
  /** What became of cited sources since (track G); without it, citations read "unknown". */
  integrity?: SourceIntegrity;
}

export function trustRoutes(deps: TrustRouteDeps) {
  const r = new Hono<AppEnv>();

  /** A message in this workspace, with its thread. */
  const load = async (id: string) => {
    const m = await deps.repo.getMessage(id);
    if (!m || m.deleted_at) throw notFound('That message');
    const t = await deps.repo.getThread(m.thread_id);
    if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That message');
    return { m, t };
  };

  r.post('/messages/:id/factcheck', async (c) => {
    const { m, t } = await load(c.req.param('id'));
    const { record } = await startFactcheck(deps, m.id, {
      workspaceId: t.workspace_id,
      notebookId: t.notebook_id,
    });
    const runId = record.run_id ?? '';
    return c.json(
      { factcheck_id: record.id, run_id: runId, stream_url: `/api/v1/runs/${runId}/stream` },
      202,
    );
  });

  r.get('/messages/:id/factcheck', async (c) => {
    const { m } = await load(c.req.param('id'));
    const f = await deps.store.latestFor(m.id);
    if (!f)
      throw new AncileError({
        code: 'factcheck.none',
        title: 'This answer has not been fact-checked',
        hint: 'Press F on the answer, or choose Fact-check under it.',
        status: 404,
        errorClass: 'permanent',
      });
    const prev = await deps.store.previousFor(m.id, f.id);
    return c.json(toView(f, prev ? await previousView(prev, deps.integrity) : null));
  });

  r.get('/messages/:id/citations', async (c) => {
    const { m } = await load(c.req.param('id'));
    const refs = m.parts.flatMap((p) => (p.type === 'citation_ref' ? [p] : []));
    const checks = deps.integrity
      ? await deps.integrity.check(
          refs.map((p) => ({ ref: p.chunk_id, source_id: p.source_id, text_sha256: p.text_sha256 ?? null })),
        )
      : [];
    const out: CitationStatus = {
      message_id: m.id,
      items: refs.map((p, i) => {
        const k = checks[i];
        return {
          marker: p.marker,
          chunk_id: p.chunk_id,
          source_id: p.source_id,
          state: k?.state ?? 'unknown',
          source_title: k?.source_title ?? p.source_title ?? null,
          removed_at: k?.removed_at ?? null,
          merged_into: k?.merged_into ?? null,
        };
      }),
    };
    return c.json(out);
  });

  r.get('/messages/:id/explain', async (c) => {
    const { m } = await load(c.req.param('id'));
    if (m.role !== 'assistant') throw notFound('That answer');
    const [decisions, f, scope] = await Promise.all([
      m.run_id ? deps.permissions.decisionsForRun(m.run_id) : Promise.resolve([]),
      deps.store.latestFor(m.id),
      deps.scopeOf?.({ threadId: m.thread_id }).catch(() => null) ?? Promise.resolve(null),
    ]);
    return c.json(
      assembleExplain({
        message: m,
        decisions,
        factcheck: f ? toView(f) : null,
        actionOf: deps.actionOf,
        modelName: deps.modelName,
        scope,
      }),
    );
  });

  return r;
}
