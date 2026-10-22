/**
 * The code editor's file routes: what is reachable (the workspace, a
 * repository, a Claude Code folder; nothing outside, no symlink escape),
 * and that every read and save asks the permission gate on the real
 * path. A save the gate asks about needs the person's confirmation, which
 * is logged as approved; a save over a changed file is refused.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileContent } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rootSource } from '../../src/files/roots';
import { fileRoutes } from '../../src/files/routes';
import { FileService, isBinary } from '../../src/files/service';
import { errorHandler } from '../../src/obs/errors';
import type { DecisionResult } from '../../src/permissions/decide';
import type { Gate, GateRequest } from '../../src/permissions/gate';

type Err = { error: { code: string; context: Record<string, unknown> } };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('file routes', () => {
  let base: string;
  let ws: string;
  let repo: string;
  let away: string;
  let checks: GateRequest[];
  let decisions: unknown[];
  let answer: (req: GateRequest) => DecisionResult;
  let app: Hono;

  const gate: Gate = {
    check: async (req) => {
      checks.push(req);
      return answer(req);
    },
    recheck: async () => null,
  };

  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'ancile-files-')));
    ws = join(base, 'ws');
    repo = join(base, 'repo');
    away = join(base, 'away');
    for (const d of [ws, repo, away]) await mkdir(d, { recursive: true });
    await writeFile(join(ws, 'a.md'), '# Hello\n');
    await writeFile(join(repo, 'main.ts'), 'export const x = 1;\n');
    await writeFile(join(away, 'secret.txt'), 'nope');
    checks = [];
    decisions = [];
    answer = (req) => ({ outcome: 'allow', via: 'auto', tier: req.toolTier, resource: req.resource });
    const files = new FileService({
      roots: rootSource({
        workspace: { dir: ws, root: '/workspace' },
        repos: async () => [{ name: 'repo', root: repo }],
        claudeProjects: async () => [],
      }),
      workspace: { dir: ws, root: '/workspace' },
      gate,
      gateFor: () => gate,
      store: { recordDecision: async (d) => void decisions.push(d) as never },
      userId: 'usr_1',
      workspaceId: 'wsp_1',
      notebookOf: async () => 'nbk_1',
    });
    app = new Hono();
    app.onError(errorHandler);
    app.route('/', fileRoutes({ files }) as unknown as Hono);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('reads a workspace file through the gate, as /workspace/…', async () => {
    const r = await call<FileContent>('GET', '/files?path=/workspace/a.md&thread_id=thr_1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name: 'a.md',
      content: '# Hello\n',
      binary: false,
      sha256: sha('# Hello\n'),
    });
    expect(r.body.root.kind).toBe('workspace');
    expect(checks[0]).toMatchObject({
      action: 'fs.read',
      resource: 'fs:/workspace/a.md',
      principal: 'person:editor',
      scope: { threadId: 'thr_1', notebookId: 'nbk_1' },
    });
  });

  it('reads a repository file by its real path', async () => {
    const r = await call<FileContent>('GET', `/files?path=${encodeURIComponent(join(repo, 'main.ts'))}`);
    expect(r.status).toBe(200);
    expect(r.body.root).toMatchObject({ kind: 'repo', label: 'repo' });
    expect(checks[0]?.resource.endsWith('/repo/main.ts')).toBe(true);
  });

  it('refuses a file outside every root, and ".." out of one', async () => {
    const r = await call<Err>('GET', `/files?path=${encodeURIComponent(join(away, 'secret.txt'))}`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('files.outside_roots');
    const climb = await call<Err>(
      'GET',
      `/files?path=${encodeURIComponent('/workspace/../away/secret.txt')}`,
    );
    expect(climb.body.error.code).toBe('files.outside_roots');
    expect(checks).toHaveLength(0);
  });

  it('refuses a symlink inside a root that points out of it', async () => {
    try {
      await symlink(away, join(ws, 'link'), 'junction');
    } catch {
      return; // no symlink rights on this machine
    }
    const r = await call<Err>('GET', '/files?path=/workspace/link/secret.txt');
    expect(r.body.error.code).toBe('files.outside_roots');
  });

  it('says a gate refusal plainly', async () => {
    answer = (req) => ({
      outcome: 'deny',
      via: 'scope',
      tier: 'auto',
      resource: req.resource,
      reason: 'Not here',
    });
    const r = await call<Err>('GET', '/files?path=a.md');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('files.read_denied');
  });

  it('saves on the real path when the gate allows, atomically', async () => {
    const r = await call<{ sha256: string }>('PUT', '/files', {
      path: '/workspace/a.md',
      content: '# Changed\n',
      base_sha256: sha('# Hello\n'),
    });
    expect(r.status).toBe(200);
    expect(r.body.sha256).toBe(sha('# Changed\n'));
    expect(await readFile(join(ws, 'a.md'), 'utf8')).toBe('# Changed\n');
    expect(checks[0]).toMatchObject({
      action: 'fs.write',
      toolTier: 'gated',
      resource: 'fs:/workspace/a.md',
    });
  });

  it('asks for confirmation when the gate would ask, and logs the answer', async () => {
    answer = (req) => ({ outcome: 'ask', tier: 'gated', resource: req.resource, suggestions: [] });
    const body = { path: '/workspace/a.md', content: 'x', base_sha256: sha('# Hello\n') };
    const ask = await call<Err>('PUT', '/files', body);
    expect(ask.status).toBe(409);
    expect(ask.body.error.code).toBe('files.needs_confirm');
    expect(ask.body.error.context).toMatchObject({ tier: 'gated', resource: 'fs:/workspace/a.md' });
    expect(await readFile(join(ws, 'a.md'), 'utf8')).toBe('# Hello\n');

    const ok = await call('PUT', '/files', { ...body, confirmed: true });
    expect(ok.status).toBe(200);
    expect(await readFile(join(ws, 'a.md'), 'utf8')).toBe('x');
    expect(decisions).toEqual([
      expect.objectContaining({ outcome: 'approved', action: 'fs.write', principal: 'person:editor' }),
    ]);
  });

  it('never writes what the gate denies, confirmed or not', async () => {
    answer = (req) => ({
      outcome: 'deny',
      via: 'policy',
      tier: 'gated',
      resource: req.resource,
      reason: 'No',
    });
    const r = await call<Err>('PUT', '/files', {
      path: '/workspace/a.md',
      content: 'x',
      base_sha256: sha('# Hello\n'),
      confirmed: true,
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('files.write_denied');
    expect(await readFile(join(ws, 'a.md'), 'utf8')).toBe('# Hello\n');
  });

  it('refuses to save over a file that changed since it was opened', async () => {
    const r = await call<Err>('PUT', '/files', {
      path: '/workspace/a.md',
      content: 'x',
      base_sha256: sha('old'),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('files.changed');
    const fresh = await call<Err>('PUT', '/files', {
      path: '/workspace/a.md',
      content: 'x',
      base_sha256: null,
    });
    expect(fresh.body.error.code).toBe('files.changed');
  });

  it('creates a new file when nothing is there yet', async () => {
    const r = await call<Err>('PUT', '/files', {
      path: '/workspace/notes/new.txt',
      content: 'hi',
      base_sha256: null,
    });
    expect(r.body.error.code).toBe('files.no_folder');
    await mkdir(join(ws, 'notes'));
    const ok = await call('PUT', '/files', {
      path: '/workspace/notes/new.txt',
      content: 'hi',
      base_sha256: null,
    });
    expect(ok.status).toBe(200);
  });

  it('tells binary files apart from text', () => {
    expect(isBinary(Buffer.from('plain text ✓'))).toBe(false);
    expect(isBinary(Buffer.from([0x50, 0x00, 0x51]))).toBe(true);
    expect(isBinary(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(true);
  });
});
