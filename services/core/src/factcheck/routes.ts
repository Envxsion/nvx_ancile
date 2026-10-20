/**
 * ------------------------------------------------------------------
 *  Title    |  Trust routes: fact-check and explain
 *  Ref      |  DESIGN.md §4.1 (Trust), §10, §11.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  POST /messages/:id/factcheck  start (or join) a check
 *           |  POST /messages/:id/selection-checks  check a highlighted
 *           |       claim and answer with its card (FC3)
 *           |  GET  /messages/:id/selection-checks  the cards made here
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

import {
  AncileError,
  type CitationStatus,
  type EffectiveScope,
  StartFactcheckRequest,
  StartSelectionCheckRequest,
  type StartSelectionCheckResponse,
} from '@nvx/contracts';
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
import { type CheckInput, checksOf } from './selection';
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
  /** A memory entry as words, for the "Used:" line of the Why view (memory/service.ts entryUsed). */
  memoryEntry?: (
    path: string,
    key: string,
  ) => { path: string; key: string; text: string; commit: string } | null;
  /** What became of cited sources since (track G); without it, citations read "unknown". */
  integrity?: SourceIntegrity;
  /** May this check use the web? Decided from the notebook's setting, this check's allow and the scope (FC4). */
  webFor?: (a: {
    threadId: string;
    notebookId: string | null;
    requested: boolean | undefined;
  }) => Promise<{ use: boolean; note: string | null }>;
  /** Refuses a check with no judge from another family that the scope allows (GR24), before it starts. */
  preflight?: (a: { threadId: string; generatorFamily: string | null }) => Promise<void>;
  /** Checks a highlighted claim and records the card on its message (FC3). */
  selection?: {
    run(input: CheckInput, signal: AbortSignal): Promise<StartSelectionCheckResponse>;
  };
}

/** The memory entries an answer was given, as words; an entry edited or removed since is left out. */
export function memoryUsedOf(provenance: unknown, lookup: TrustRouteDeps['memoryEntry']) {
  if (!lookup) return [];
  const files = (provenance as { memory?: { files?: { path?: unknown; entries?: unknown }[] } } | null)
    ?.memory?.files;
  if (!Array.isArray(files)) return [];
  const out: NonNullable<ReturnType<NonNullable<TrustRouteDeps['memoryEntry']>>>[] = [];
  for (const f of files)
    if (typeof f.path === 'string' && Array.isArray(f.entries))
      for (const k of f.entries)
        if (typeof k === 'string') {
          const e = lookup(f.path, k);
          if (e) out.push(e);
        }
  return out.slice(0, 12);
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

  /** An optional JSON body: nothing, or one that fits the schema. */
  const optionalBody = async <T>(
    c: { req: { json(): Promise<unknown> } },
    parse: (v: unknown) => T,
  ): Promise<T> => {
    const raw = await c.req.json().catch(() => ({}));
    return parse(raw && typeof raw === 'object' ? raw : {});
  };

  r.post('/messages/:id/factcheck', async (c) => {
    const { m, t } = await load(c.req.param('id'));
    const req = await optionalBody(c, (v) => {
      const p = StartFactcheckRequest.safeParse(v);
      if (!p.success)
        throw new AncileError({
          code: 'request.invalid',
          title: 'That request is not valid',
          hint: p.error.issues[0]?.message ?? 'Check the request body.',
          status: 400,
          errorClass: 'permanent',
        });
      return p.data;
    });
    // GR24: no judge from another family means no check, said before it starts.
    if (m.role === 'assistant' && m.status === 'complete')
      await deps.preflight?.({ threadId: t.id, generatorFamily: deps.familyOf(m.model_id) });
    const { record, web } = await startFactcheck(deps, m.id, {
      workspaceId: t.workspace_id,
      notebookId: t.notebook_id,
      ...(req.web !== undefined && { web: req.web }),
    });
    const runId = record.run_id ?? '';
    return c.json(
      {
        factcheck_id: record.id,
        run_id: runId,
        stream_url: `/api/v1/runs/${runId}/stream`,
        web: { used: web.use, note: web.note },
      },
      202,
    );
  });

  r.post('/messages/:id/selection-checks', async (c) => {
    const { m, t } = await load(c.req.param('id'));
    if (!deps.selection)
      throw new AncileError({
        code: 'factcheck.unavailable',
        title: 'Highlighted claims cannot be checked here',
        hint: 'Core was started without the fact-check service. Restart NVX Ancile.',
        status: 503,
        errorClass: 'permanent',
      });
    const p = StartSelectionCheckRequest.safeParse(await c.req.json().catch(() => null));
    if (!p.success)
      throw new AncileError({
        code: 'request.invalid',
        title: 'That highlight cannot be checked',
        hint: 'Highlight some text in the message, then choose Fact-check.',
        status: 400,
        errorClass: 'permanent',
      });
    const out = await deps.selection.run(
      { ...p.data, messageId: m.id, workspaceId: t.workspace_id },
      c.req.raw.signal,
    );
    return c.json(out);
  });

  r.get('/messages/:id/selection-checks', async (c) => {
    const { m } = await load(c.req.param('id'));
    return c.json({ checks: checksOf(m) });
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
        memoryUsed: memoryUsedOf(m.provenance, deps.memoryEntry),
      }),
    );
  });

  return r;
}
