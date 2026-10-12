/**
 * ------------------------------------------------------------------
 *  Title    |  Engines routes
 *  Ref      |  docs/api.md (Engines) · docs/engines.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit's API for one thread, any model: the
 *           |  engines and whether each can answer, a turn sent to
 *           |  whichever engine its model chooses, and NVX Ancile's
 *           |  instructions and persona for a thread or notebook.
 *  How      |  Behind the normal /api/v1 guard. POST
 *           |  /threads/:id/turns is the only route that runs anything:
 *           |  a turn, as a run, through Engines.send (scope first).
 * ------------------------------------------------------------------
 */

import { type InstructionsView, PutInstructionsRequest, SendTurnRequest } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import type { ThreadRepo } from '../threads/repo';
import type { Engines } from './index';
import { effective, instructionsNote } from './note';
import type { EngineStore } from './store';

export function engineRoutes(deps: {
  engines: () => Engines;
  threads: ThreadRepo;
  store: EngineStore;
  workspaceId: string;
}) {
  const r = new Hono<AppEnv>();
  const thread = async (id: string) => {
    const t = await deps.threads.getThread(id);
    if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That thread');
    return t;
  };
  const view = async (threadId: string): Promise<InstructionsView> => {
    const t = await thread(threadId);
    const nb = t.notebook_id ? await deps.store.notebookInstructions(t.notebook_id) : null;
    const own = {
      instructions: t.settings.ancile?.instructions ?? '',
      persona: t.settings.ancile?.persona ?? '',
    };
    return { thread: own, notebook: nb, effective: instructionsNote(effective(own, nb)) };
  };

  r.get('/engines', async (c) => c.json({ items: await deps.engines().info() }));

  r.post('/threads/:id/turns', async (c) => {
    const t = await thread(c.req.param('id'));
    const req = await body(c, SendTurnRequest);
    const out = await deps.engines().send(t, {
      text: req.text,
      parentId: req.parent_id,
      model: req.model ?? null,
      ...(req.effort && { effort: req.effort }),
      ...(req.source_ids && { sourceIds: req.source_ids }),
      ...(req.as_branch && { asBranch: true }),
      ...(req.task_class && { taskClass: req.task_class }),
      idempotencyKey: req.idempotency_key,
    });
    return c.json(out, 202);
  });

  r.get('/threads/:id/instructions', async (c) => c.json(await view(c.req.param('id'))));

  r.put('/threads/:id/instructions', async (c) => {
    const t = await thread(c.req.param('id'));
    const req = await body(c, PutInstructionsRequest);
    const next = {
      instructions: req.instructions ?? t.settings.ancile?.instructions ?? '',
      persona: req.persona ?? t.settings.ancile?.persona ?? '',
    };
    await deps.threads.patchThread(t.id, { settings: { ancile: next } });
    return c.json(await view(t.id));
  });

  r.get('/notebooks/:id/instructions', async (c) => {
    const nb = await deps.store.notebookInstructions(c.req.param('id'));
    if (!nb) throw notFound('That notebook');
    return c.json(nb);
  });

  r.put('/notebooks/:id/instructions', async (c) => {
    const req = await body(c, PutInstructionsRequest);
    const nb = await deps.store.setNotebookInstructions(c.req.param('id'), {
      ...(req.instructions !== undefined && { instructions: req.instructions }),
      ...(req.persona !== undefined && { persona: req.persona }),
    });
    if (!nb) throw notFound('That notebook');
    return c.json(nb);
  });

  return r;
}
