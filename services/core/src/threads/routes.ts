/**
 * ------------------------------------------------------------------
 *  Title    |  Thread, message and run routes
 *  Ref      |  DESIGN.md §4.1, §8
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit's chat API: threads, the path to a head,
 *           |  send / regenerate / edit / stop, and run status.
 *  How      |  Every write goes through startTurn() or the worker;
 *           |  every read maps rows to the contract shapes. What a
 *           |  person sends is checked here (userParts) beyond the
 *           |  contract: no blank text, no NUL, only text, file and
 *           |  image parts, and a sane length.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  CreateThreadRequest,
  EditMessageRequest,
  type Message,
  type Part,
  PatchThreadRequest,
  RegenerateRequest,
  SendMessageRequest,
  type Thread,
  ThreadListQuery,
  type ThreadPath,
  type ThreadSearchHit,
  type ThreadSummary,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { AppEnv } from '../app';
import { hasNul } from '../db/json';
import type { FlowStore } from '../flows/store';
import { replayFrom } from '../flows/turn';
import { body } from '../http/body';
import { badRequest, notFound } from '../obs/errors';
import type { RunRecord, RunStore } from '../runs/engine';
import type { RunWorker } from '../runs/worker';
import { ancestorPath, childrenIndex, siblingInfo } from './path';
import { asTree, cursorOf, type MessageRecord, snippetOf, type ThreadRecord, type TreeRecord } from './repo';
import { assertChatModel, startTurn, type TurnDeps, usableChatModel } from './service';

/** Longest text part a person can send (characters); far beyond any context window. */
export const MAX_TEXT_PART = 1_000_000;
const USER_PART_TYPES = new Set(['text', 'file', 'image']);

/** What a person sends must be something a model can read. Throws request.invalid otherwise. */
export function userParts(parts: Part[]): Part[] {
  for (const [i, p] of parts.entries()) {
    if (!USER_PART_TYPES.has(p.type))
      throw badRequest(`parts.${i}: a message can only carry text, files and images, not ${p.type}`);
    if (p.type !== 'text') continue;
    if (hasNul(p.text)) throw badRequest(`parts.${i}.text: contains a NUL character`);
    if (p.text.length > MAX_TEXT_PART)
      throw badRequest(`parts.${i}.text: longer than ${MAX_TEXT_PART.toLocaleString('en-GB')} characters`);
  }
  const blank = parts.every((p) => p.type === 'text' && p.text.trim() === '');
  if (blank) throw badRequest('parts: the message is empty');
  return parts;
}

export interface ThreadRouteDeps extends TurnDeps {
  workspaceId: string;
  runs: RunStore;
  worker: Pick<RunWorker, 'kick' | 'cancel'>;
  /** Moving a thread into a notebook checks the notebook is real. */
  notebookExists?: (id: string) => Promise<boolean>;
  /** Deleting a thread keeps its own flows as workspace drafts. */
  flowStore?: Pick<FlowStore, 'orphan'>;
}

const threadOut = (t: ThreadRecord): Thread => ({
  id: t.id,
  title: t.title,
  notebook_id: t.notebook_id,
  active_head_id: t.active_head_id,
  settings: t.settings,
  pinned_at: t.pinned_at,
  archived_at: t.archived_at,
  created_at: t.created_at,
  updated_at: t.updated_at,
});

const messageOut = (
  m: MessageRecord,
  siblings?: { index: number; count: number; ids: string[] },
): Message => {
  const { deleted_at: _d, parentId: _p, ...rest } = m as TreeRecord;
  return siblings ? { ...rest, siblings } : rest;
};

const runOut = (r: RunRecord) => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  thread_id: r.threadId,
  message_id: r.messageId,
  step_cursor: r.stepCursor,
  trace_id: r.traceId,
  created_at: r.createdAt ?? new Date().toISOString(),
  updated_at: r.updatedAt ?? new Date().toISOString(),
  error: r.error ?? null,
});

/** Follow the newest child down from a message, so a head on a user message lands on its reply. */
function deepest(kids: Map<string | null, TreeRecord[]>, id: string): string {
  let cur = id;
  for (;;) {
    const next = kids.get(cur)?.at(-1);
    if (!next) return cur;
    cur = next.id;
  }
}

