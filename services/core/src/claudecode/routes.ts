/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code routes
 *  Ref      |  docs/api.md (Works with Claude Code) · docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit's API for Claude Code, under
 *           |  /api/v1/claude-code: status and settings, install,
 *           |  sign-in and sign-out (Claude Code's own flow), the
 *           |  session list, import and sync, and folder → notebook
 *           |  bindings.
 *  How      |  Behind the normal /api/v1 guard. Every button here is
 *           |  the person acting; nothing runs a model or a tool.
 * ------------------------------------------------------------------
 */

import {
  ClaudeCodeProject,
  ExcludeClaudeCodeFolderRequest as ExcludeFolderRequest,
  ImportClaudeCodeSessionsRequest,
  PatchClaudeCodeSettings,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { badRequest } from '../obs/errors';
import type { ClaudeCodeService } from './service';

const SignInRequest = z.object({ method: z.enum(['claudeai', 'console', 'sso']).optional() }).strict();

export function claudeCodeRoutes(deps: { service: () => ClaudeCodeService }) {
  const r = new Hono<AppEnv>();
  const svc = deps.service;

  r.get('/claude-code/status', async (c) => c.json(await svc().status(!!c.req.query('fresh'))));

  r.patch('/claude-code/settings', async (c) => {
    const patch = await body(c, PatchClaudeCodeSettings);
    return c.json(await svc().patchSettings(patch));
  });

  r.post('/claude-code/install', async (c) => c.json(await svc().install(), 202));

  r.post('/claude-code/sign-in', async (c) => {
    const req = await body(c, SignInRequest);
    return c.json(await svc().signIn(req.method), 202);
  });

  r.post('/claude-code/sign-out', async (c) => {
    await svc().signOut();
    return c.body(null, 204);
  });

  r.get('/claude-code/sessions', async (c) => {
    const limit = c.req.query('limit');
    if (limit !== undefined && !/^\d+$/.test(limit)) throw badRequest('limit: a whole number from 1 to 500');
    return c.json(
      await svc().listSessions({
        ...(c.req.query('q') && { q: c.req.query('q') as string }),
        ...(c.req.query('cwd') && { cwd: c.req.query('cwd') as string }),
        ...(limit && { limit: Number(limit) }),
        cursor: c.req.query('cursor') ?? null,
      }),
    );
  });

  r.post('/claude-code/sessions/import', async (c) => {
    const req = await body(c, ImportClaudeCodeSessionsRequest);
    return c.json(await svc().importSessions(req));
  });

  r.post('/claude-code/threads/:id/sync', async (c) => c.json(await svc().syncThread(c.req.param('id'))));

  r.get('/claude-code/projects', async (c) => c.json({ items: await svc().projects() }));

  r.put('/claude-code/projects', async (c) => {
    const req = await body(c, ClaudeCodeProject.strict());
    return c.json(await svc().putProject(req));
  });

  // "Don't bring in this folder": excluded from now on; what came from it is put away.
  r.post('/claude-code/projects/exclude', async (c) => {
    const req = await body(c, ExcludeFolderRequest);
    return c.json(await svc().excludeFolder(req.cwd));
  });

  r.delete('/claude-code/projects', async (c) => {
    const cwd = c.req.query('cwd');
    if (!cwd) throw badRequest('cwd: the folder to unbind');
    await svc().removeProject(cwd);
    return c.body(null, 204);
  });

  return r;
}
