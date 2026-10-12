/**
 * ------------------------------------------------------------------
 *  Title    |  Image routes
 *  Ref      |  docs/images.md · docs/api.md (Images)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the Cockpit needs for images in a thread: the
 *           |  providers (or the one line saying what to set up),
 *           |  attaching an image to the next turn, the stored bytes,
 *           |  and remote images behind the person's per-notebook yes.
 *  How      |  GET  /images/providers
 *           |  POST /threads/:id/images              multipart, `file`
 *           |  GET  /threads/:id/images
 *           |  GET  /images/:id                       the bytes
 *           |  GET  /threads/:id/image-hosts
 *           |  POST /threads/:id/image-hosts          { host }
 *           |  GET  /threads/:id/images/remote?url=   the bytes, proxied
 *  Note     |  Every response with image bytes says nosniff and a
 *           |  sandboxing CSP: it is data, never a page.
 * ------------------------------------------------------------------
 */

import { AllowImageHostRequest, IMAGE_LIMITS } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { notFound } from '../obs/errors';
import type { ThreadRepo } from '../threads/repo';
import { type ImageService, imageNotFound } from './service';
import { notAnImage, tooLarge } from './store';

const imageHeaders = (mime: string, bytes: number, cache: string) => ({
  'content-type': mime,
  'content-length': String(bytes),
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': cache,
});

export function imageRoutes(deps: {
  images: ImageService;
  threads: Pick<ThreadRepo, 'getThread'>;
  workspaceId: string;
}) {
  const r = new Hono<AppEnv>();
  const thread = async (id: string) => {
    const t = await deps.threads.getThread(id);
    if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That thread');
    return t;
  };

  r.get('/images/providers', async (c) => c.json(await deps.images.providers()));

  r.post('/threads/:id/images', async (c) => {
    const t = await thread(c.req.param('id'));
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const file = form.file;
    if (!(file instanceof File)) throw notAnImage('That upload');
    if (file.size > IMAGE_LIMITS.bytes) throw tooLarge(file.name || 'That image');
    const bytes = Buffer.from(await file.arrayBuffer());
    const alt = typeof form.alt === 'string' ? form.alt : (c.req.query('alt') ?? file.name ?? '');
    return c.json(await deps.images.attach(t.id, bytes, alt.slice(0, 500)), 201);
  });

  r.get('/threads/:id/images', async (c) => {
    const t = await thread(c.req.param('id'));
    return c.json({ items: await deps.images.store.forThread(t.id) });
  });

  r.get('/images/:id', async (c) => {
    const got = await deps.images.store.get(c.req.param('id'));
    if (!got) throw imageNotFound();
    // Only images of this workspace's threads (ids alone are not access).
    if (got.record.thread_id) await thread(got.record.thread_id).catch(() => Promise.reject(imageNotFound()));
    return new Response(new Uint8Array(got.bytes), {
      status: 200,
      headers: imageHeaders(got.record.mime, got.bytes.length, 'private, max-age=31536000, immutable'),
    });
  });

  r.get('/threads/:id/image-hosts', async (c) =>
    c.json(await deps.images.hosts(await thread(c.req.param('id')))),
  );

  r.post('/threads/:id/image-hosts', async (c) => {
    const t = await thread(c.req.param('id'));
    const req = await body(c, AllowImageHostRequest);
    return c.json(await deps.images.allowHost(t, req.host));
  });

  r.get('/threads/:id/images/remote', async (c) => {
    const t = await thread(c.req.param('id'));
    const got = await deps.images.remote(t, c.req.query('url') ?? '', c.req.raw.signal);
    return new Response(new Uint8Array(got.bytes), {
      status: 200,
      headers: imageHeaders(got.mime, got.bytes.length, 'private, max-age=3600'),
    });
  });

  return r;
}
