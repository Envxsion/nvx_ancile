/**
 * ------------------------------------------------------------------
 *  Title    |  Memory routes
 *  Ref      |  DESIGN.md §4.1 (Memory), §6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit's view of memory: the files and their
 *           |  entries, saving an edit (with base_sha so a change made
 *           |  meanwhile is merged or shown as a conflict), history,
 *           |  diffs, revert, the inbox of proposals, and a preview of
 *           |  exactly what the next model call would be given.
 *  How      |  File paths ride in the URL after /memory/files/ and
 *           |  /memory/history/, checked by the repository before they
 *           |  touch the disk.
 * ------------------------------------------------------------------
 */

import {
  MemoryRevertRequest,
  MemorySettings,
  ProposalDecisionRequest,
  type ProposalStatus,
  PutMemoryFileRequest,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../app';
import { historyFor } from '../conductor/context';
import type { ModelRegistry } from '../gateway/registry';
import { body } from '../http/body';
import { badRequest, notFound } from '../obs/errors';
import type { ThreadRepo } from '../threads/repo';
import type { MemoryService } from './service';

export interface MemoryRouteDeps {
  service: MemoryService;
  threads?: Pick<ThreadRepo, 'getThread' | 'messages'>;
  registry?: Pick<ModelRegistry, 'chain' | 'get'>;
}

const SHA = /^[0-9a-f]{7,40}$/;
const STATUSES = new Set(['proposed', 'applied', 'rejected', 'auto_applied', 'undone']);

/** The file path after a route prefix, decoded. */
function tail(path: string, marker: string): string {
  const i = path.indexOf(marker);
  if (i < 0) throw badRequest('No file path');
  try {
    return decodeURIComponent(path.slice(i + marker.length));
  } catch {
    throw badRequest('The file path is not valid');
  }
}

export function memoryRoutes(deps: MemoryRouteDeps) {
  const r = new Hono<AppEnv>();
  const { service } = deps;

  r.get('/memory/files', async (c) => c.json(await service.files()));

  r.get('/memory/settings', async (c) => c.json({ capture: await service.captureMode() }));
  r.put('/memory/settings', async (c) => {
    const req = await body(c, MemorySettings);
    await service.setCaptureMode(req.capture);
    return c.json({ capture: await service.captureMode() });
  });

  r.get('/memory/files/*', async (c) => {
    const version = c.req.query('version');
    if (version && !SHA.test(version)) throw badRequest('version must be a commit id');
    return c.json(await service.file(tail(c.req.path, '/memory/files/'), version || undefined));
  });

  r.put('/memory/files/*', async (c) => {
    const req = await body(c, PutMemoryFileRequest);
    return c.json(await service.save(tail(c.req.path, '/memory/files/'), req));
  });

  r.delete('/memory/files/*', async (c) => c.json(await service.remove(tail(c.req.path, '/memory/files/'))));

  r.get('/memory/history/*', async (c) => {
    const path = tail(c.req.path, '/memory/history/');
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 500);
    return c.json({ path, items: await service.history(path, limit) });
  });

  /** Every change, newest first: the timeline across all files. */
  r.get('/memory/log', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 500);
    return c.json({ path: '', items: await service.log(limit) });
  });

  r.get('/memory/diff', async (c) => {
    const a = c.req.query('a') ?? '';
    const b = c.req.query('b') ?? '';
    const path = c.req.query('path') || undefined;
    if (!SHA.test(b)) throw badRequest('b must be a commit id');
    if (!a) {
      // What commit b changed.
      const d = await service.commitDiff(b, path);
      return c.json({ a: d.a, b, path: path ?? null, patch: d.patch });
    }
    if (!SHA.test(a)) throw badRequest('a must be a commit id');
    return c.json({ a, b, path: path ?? null, patch: await service.diff(a, b, path) });
  });

  r.post('/memory/revert', async (c) => {
    const req = await body(c, MemoryRevertRequest);
    return c.json(await service.revert(req.sha));
  });

  r.get('/memory/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ items: [] });
    return c.json(await service.search(q.slice(0, 500)));
  });

  r.get('/memory/proposals', async (c) => {
    const raw = c.req.query('status');
    const status = raw
      ? (raw.split(',').filter((s) => STATUSES.has(s)) as z.infer<typeof ProposalStatus>[])
      : undefined;
    return c.json(await service.proposals(status));
  });

  r.post('/memory/proposals/:id', async (c) => {
    const req = await body(c, ProposalDecisionRequest);
    return c.json(await service.decide(c.req.param('id'), req));
  });

  /** Exactly what would be injected for this thread's next turn. */
  r.get('/memory/preview', async (c) => {
    const threadId = c.req.query('thread');
    const thread = threadId ? await deps.threads?.getThread(threadId) : undefined;
    if (threadId && !thread) throw notFound('That thread');
    let query = c.req.query('q') ?? '';
    if (!query && thread && deps.threads) {
      const all = await deps.threads.messages(thread.id);
      const head = c.req.query('head') ?? thread.active_head_id ?? all.at(-1)?.id;
      const path = head ? historyFor(all, head) : [];
      query = [...path].reverse().find((m) => m.role === 'user')?.content ?? '';
    }
    const explicit = c.req.query('model') ?? thread?.settings?.model ?? null;
    let model: { id: string; context_window: number } | undefined;
    try {
      model = deps.registry?.chain('chat.default', explicit)[0];
    } catch {
      model = explicit ? deps.registry?.get(explicit) : undefined;
    }
    return c.json(
      await service.preview({
        notebookId: thread?.notebook_id ?? c.req.query('notebook') ?? null,
        modelId: model?.id ?? explicit ?? 'none',
        contextWindow: model?.context_window ?? 32_000,
        query,
      }),
    );
  });

  return r;
}
