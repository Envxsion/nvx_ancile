/**
 * Images (docs/images.md, Storage) on both backends: the same picture put
 * twice is two rows and one file; a thread's rows go with the thread, and
 * the sweep then removes the file no row names; hosts allowed for remote
 * images are remembered per key.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ImageStore, MemoryImageRows, PgImageRows } from '../../src/images/store';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { png } from '../images/fixtures';
import { eachBackend, uid } from '../support/stores';

eachBackend('image store', (backend) => {
  let dir: string;
  let store: ImageStore;
  let threads: ThreadRepo;
  let ws: string;
  let rows: MemoryImageRows | PgImageRows;

  beforeEach(async () => {
    const b = backend();
    ws = b.owner.workspaceId;
    dir = await mkdtemp(join(tmpdir(), 'ancile-images-'));
    rows = b.sql ? new PgImageRows(b.sql) : new MemoryImageRows();
    threads = b.sql ? new PgThreadRepo(b.sql) : new MemoryThreadRepo();
    store = new ImageStore(dir, rows);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const files = async () =>
    (await Promise.all((await readdir(dir)).map((s) => readdir(join(dir, s))))).flat().length;

  it('keeps the same picture once, reads it back, and removes the file after its thread goes', async () => {
    const t = await threads.createThread({ id: uid('thr'), workspace_id: ws });
    const bytes = png(3, 2);
    const a = await store.put({ threadId: t.id, bytes, source: 'attached', alt: 'pump' });
    const b = await store.put({
      threadId: t.id,
      bytes,
      source: 'generated',
      prompt: 'a pump',
      costUsd: 0.04,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.sha256).toBe(b.sha256);
    expect(a).toMatchObject({ mime: 'image/png', width: 3, height: 2, url: `/api/v1/images/${a.id}` });
    expect(await files()).toBe(1);
    const got = await store.get(b.id);
    expect(got?.bytes.equals(bytes)).toBe(true);
    expect(got?.record).toMatchObject({ source: 'generated', prompt: 'a pump', cost_usd: 0.04 });
    expect((await store.forThread(t.id)).map((r) => r.id)).toEqual([a.id, b.id]);

    await threads.deleteThread(t.id);
    expect(await store.deleteThread(t.id, 0)).toBe(1);
    expect(await store.get(a.id)).toBeNull();
    expect(await files()).toBe(0);
  });

  it('remembers allowed hosts per key', async () => {
    const key = uid('nb');
    await rows.allowHost(key, 'example.org');
    await rows.allowHost(key, 'example.org');
    await rows.allowHost(key, 'cdn.example.com');
    expect(await rows.hosts(key)).toEqual(['cdn.example.com', 'example.org']);
    expect(await rows.hosts(uid('nb'))).toEqual([]);
  });
});
