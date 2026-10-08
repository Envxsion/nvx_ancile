/**
 * ------------------------------------------------------------------
 *  Title    |  Starting turns
 *  Ref      |  DESIGN.md §8 (send, regenerate, edit)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Send, regenerate and edit all end the same way: a user
 *           |  message (new, reused or edited), an empty assistant
 *           |  reply under it, the thread's head moved to that reply,
 *           |  and a queued chat_turn run that will fill it in.
 *  How      |  One function, startTurn(), so the three routes cannot
 *           |  drift. A thread that is already answering refuses a
 *           |  second turn (run.already_running) instead of racing: the
 *           |  run store allows one live run per thread, atomically, so
 *           |  two sends at once cannot both win. The loser's messages
 *           |  are discarded.
 * ------------------------------------------------------------------
 */

import { AncileError, type ModelConfig, type Part } from '@nvx/contracts';
import { ulid } from 'ulid';
import { initialCheckpoint, titleFrom } from '../conductor/pipeline';
import { currentContext, newTraceId } from '../context';
import { canChat, type ModelRegistry } from '../gateway/registry';
import { notFound } from '../obs/errors';
import type { ReplayInput } from '../obs/replay';
import type { RunStore } from '../runs/engine';
import { alreadyRunning } from '../runs/store';
import type { RunWorker } from '../runs/worker';
import type { BranchStore } from './branches';
import type { ThreadRecord, ThreadRepo } from './repo';

export interface TurnDeps {
  repo: ThreadRepo;
  runs: RunStore;
  worker: Pick<RunWorker, 'kick'>;
  registry: ModelRegistry;
  /** Named branches follow their tip as turns are answered on them. */
  branches?: Pick<BranchStore, 'advance' | 'list'>;
  /** After a new message is sent (not regenerate): the topic-shift detector. Never awaited. */
  afterSend?: (thread: ThreadRecord, userMessageId: string) => Promise<void>;
}

export interface StartTurn {
  thread: ThreadRecord;
  /** An existing user message to answer (regenerate), or a new one to create. */
  user: { existingId: string } | { parentId: string | null; parts: Part[]; editOfId?: string | null };
  model?: string | null | undefined;
  /** Plain chat only: used when no flow, message model or thread model decides. */
  defaultModel?: string;
  taskClass?: string;
  /** @-mentions from the composer: sources narrow retrieval, a notebook grounds a loose thread. */
  mentions?: { kind: string; id: string }[];
  /** A re-run from a recorded run (Phase 5): its tools are answered from the record. */
  replay?: ReplayInput;
  /** Parts the new answer starts with (the steps a re-run keeps). */
  seedParts?: Part[];
  /** Flows (Phase 5b): this message's own flow (`@flow`). */
  flowId?: string;
  /** Flows: repeat a recorded route (regenerate, same route). */
  flowReplay?: import('../flows/turn').FlowReplay | null;
  /** Flows: answer through this flow version (route again). */
  routeAgain?: import('../flows/turn').RouteAgain;
}

export interface StartedTurn {
  run_id: string;
  user_message_id: string;
  assistant_message_id: string;
  stream_url: string;
}

export function modelNotReady(id: string, status: string): AncileError {
  return new AncileError({
    code: 'model.not_configured',
    title: status === 'needs_key' ? `${id} has no key yet` : `${id} is switched off`,
    hint:
      status === 'needs_key'
        ? 'Add its key in Settings → Models, or pick another model.'
        : 'Turn it on in Settings → Models, or pick another model.',
    status: 422,
    errorClass: 'permanent',
  });
}

export function modelNotChat(m: ModelConfig): AncileError {
  return new AncileError({
    code: 'model.not_chat',
    title: `${m.display_name} can't answer messages`,
    hint: 'It is an embedding or rerank model. Pick a chat model in the model switcher.',
    status: 422,
    errorClass: 'permanent',
  });
}

/** A model a person picked must exist, be a chat model, and be ready. */
export function assertChatModel(registry: ModelRegistry, id: string): ModelConfig {
  const m = registry.get(id);
  if (!m)
    throw new AncileError({
      code: 'request.not_found',
      title: `There is no model called ${id}`,
      hint: 'Pick one from the model switcher.',
      status: 404,
      errorClass: 'permanent',
    });
  if (!canChat(m)) throw modelNotChat(m);
  const status = registry.status(m);
  if (status !== 'ready') throw modelNotReady(m.display_name, status);
  return m;
}

