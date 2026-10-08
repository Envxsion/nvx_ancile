/**
 * ------------------------------------------------------------------
 *  Title    |  Branch, tree, compare, merge and compaction routes
 *  Ref      |  DESIGN.md §4.1 (Branches), §8
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The conversation as a tree you can see, name, compare,
 *           |  merge, trim and compact.
 *  How      |  Every route loads the thread's messages once and walks
 *           |  them with path.ts; nothing is copied except by merge,
 *           |  which makes a new thread. Subtree delete is soft and
 *           |  asks for the subtree size as confirmation; Undo works
 *           |  for 30 seconds and restores exactly that batch.
 *  Note     |  Undo batches live in this process: a Core restart
 *           |  inside the 30 seconds ends the chance to undo, which is
 *           |  the same promise the Cockpit makes.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type Branch,
  type BranchColor,
  BranchColor as BranchColors,
  CompactRequest,
  CompareBranchesRequest,
  CreateBranchRequest,
  type DeleteMessageResult,
  MergeThreadsRequest,
  PatchBranchRequest,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { AppEnv } from '../app';
import { currentContext, newTraceId } from '../context';
import { body } from '../http/body';
import { badRequest, notFound } from '../obs/errors';
import type { RunStore } from '../runs/engine';
import { alreadyRunning } from '../runs/store';
import type { BranchStore } from './branches';
import { compactPath, pathBudget } from './compact';
import { compareBranches } from './compare';
import { mergeBranches } from './merge';
import { ancestorPath, childrenIndex, snapBranchPoint } from './path';
import { asTree, type MessageRecord, type ThreadRepo, type TreeRecord } from './repo';
import { buildTree, deepestFrom } from './tree';
import type { UtilityDeps } from './utility';

export const UNDO_MS = 30_000;

export interface BranchRouteDeps extends UtilityDeps {
  workspaceId: string;
  repo: ThreadRepo;
  runs: RunStore;
  branches: BranchStore;
  now?: () => number;
}

export function branchFromStreaming(): AncileError {
  return new AncileError({
    code: 'branch.streaming',
    title: 'That reply is still being written',
    hint: 'Wait for it to finish or stop it, then branch. You can branch from the message before it now.',
    status: 409,
    errorClass: 'permanent',
  });
}

export function confirmDelete(count: number): AncileError {
  return new AncileError({
    code: 'message.confirm_delete',
    title: `This removes ${count} ${count === 1 ? 'message' : 'messages'}`,
    hint: 'Confirm with the number of messages to remove. You can undo for 30 seconds.',
    status: 409,
    errorClass: 'permanent',
    context: { subtree: count },
  });
}

export function undoExpired(): AncileError {
  return new AncileError({
    code: 'message.undo_expired',
    title: 'It is too late to undo that delete',
    hint: 'Undo works for 30 seconds after a delete.',
    status: 410,
    errorClass: 'permanent',
  });
}

export function restoreParentFirst(): AncileError {
  return new AncileError({
    code: 'message.restore_parent_first',
    title: 'Undo the later delete first',
    hint: 'These messages hang from one you deleted afterwards. Undo that delete, then this one.',
    status: 409,
    errorClass: 'permanent',
  });
}

const hasToolCall = (m: MessageRecord) => m.parts.some((p) => p.type === 'tool_call');

/** Every message under `id`, including it. */
export function subtreeOf(kids: Map<string | null, TreeRecord[]>, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    out.push(cur);
    for (const k of kids.get(cur) ?? []) stack.push(k.id);
  }
  return out;
}

export function nextColor(used: BranchColor[]): BranchColor {
  const ramp = BranchColors.options;
  return ramp.find((c) => !used.includes(c)) ?? (ramp[used.length % ramp.length] as BranchColor);
}

