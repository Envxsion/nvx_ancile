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
 *           |  bindings, and live sessions: start one in a folder, send
 *           |  a turn, stop it, its live state and the "/" command list,
 *           |  and a new folder (or none) when the session's moved.
 *  How      |  Behind the normal /api/v1 guard. Every button here is
 *           |  the person acting. Only send runs anything: a turn in the
 *           |  person's own Claude Code, as a run (claudecode/live.ts).
 * ------------------------------------------------------------------
 */

import {
  AddClaudeCodeMcpServerRequest,
  CLIENT_ID_HEADER,
  ClaudeCodeFolderRequest,
  ClaudeCodeMcpScope,
  ClaudeCodeProject,
  CreateClaudeCodeThreadRequest,
  ExcludeClaudeCodeFolderRequest as ExcludeFolderRequest,
  ImportClaudeCodeSessionsRequest,
  PatchClaudeCodeSettings,
  SameRepoChoice,
  SendClaudeCodeRequest,
  UseClaudeCodeMcpRequest,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { badRequest } from '../obs/errors';
import { holderOf, type SendLocks, withSendLock } from '../threads/send-lock';
import { ccErrors } from './errors';
import type { ClaudeCodeLive } from './live';
import type { ClaudeCodeMcpList } from './mcp-list';
import type { ClaudeCodeMcpManage } from './mcp-manage';
import type { TurnQueue } from './queue';
import type { SameRepoFinder } from './same-repo';
import type { ClaudeCodeService } from './service';

const SignInRequest = z.object({ method: z.enum(['claudeai', 'console', 'sso']).optional() }).strict();

export function claudeCodeRoutes(deps: {
  service: () => ClaudeCodeService;
  live?: () => ClaudeCodeLive | null;
  /** Messages waiting for their session to be free (queue.ts, CC6). */
  queue?: () => TurnQueue | null;
  /** One sender per thread across windows (threads/send-lock.ts). */
  sendLocks?: SendLocks;
  /** One repository in two folders: matches between folder notebooks (same-repo.ts). */
  sameRepo?: () => SameRepoFinder | null;
  /** Claude Code's own MCP servers, read-only (mcp-list.ts). */
  mcpList?: () => ClaudeCodeMcpList | null;
  /** Use, add and remove Claude Code's MCP servers through its own command (mcp-manage.ts). */
  mcpManage?: () => ClaudeCodeMcpManage | null;
}) {
  const r = new Hono<AppEnv>();

  r.get('/claude-code/mcp-servers', async (c) => {
    const list = deps.mcpList?.();
    if (!list) return c.json({ servers: [], from: null, updated_at: null, can_refresh: false });
    return c.json(await list.get({ refresh: c.req.query('refresh') === '1' }));
  });
  const manage = () => {
    const m = deps.mcpManage?.();
    if (!m) throw ccErrors.sdkUnavailable('Claude Code servers cannot be managed in this Core');
    return m;
  };
  // "Use in NVX Ancile": what would be copied (no secret value in it), then the copy. Claude Code is not changed.
  r.post('/claude-code/mcp-servers/:name/use/preview', async (c) => {
    const req = await body(c, UseClaudeCodeMcpRequest);
    return c.json(await manage().preview(c.req.param('name'), req));
  });
  r.post('/claude-code/mcp-servers/:name/use', async (c) =>
    c.json(await manage().use(c.req.param('name'), await body(c, UseClaudeCodeMcpRequest)), 201),
  );
  // Add or change (replace: true) a server in Claude Code, and remove one, through `claude mcp`.
  r.post('/claude-code/mcp-servers', async (c) =>
    c.json(await manage().add(await body(c, AddClaudeCodeMcpServerRequest)), 201),
  );
  r.delete('/claude-code/mcp-servers/:name', async (c) => {
    const scope = ClaudeCodeMcpScope.safeParse(c.req.query('scope') ?? 'user');
    if (!scope.success) throw badRequest('scope: use user, project or local');
    await manage().remove(c.req.param('name'), scope.data);
    return c.body(null, 204);
  });
  const svc = deps.service;
  const live = () => {
    const l = deps.live?.();
    if (!l) throw ccErrors.sdkUnavailable('live sessions are not running in this Core');
    return l;
  };

  // A new thread bound to a new session in a folder; the session starts with the first turn.
  r.post('/claude-code/threads', async (c) => {
    const req = await body(c, CreateClaudeCodeThreadRequest);
    return c.json(await live().createThread(req), 201);
  });

  r.post('/claude-code/threads/:id/send', async (c) => {
    const req = await body(c, SendClaudeCodeRequest);
    const id = c.req.param('id');
    const out = await withSendLock(deps.sendLocks, id, holderOf(c.req.header(CLIENT_ID_HEADER)), () =>
      live().sendOrQueue(id, req),
    );
    return c.json(out, 202);
  });

  const queue = (): TurnQueue => {
    const q = deps.queue?.();
    if (!q) throw ccErrors.notLive();
    return q;
  };

  // A waiting message: remove it, send it again after a failure, or send it now as a branch.
  r.delete('/claude-code/threads/:id/queue/:qid', async (c) =>
    c.json({ items: await queue().remove(c.req.param('id'), c.req.param('qid')) }),
  );
  r.post('/claude-code/threads/:id/queue/:qid/retry', async (c) =>
    c.json({ items: await queue().retry(c.req.param('id'), c.req.param('qid')) }),
  );
  r.post('/claude-code/threads/:id/queue/:qid/branch', async (c) => {
    const id = c.req.param('id');
    const out = await withSendLock(deps.sendLocks, id, holderOf(c.req.header(CLIENT_ID_HEADER)), () =>
      queue().branchNow(id, c.req.param('qid')),
    );
    return c.json(out, 202);
  });

  r.post('/claude-code/threads/:id/interrupt', async (c) =>
    c.json(await live().interrupt(c.req.param('id'))),
  );

  r.get('/claude-code/threads/:id/live', async (c) => c.json(await live().state(c.req.param('id'))));

  // The person chose another model while the turn waits on approvals: they are withdrawn.
  r.post('/claude-code/threads/:id/model-changed', async (c) =>
    c.json(await live().modelChanged(c.req.param('id'))),
  );

  // The session's folder moved or went away: point to where it is now, or go on without files.
  r.post('/claude-code/threads/:id/folder', async (c) => {
    const req = await body(c, ClaudeCodeFolderRequest);
    return c.json(await live().setFolder(c.req.param('id'), req));
  });

  // At once: the built-ins marked partial until Claude Code's own list is read (?wait=1 waits for it).
  r.get('/claude-code/threads/:id/commands', async (c) =>
    c.json(await live().commands(c.req.param('id'), { wait: c.req.query('wait') === '1' })),
  );

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

  // One repository in two folders: never merged by itself; the person shows them together or keeps them apart.
  const same = () => deps.sameRepo?.() ?? null;
  r.get('/claude-code/notebooks/:id/same-repo', async (c) => {
    const f = same();
    return c.json(f ? await f.matchesFor(c.req.param('id')) : { items: [], can_merge: false });
  });
  r.post('/claude-code/notebooks/:id/same-repo', async (c) => {
    const req = await body(c, SameRepoChoice);
    const f = same();
    if (!f) throw ccErrors.sdkUnavailable('same-repository matching is not running in this Core');
    return c.json(await f.choose(c.req.param('id'), req.other_notebook_id, req.choice));
  });
  r.get('/claude-code/notebook-links', async (c) => {
    const f = same();
    return c.json(f ? await f.links() : { groups: [] });
  });

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