/** True when a turn could use this model now (regenerate falls back when it cannot). */
export function usableChatModel(registry: ModelRegistry, id: string | null | undefined): boolean {
  const m = id ? registry.get(id) : undefined;
  return !!m && canChat(m) && registry.status(m) === 'ready';
}

export async function startTurn(deps: TurnDeps, req: StartTurn): Promise<StartedTurn> {
  const { repo, runs, registry } = deps;
  const thread = req.thread;
  const traceId = currentContext()?.traceId ?? newTraceId();

  // Fast refusal before writing anything; create() below is the atomic check.
  const active = await runs.activeForThread(thread.id);
  if (active.length) throw alreadyRunning(active[0]?.id);

  // A model chosen for this message beats any flow; the thread's model only
  // answers when no flow does (DESIGN.md §16.3).
  const fallback = req.defaultModel && usableChatModel(registry, req.defaultModel) ? req.defaultModel : null;
  // A thread's model that can no longer answer (its key removed, switched
  // off, or the model deleted) is passed over, never a reason to refuse the
  // message; a model picked for this message still has to be able to answer.
  const saved = thread.settings.model ?? null;
  const threadModel = saved && usableChatModel(registry, saved) ? saved : null;
  const explicit = req.model === undefined ? (threadModel ?? fallback) : req.model;
  const modelFrom = req.model ? 'message' : threadModel ? 'thread' : null;
  if (explicit) assertChatModel(registry, explicit);

  const written: string[] = [];
  let userId: string;
  if ('existingId' in req.user) {
    userId = req.user.existingId;
  } else {
    const parentId = req.user.parentId;
    if (parentId) {
      const parent = await repo.getMessage(parentId);
      if (!parent || parent.thread_id !== thread.id || parent.deleted_at)
        throw notFound('The message you replied to');
    }
    userId = `msg_${ulid()}`;
    await repo.insertMessage({
      id: userId,
      thread_id: thread.id,
      parent_id: parentId,
      role: 'user',
      parts: req.user.parts,
      status: 'complete',
      edit_of_id: req.user.editOfId ?? null,
      trace_id: traceId,
    });
    written.push(userId);
  }

  const sourceIds = (req.mentions ?? []).filter((m) => m.kind === 'source').map((m) => m.id);
  const assistantId = `msg_${ulid()}`;
  const runId = `run_${ulid()}`;
  await repo.insertMessage({
    id: assistantId,
    thread_id: thread.id,
    parent_id: userId,
    role: 'assistant',
    parts: req.seedParts ?? [],
    status: 'pending',
    requested_model_id: explicit,
    run_id: runId,
    trace_id: traceId,
  });
  written.push(assistantId);

  try {
    await runs.create({
      id: runId,
      kind: 'chat_turn',
      traceId,
      threadId: thread.id,
      messageId: assistantId,
      checkpoint: initialCheckpoint({
        threadId: thread.id,
        workspaceId: thread.workspace_id,
        notebookId: thread.notebook_id ?? req.mentions?.find((m) => m.kind === 'notebook')?.id ?? null,
        ...(sourceIds.length && { sourceIds }),
        userMessageId: userId,
        assistantMessageId: assistantId,
        explicitModel: explicit,
        modelFrom,
        ...(saved && !threadModel && req.model === undefined && { threadModelUnready: saved }),
        taskClass: req.taskClass ?? 'chat.default',
        ...(req.replay && { replay: req.replay }),
        ...(req.seedParts?.length && { seedParts: req.seedParts }),
        ...(req.flowId && { flowId: req.flowId }),
        ...(req.flowReplay && { flowReplay: req.flowReplay }),
        ...(req.routeAgain && { routeAgain: req.routeAgain }),
      }),
    });
  } catch (err) {
    // Another send won the thread a moment ago: leave no trace of this one.
    await repo.discardMessages(written);
    throw err;
  }
  await repo.patchThread(thread.id, { active_head_id: assistantId, root_message_id: userId });
  // A name on the message this turn continues from moves to the new reply.
  const from = 'existingId' in req.user ? [userId] : req.user.parentId ? [req.user.parentId] : [];
  await deps.branches?.advance(thread.id, from, assistantId);
  if (!('existingId' in req.user) && thread.title_source === 'auto' && thread.title === 'New thread') {
    await repo.patchThread(thread.id, { title: titleFrom(req.user.parts) });
  }
  deps.worker.kick();
  if (!('existingId' in req.user) && !req.user.editOfId && deps.afterSend)
    void deps.afterSend(thread, userId).catch(() => undefined);

  return {
    run_id: runId,
    user_message_id: userId,
    assistant_message_id: assistantId,
    stream_url: `/api/v1/runs/${runId}/stream`,
  };
}