export function branchRoutes(deps: BranchRouteDeps) {
  const r = new Hono<AppEnv>();
  const { repo, branches } = deps;
  const now = deps.now ?? Date.now;
  const undo = new Map<string, { threadId: string; ids: string[]; until: number; head: string | null }>();

  const thread = async (id: string) => {
    const t = await repo.getThread(id);
    if (!t || t.workspace_id !== deps.workspaceId) throw notFound('That thread');
    return t;
  };

  const tree = async (threadId: string) => {
    const all = asTree(await repo.messages(threadId));
    return { all, byId: new Map(all.map((m) => [m.id, m] as const)), kids: childrenIndex(all) };
  };

  const headOf = (
    t: { active_head_id: string | null },
    kids: Map<string | null, TreeRecord[]>,
    byId: Map<string, TreeRecord>,
    asked?: string,
  ) => {
    const start =
      asked && byId.has(asked)
        ? asked
        : t.active_head_id && byId.has(t.active_head_id)
          ? t.active_head_id
          : (kids.get(null)?.at(-1)?.id ?? null);
    return start ? (asked ? start : deepestFrom(kids, start)) : null;
  };

  r.get('/threads/:id/tree', async (c) => {
    const t = await thread(c.req.param('id'));
    const msgs = await repo.messages(t.id);
    return c.json(buildTree(t.id, msgs, await branches.list(t.id), t.active_head_id));
  });

  r.get('/threads/:id/context-budget', async (c) => {
    const t = await thread(c.req.param('id'));
    const { byId, kids } = await tree(t.id);
    const head = headOf(t, kids, byId, c.req.query('head') ?? undefined);
    const model = deps.registry.chain('chat.default', c.req.query('model') ?? t.settings.model ?? null)[0];
    const path = head ? ancestorPath(byId, head) : [];
    return c.json(
      pathBudget({
        headId: head,
        path,
        summaries: await branches.summaries(t.id, 'compaction'),
        model,
        system: 600,
      }),
    );
  });

  r.post('/threads/:id/compact', async (c) => {
    const t = await thread(c.req.param('id'));
    const req = await body(c, CompactRequest);
    const { byId, kids } = await tree(t.id);
    const head = headOf(t, kids, byId, req.head);
    if (!head) throw badRequest('head: the thread has no messages yet');
    const result = await compactPath(deps, {
      threadId: t.id,
      messages: await repo.messages(t.id),
      headId: head,
      signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000)]),
    });
    return c.json(result, result.reused ? 200 : 201);
  });

  r.get('/threads/:id/branches', async (c) => {
    const t = await thread(c.req.param('id'));
    return c.json({ items: await branches.list(t.id, { archived: c.req.query('archived') === '1' }) });
  });

  r.post('/messages/:id/branch', async (c) => {
    const m = await repo.getMessage(c.req.param('id'));
    if (!m || m.deleted_at) throw notFound('That message');
    const t = await thread(m.thread_id);
    if (m.status === 'pending' || m.status === 'streaming') throw branchFromStreaming();
    const req = await body(c, CreateBranchRequest);
    const { all, kids } = await tree(t.id);
    const node = all.find((x) => x.id === m.id) as TreeRecord;
    const at = snapBranchPoint(kids as Map<string | null, (TreeRecord & { hasToolCall?: boolean })[]>, {
      ...node,
      hasToolCall: hasToolCall(node),
    });
    const existing = await branches.list(t.id, { archived: true });
    const b: Branch = await branches.create({
      id: `brn_${ulid()}`,
      thread_id: t.id,
      name: req.name ?? `Branch ${existing.length + 1}`,
      color: req.color ?? nextColor(existing.filter((x) => !x.archived_at).map((x) => x.color)),
      head_message_id: at,
      fork_message_id: at,
      created_by: req.created_by ?? 'user',
    });
    return c.json(b, 201);
  });

  r.patch('/branches/:id', async (c) => {
    const b = await branches.get(c.req.param('id'));
    if (!b) throw notFound('That branch');
    await thread(b.thread_id);
    const req = await body(c, PatchBranchRequest);
    const next = await branches.patch(b.id, {
      ...(req.name !== undefined && { name: req.name }),
      ...(req.color !== undefined && { color: req.color }),
      ...(req.archived !== undefined && { archived: req.archived }),
    });
    return c.json(next ?? b);
  });

  r.post('/threads/:id/compare', async (c) => {
    const t = await thread(c.req.param('id'));
    const req = await body(c, CompareBranchesRequest);
    const msgs = await repo.messages(t.id);
    const ids = new Set(msgs.map((m) => m.id));
    if (!ids.has(req.a) || !ids.has(req.b))
      throw badRequest('a, b: both heads must be messages in this thread');
    return c.json(
      await compareBranches(deps, {
        threadId: t.id,
        messages: msgs,
        summaries: await branches.summaries(t.id, 'compaction'),
        a: req.a,
        b: req.b,
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000)]),
      }),
    );
  });

  r.post('/merge', async (c) => {
    const req = await body(c, MergeThreadsRequest);
    const t = await thread(req.thread_id);
    const result = await mergeBranches(deps, {
      thread: t,
      messages: await repo.messages(t.id),
      req,
      traceId: currentContext()?.traceId ?? newTraceId(),
      signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(120_000)]),
    });
    return c.json(result, 201);
  });

  r.delete('/messages/:id', async (c) => {
    const m = await repo.getMessage(c.req.param('id'));
    if (!m || m.deleted_at) throw notFound('That message');
    const t = await thread(m.thread_id);
    const { kids } = await tree(t.id);
    const ids = subtreeOf(kids, m.id);
    const confirm = Number(c.req.query('confirm'));
    if (confirm !== ids.length) throw confirmDelete(ids.length);
    const live = await deps.runs.activeForThread(t.id);
    const inside = new Set(ids);
    const running = live.find((run) => run.messageId && inside.has(run.messageId));
    if (running) throw alreadyRunning(running.id);

    await repo.discardMessages(ids);
    let head = t.active_head_id;
    if (head && inside.has(head)) {
      head = m.parent_id;
      if (head) await repo.patchThread(t.id, { active_head_id: head });
    }
    const until = now() + UNDO_MS;
    undo.set(m.id, { threadId: t.id, ids, until, head: t.active_head_id });
    for (const [k, v] of undo) if (v.until < now()) undo.delete(k);
    const out: DeleteMessageResult = {
      deleted: ids.length,
      undo_until: new Date(until).toISOString(),
      head_id: head,
    };
    return c.json(out);
  });

  r.post('/messages/:id/restore', async (c) => {
    const id = c.req.param('id');
    const batch = undo.get(id);
    if (!batch || batch.until < now()) {
      undo.delete(id);
      throw undoExpired();
    }
    await thread(batch.threadId);
    // A later delete may have taken this subtree's parent: restoring now
    // would leave messages hanging from nothing.
    const top = await repo.getMessage(id);
    const parent = top?.parent_id ? await repo.getMessage(top.parent_id) : null;
    if (parent?.deleted_at) throw restoreParentFirst();
    await repo.restoreMessages(batch.ids);
    if (batch.head) await repo.patchThread(batch.threadId, { active_head_id: batch.head });
    undo.delete(id);
    return c.json({ restored: batch.ids.length, head_id: batch.head });
  });

  return r;
}
