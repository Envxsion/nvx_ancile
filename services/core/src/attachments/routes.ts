/**
 * ------------------------------------------------------------------
 *  Title    |  Attachment routes
 *  Ref      |  ROADMAP.md CH6 · docs/api.md (Attachments)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Attach a file to the next message of a thread, and take
 *           |  it back.
 *  How      |  POST   /threads/:id/attachments        multipart, `file`
 *           |  DELETE /threads/:id/attachments/:att   forget it
 *           |  The reply is an AttachmentRecord: a name, a page count
 *           |  and a length for the chip, never the text. The turn
 *           |  names the file by id (attachment_ids on /turns).
 *  Note     |  Nothing here touches a notebook. Keeping a file as a
 *           |  source is a separate upload the Cockpit makes only when
 *           |  the person turns "Keep in notebook" on.
 * ------------------------------------------------------------------
 */

import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { notFound } from '../obs/errors';
import type { ThreadRepo } from '../threads/repo';
import { type AttachmentService, notReadable } from './service';

export function attachmentRoutes(deps: {
  attachments: AttachmentService;
  threads: Pick<ThreadRepo, 'getThread'>;
  workspaceId: string;
}) {
  const r = new Hono<AppEnv>();
  const thread = async (id: string) => {
    const t = await deps.threads.getThread(id);
    if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That thread');
    return t;
  };

  r.post('/threads/:id/attachments', async (c) => {
    const t = await thread(c.req.param('id'));
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const file = form.file;
    if (!(file instanceof File)) throw notReadable('That upload');
    const record = await deps.attachments.add(t.id, {
      name: file.name,
      mime: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return c.json(record, 201);
  });

  r.delete('/threads/:id/attachments/:att', async (c) => {
    const t = await thread(c.req.param('id'));
    deps.attachments.discard(t.id, c.req.param('att'));
    return c.body(null, 204);
  });

  return r;
}
