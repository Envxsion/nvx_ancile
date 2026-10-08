/**
 * Lab Undo is only offered while nothing has happened since the run: no
 * live run in the thread, no later lab run, not undone already. Restore
 * never follows a link out of the lab folder.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { type LabCheckpoint, labPlace, snapshotDir } from '../../src/lab/handler';
import { labRoutes } from '../../src/lab/routes';
import { restoreSnapshot, takeSnapshot } from '../../src/lab/snapshot';
import { errorHandler } from '../../src/obs/errors';
import type { RunRecord } from '../../src/runs/engine';
import { MemoryRunStore } from '../../src/runs/store';
import { MemoryThreadRepo } from '../../src/threads/repo';

let root = '';
afterEach(async () => rm(root, { recursive: true, force: true }));

const WS = 'wsp_1';

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'lab-undo-'));
  const repo = new MemoryThreadRepo();
  const runs = new MemoryRunStore();
  const deps = {
    engine: null,
    repo,
    runs,
    worker: { kick: () => undefined },
    workspaceId: WS,
    workspaceDir: join(root, 'ws'),
    workspaceRoot: '/workspace',
    snapshotsDir: join(root, 'snaps'),
  };
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', labRoutes(deps));
  const thread = await repo.createThread({ id: 'thr_1', workspace_id: WS });
  const lab = labPlace(deps, thread.id).realDir;
  await mkdir(lab, { recursive: true });

  /** A finished lab run that snapshotted the folder as it is now. */
  const labRun = async (id: string) => {
    const messageId = `msg_${id}`;
    await repo.insertMessage({
      id: messageId,
      thread_id: thread.id,
      parent_id: null,
      role: 'assistant',
      parts: [],
      status: 'complete',
      trace_id: 't'.repeat(32),
    });
    const cp: LabCheckpoint = {
      v: 1,
      threadId: thread.id,
      workspaceId: WS,
      messageId,
      prompt: 'x',
      sessionId: 'ses_1',
      promptMessageId: null,
    };
    const run = await runs.create({
      id,
      kind: 'agent',
      traceId: 't'.repeat(32),
      threadId: thread.id,
      messageId,
      checkpoint: cp,
    });
    await takeSnapshot(lab, snapshotDir(deps, id));
    await runs.save({ ...run, status: 'succeeded' } as RunRecord, { status: 'queued' });
  };
  const undo = async (id: string) => {
    const res = await app.request(`/runs/${id}/undo`, { method: 'POST' });
    return { status: res.status, body: (await res.json()) as { error?: { code: string }; undone?: boolean } };
  };
  return { repo, runs, lab, labRun, undo };
}

describe('lab undo', () => {
  it('puts the files back once, and refuses a second undo', async () => {
    const t = await setup();
    await writeFile(join(t.lab, 'a.md'), 'before');
    await t.labRun('run_1');
    await writeFile(join(t.lab, 'a.md'), 'after');
    expect((await t.undo('run_1')).body.undone).toBe(true);
    expect(await readFile(join(t.lab, 'a.md'), 'utf8')).toBe('before');
    const again = await t.undo('run_1');
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('lab.already_undone');
  });

  it('refuses to undo a run that a later lab run built on', async () => {
    const t = await setup();
    await t.labRun('run_1');
    await t.labRun('run_2');
    const r = await t.undo('run_1');
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('lab.undo_superseded');
    expect((await t.undo('run_2')).status).toBe(200);
  });

  it('refuses while something is live in the thread', async () => {
    const t = await setup();
    await t.labRun('run_1');
    await t.runs.create({
      id: 'run_live',
      kind: 'chat_turn',
      traceId: 't'.repeat(32),
      threadId: 'thr_1',
      messageId: null,
      checkpoint: {},
    });
    const r = await t.undo('run_1');
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('run.already_running');
  });
});

describe('restore and links', () => {
  it('never writes through a link to a folder outside the lab', async () => {
    root = await mkdtemp(join(tmpdir(), 'lab-link-'));
    const lab = join(root, 'lab');
    const snap = join(root, 'snap');
    const outside = join(root, 'outside');
    await mkdir(join(lab, 'docs'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(lab, 'docs', 'a.md'), 'mine');
    await takeSnapshot(lab, snap);
    // The run swaps the folder for a link to somewhere else.
    await rm(join(lab, 'docs'), { recursive: true });
    await symlink(outside, join(lab, 'docs'), 'junction');
    await expect(restoreSnapshot(lab, snap)).rejects.toMatchObject({ code: 'lab.undo_unsafe' });
    await expect(readFile(join(outside, 'a.md'))).rejects.toThrow();
  });
});
