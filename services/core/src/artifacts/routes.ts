/**
 * ------------------------------------------------------------------
 *  Title    |  Artifact routes
 *  Ref      |  docs/artifacts.md · docs/api.md (Artifacts)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit's artifact panel: a thread's artifacts with
 *           |  their versions, and the per-artifact network switch.
 *  How      |  GET /threads/:id/artifacts lists (store.ts parses the
 *           |  answers). PUT /threads/:id/artifacts/:key/network
 *           |  { allow } records the person's decision. Rendering and
 *           |  the sandbox are the Cockpit's: Core never serves an
 *           |  artifact's content as a page.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type ArtifactNetwork,
  ArtifactNetworkRequest,
  type ThreadArtifacts,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { logFor } from '../obs/logger';
import type { ThreadRepo } from '../threads/repo';
import { type ArtifactStore, listArtifacts, pathFrom } from './store';

const log = logFor('artifacts');

const KEY = /^[A-Za-z0-9_-]{1,80}$/;

export function artifactRoutes(deps: {
  store: ArtifactStore;
  threads: Pick<ThreadRepo, 'getThread' | 'skeleton'>;
  workspaceId: string;
}) {
  const r = new Hono<AppEnv>();

  const thread = async (id: string) => {
    const t = await deps.threads.getThread(id);
    if (!t || t.workspace_id !== deps.workspaceId)
      throw new AncileError({
        code: 'request.not_found',
        title: "That thread doesn't exist.",
        hint: 'It may have been deleted. Open another thread from the rail.',
        status: 404,
        errorClass: 'permanent',
      });
    return t;
  };

  r.get('/threads/:id/artifacts', async (c) => {
    const t = await thread(c.req.param('id'));
    const [answers, settings, skeleton] = await Promise.all([
      deps.store.answers(t.id),
      deps.store.settings(t.id),
      deps.threads.skeleton(t.id),
    ]);
    const parents = new Map(skeleton.map((m) => [m.id, m.parent_id]));
    const onPath = t.active_head_id ? pathFrom(t.active_head_id, parents) : null;
    const out: ThreadArtifacts = { items: listArtifacts(answers, settings, onPath) };
    return c.json(out);
  });

  r.put('/threads/:id/artifacts/:key/network', async (c) => {
    const t = await thread(c.req.param('id'));
    const key = c.req.param('key');
    if (!KEY.test(key))
      throw new AncileError({
        code: 'artifact.bad_key',
        title: "That artifact name isn't valid.",
        hint: 'Open the artifact from its answer and change the setting there.',
        status: 400,
        errorClass: 'permanent',
      });
    const req = await body(c, ArtifactNetworkRequest);
    const s = await deps.store.setNetwork(t.id, key, req.allow);
    // Recorded in the log too, so the decision is visible in Admin → Logs.
    log.info({ thread_id: t.id, artifact: key, allow_network: req.allow }, 'artifact network decision');
    const out: ArtifactNetwork = {
      key: s.key,
      allow_network: s.allow_network,
      network_changed_at: s.changed_at,
    };
    return c.json(out);
  });

  return r;
}