export function threadRoutes(deps: ThreadRouteDeps) {
  const r = new Hono<AppEnv>();
  const { repo, runs } = deps;

  const thread = async (id: string) => {
    const t = await repo.getThread(id);
    if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That thread');
    return t;
  };

  const message = async (id: string) => {
    const m = await repo.getMessage(id);
    if (!m || m.deleted_at) throw notFound('That message');
    // Only messages in this workspace's threads (team-ready: ids alone are not access).
    const t = await repo.getThread(m.thread_id);
    if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That message');
    return m;
  };

  /** A run belongs here when its thread or its message does. */
  const run = async (id: string) => {
    const r = await runs.get(id);
    if (!r) throw notFound('That run');
    const threadId =
      r.threadId ?? (r.messageId ? (await repo.getMessage(r.messageId))?.thread_id : undefined);
    const t = threadId ? await repo.getThread(threadId) : undefined;
    if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That run');
    return r;
  };

  r.get('/threads', async (c) => {
    const q = ThreadListQuery.safeParse(c.req.query());
    if (!q.success) throw badRequest(q.error.issues[0]?.message ?? 'The query is not valid');
    const limit = q.data.limit ?? 100;
    const rows = await repo.listThreads(deps.workspaceId, {
      limit: limit + 1,
      cursor: q.data.cursor ?? null,
      archived: q.data.archived === '1',
      ...(q.data.notebook_id && { notebookId: q.data.notebook_id }),
    });
    const page = rows.slice(0, limit);
    const items: ThreadSummary[] = page.map((t) => ({
      ...threadOut(t),
      branches: Math.max(1, t.leaves),
      live: t.live,
    }));
    const last = page.at(-1);
    return c.json({ items, next_cursor: rows.length > limit && last ? cursorOf(last) : null });
  });

  // Before /threads/:id, which would otherwise take "search" as an id.
  r.get('/threads/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? 8) || 8));
    if (q.length < 2) return c.json({ items: [] });
    if (q.length > 400) throw badRequest('q: a search is limited to 400 characters');
    const hits = await repo.searchMessages(deps.workspaceId, q, limit);
    const items: ThreadSearchHit[] = hits.flatMap((h) => {
      const snippet = snippetOf(h.text, q);
      return snippet
        ? [
            {
              thread_id: h.thread_id,
              message_id: h.message_id,
              title: h.title,
              snippet,
              updated_at: h.updated_at,
            },
          ]
        : [];
    });
    return c.json({ items });
  });

  r.post('/threads', async (c) => {
    const req = await body(c, CreateThreadRequest);
    if (req.model) assertChatModel(deps.registry, req.model);
    const t = await repo.createThread({
      id: `thr_${ulid()}`,
      workspace_id: deps.workspaceId,
      ...(req.title !== undefined && { title: req.title }),
      notebook_id: req.notebook_id ?? null,
      settings: { model: req.model ?? null },
    });
    return c.json(threadOut(t), 201);
  });

  r.get('/threads/:id', async (c) => c.json(threadOut(await thread(c.req.param('id')))));

  r.patch('/threads/:id', async (c) => {
    const t = await thread(c.req.param('id'));
    const req = await body(c, PatchThreadRequest);
    if (req.active_head_id) {
      const m = await repo.getMessage(req.active_head_id);
      if (!m || m.thread_id !== t.id) throw notFound('That message');
    }
    if (req.model) assertChatModel(deps.registry, req.model);
    if (req.notebook_id && deps.notebookExists && !(await deps.notebookExists(req.notebook_id)))
      throw notFound('That notebook');
    // Flows (Phase 5b): the thread's own flow ('off' for none, null to follow the notebook) and its node overrides.
    const settings = {
      ...(req.model !== undefined && { model: req.model }),
      ...(req.flow_id !== undefined && { flow_id: req.flow_id }),
      ...(req.flow_overrides !== undefined && { flow_overrides: req.flow_overrides }),
      ...(req.flow_overrides_flow !== undefined && { flow_overrides_flow: req.flow_overrides_flow }),
    };
    const next = await repo.patchThread(t.id, {
      ...(req.title !== undefined && { title: req.title, title_source: 'user' as const }),
      ...(Object.keys(settings).length && { settings }),
      ...(req.active_head_id !== undefined && { active_head_id: req.active_head_id }),
      ...(req.pinned !== undefined && { pinned: req.pinned }),
      ...(req.archived !== undefined && { archived: req.archived }),
      ...(req.notebook_id !== undefined && { notebook_id: req.notebook_id }),
    });
    return c.json(threadOut(next ?? t));
  });

  r.delete('/threads/:id', async (c) => {
    const t = await thread(c.req.param('id'));
    for (const run of await runs.activeForThread(t.id)) await deps.worker.cancel(run.id);
    await repo.deleteThread(t.id);
    await deps.flowStore?.orphan('thread', t.id);
    return c.body(null, 204);
  });

  r.get('/threads/:id/path', async (c) => {
    const t = await thread(c.req.param('id'));
    const all = asTree(await repo.messages(t.id));
    const byId = new Map(all.map((m) => [m.id, m] as const));
    const kids = childrenIndex(all);
    const asked = c.req.query('head') ?? t.active_head_id;
    let head: string | null = null;
    // A named branch's head is where that branch ends, even before anything is
    // sent on it ("branch here"); ?exact=1 asks the same of any message.
    // Anything else follows the newest child down to its leaf.
    const pinned =
      c.req.query('exact') === '1' ||
      (!!asked &&
        !!deps.branches &&
        (await deps.branches.list(t.id)).some((b) => b.head_message_id === asked));
    if (asked && byId.has(asked)) head = pinned ? asked : deepest(kids, asked);
    else {
      const root = kids.get(null)?.at(-1) ?? all[0];
      if (root) head = deepest(kids, root.id);
    }
    const path = head ? ancestorPath(byId, head) : [];
    const live = (await runs.activeForThread(t.id))[0];
    const out: ThreadPath = {
      thread: threadOut(t),
      head_id: head,
      messages: path.map((m) => {
        const { index, count, ids } = siblingInfo(kids, m);
        return messageOut(m, { index, count, ids });
      }),
      active_run: live ? { id: live.id, message_id: live.messageId, status: live.status } : null,
    };
    return c.json(out);
  });

  r.post('/threads/:id/messages', async (c) => {
    const t = await thread(c.req.param('id'));
    const req = await body(c, SendMessageRequest);
    const started = await startTurn(deps, {
      thread: t,
      user: { parentId: req.parent_id, parts: userParts(req.parts) },
      model: req.model,
      ...(req.default_model && { defaultModel: req.default_model }),
      taskClass: req.task_class,
      mentions: req.mentions,
      ...(req.flow_id && { flowId: req.flow_id }),
    });
    return c.json(started, 202);
  });

  r.post('/messages/:id/regenerate', async (c) => {
    const m = await message(c.req.param('id'));
    if (m.role !== 'assistant' || !m.parent_id) throw notFound('That reply');
    const req = await body(c, RegenerateRequest);
    const t = await thread(m.thread_id);
    // Regenerate repeats how the reply was made (DESIGN.md §16.3):
    // - with a model chosen now: that model alone, no flow;
    // - a flow's reply: through that flow again ('same' replays its route);
    //   if the flow is gone, whatever answers the thread now;
    // - a plain reply: the model it asked for, if it can still answer,
    //   otherwise the thread's model, otherwise the default route.
    const recorded = (m.provenance as { flow?: { flow_id: string } } | null)?.flow;
    let model: string | null | undefined = req.model;
    let flowReplay: ReturnType<typeof replayFrom> = null;
    let routeAgain: { flowId: string } | null = null;
    if (!req.model && recorded) {
      if (req.route === 'same') flowReplay = replayFrom(m.provenance);
      else routeAgain = { flowId: recorded.flow_id };
    } else if (!req.model) {
      model = usableChatModel(deps.registry, m.requested_model_id)
        ? (m.requested_model_id ?? undefined)
        : usableChatModel(deps.registry, t.settings.model)
          ? undefined
          : null;
    }
    const started = await startTurn(deps, {
      thread: t,
      user: { existingId: m.parent_id },
      model,
      ...(flowReplay && { flowReplay }),
      ...(routeAgain && { routeAgain }),
    });
    return c.json(started, 202);
  });

  r.post('/messages/:id/edit', async (c) => {
    const m = await message(c.req.param('id'));
    if (m.role !== 'user') {
      throw new AncileError({
        code: 'request.invalid',
        title: 'Only your own messages can be edited',
        hint: 'Regenerate a reply instead.',
        status: 400,
        errorClass: 'permanent',
      });
    }
    const req = await body(c, EditMessageRequest);
    const t = await thread(m.thread_id);
    const started = await startTurn(deps, {
      thread: t,
      user: { parentId: m.parent_id, parts: userParts(req.parts), editOfId: m.id },
      model: req.model,
    });
    return c.json(started, 202);
  });

  r.post('/messages/:id/stop', async (c) => {
    const m = await message(c.req.param('id'));
    if (!m.run_id) return c.json({ status: m.status });
    const status = await deps.worker.cancel(m.run_id);
    return c.json({ run_id: m.run_id, status });
  });

  r.get('/runs/:id', async (c) => c.json(runOut(await run(c.req.param('id')))));

  r.post('/runs/:id/cancel', async (c) => {
    const id = (await run(c.req.param('id'))).id;
    const status = await deps.worker.cancel(id);
    if (status === null) throw notFound('That run');
    return c.json({ run_id: id, status });
  });

  return r;
}
