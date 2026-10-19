/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: the gateway and Claude Code as adapters
 *  Ref      |  docs/engines.md · contracts engines.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One front door for a turn in any thread with any model:
 *           |  choose the engine (select.ts), check the scope, and
 *           |  start the turn through that engine's own path.
 *  How      |  GatewayEngine wraps the conductor's startTurn (every
 *           |  configured model, Claude Code as a model included).
 *           |  ClaudeCodeEngine wraps the live session layer
 *           |  (claudecode/live.ts), whose engine hooks (claude.ts)
 *           |  plan the context. More engines register as adapters.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  CLAUDE_CODE_CONTEXT_NOTICE,
  CLAUDE_CODE_MODEL_PREFIX,
  type EffectiveScope,
  type EngineInfo,
  type FilePart,
  type ImagePart,
  type SendClaudeCodeRequest,
  type SendClaudeCodeResult,
  type SendTurnOutcome,
  type SendTurnResult,
} from '@nvx/contracts';
import type { Sql } from 'postgres';
import { claudeCodeFiles, goneOrOther } from '../attachments/service';
import { applyTrim, type TrimQuery, type TrimResult } from '../attachments/trim';
import type { ClaudeCodeLive } from '../claudecode/live';
import type { ModelRegistry } from '../gateway/registry';
import { getEffectiveScope, type ScopeStore } from '../scopes';
import type { ThreadRecord } from '../threads/repo';
import { startTurn, type TurnDeps } from '../threads/service';
import { assertAllowed, selectEngine } from './select';
import type { Engine, EngineStatus, EngineTurn } from './types';

/** What a caller asks for: the turn, before the engine and its model are chosen. */
type TurnRequest = Omit<EngineTurn, 'thread' | 'modelId' | 'requestedModelId' | 'images' | 'files'> & {
  model: string | null;
  imageIds?: string[];
  attachmentIds?: string[];
};

export type { Engine, EngineTurn } from './types';

/** The thread's effective scope, read from the database at send time (scopes/getEffectiveScope). */
export const scopeFromDb =
  (db: ScopeStore | Sql) =>
  (t: Pick<ThreadRecord, 'id' | 'notebook_id'>): Promise<EffectiveScope> =>
    getEffectiveScope(db, { threadId: t.id, notebookId: t.notebook_id });

export class GatewayEngine implements Engine {
  readonly id = 'gateway';
  readonly kind = 'gateway';
  readonly displayName = 'NVX Ancile models';
  readonly modelPrefix = null;
  constructor(private readonly deps: TurnDeps) {}

  capabilities(modelId?: string | null) {
    const m = modelId ? this.deps.registry.get(modelId) : undefined;
    return {
      streaming: true,
      tools: m ? m.capabilities.includes('tools') : true,
      images: m ? m.capabilities.includes('vision') : false,
      own_context: false,
      context_window: m?.context_window ?? null,
    };
  }

  async status(): Promise<EngineStatus> {
    const ready = this.deps.registry.all().some((m) => this.deps.registry.status(m) === 'ready');
    return ready
      ? { available: true, reason: null }
      : { available: false, reason: 'No model is ready: add a key in Settings → Models' };
  }

  async start(t: EngineTurn) {
    const parentId = t.parentId === undefined ? (t.thread.active_head_id ?? null) : t.parentId;
    const r = await startTurn(this.deps, {
      thread: t.thread,
      user: { parentId, parts: [{ type: 'text', text: t.text }, ...(t.files ?? []), ...(t.images ?? [])] },
      ...(t.modelId !== null && { model: t.modelId }),
      ...(t.taskClass && { taskClass: t.taskClass }),
      mentions: (t.sourceIds ?? []).map((id) => ({ kind: 'source' as const, id })),
    });
    return {
      run_id: r.run_id,
      user_message_id: r.user_message_id,
      assistant_message_id: r.assistant_message_id,
      model_id: t.requestedModelId,
    };
  }
}

export class ClaudeCodeEngine implements Engine {
  readonly id = 'claude_code';
  readonly kind = 'claude_code';
  readonly displayName = 'Claude Code';
  readonly modelPrefix = CLAUDE_CODE_MODEL_PREFIX;
  constructor(
    private readonly deps: {
      live: () => ClaudeCodeLive | null;
      installed: () => Promise<EngineStatus>;
    },
  ) {}

  capabilities() {
    // Claude Code takes image input in its prompt (the bridge's image content blocks).
    return { streaming: true, tools: true, images: true, own_context: true, context_window: null };
  }

  status() {
    return this.deps.installed();
  }

  async waitingFor(thread: ThreadRecord) {
    return (await this.deps.live()?.waitingFor(thread)) ?? null;
  }

  resumeCommand(thread: ThreadRecord) {
    return this.deps.live()?.resumeCommand(thread) ?? null;
  }

  async startOrQueue(t: EngineTurn) {
    const live = this.deps.live();
    if (!live) throw new Error('live Claude Code sessions are not running in this Core');
    const r = await live.sendOrQueue(t.thread.id, { ...this.request(t), queue_if_busy: true });
    return 'queued' in r ? r : this.result(t, r);
  }

  async start(t: EngineTurn) {
    const live = this.deps.live();
    if (!live) throw new Error('live Claude Code sessions are not running in this Core');
    return this.result(t, await live.send(t.thread.id, this.request(t)));
  }

  private request(t: EngineTurn): SendClaudeCodeRequest {
    return {
      text: t.text,
      ...(t.parentId !== undefined && { parent_id: t.parentId }),
      ...(t.modelId && { model: t.modelId }),
      ...(t.effort && { effort: t.effort }),
      ...(t.sourceIds?.length && { source_ids: t.sourceIds }),
      ...(t.images?.length && { image_ids: t.images.flatMap((p) => (p.image_id ? [p.image_id] : [])) }),
      ...(t.asBranch && { as_branch: true }),
      idempotency_key: t.idempotencyKey,
    };
  }

  private result(t: EngineTurn, r: SendClaudeCodeResult) {
    return {
      run_id: r.run_id,
      user_message_id: r.user_message_id,
      assistant_message_id: r.assistant_message_id,
      model_id: t.requestedModelId,
      context_notice: r.context_shared ? (r.context_notice ?? CLAUDE_CODE_CONTEXT_NOTICE) : null,
      ...(r.branched && { branched: r.branched }),
    };
  }
}

export interface EnginesDeps {
  registry: Pick<ModelRegistry, 'get' | 'chain'>;
  gateway: Engine;
  claudeCode: Engine;
  /** The thread's effective scope (scopes/getEffectiveScope). */
  scopeOf: (thread: ThreadRecord) => Promise<EffectiveScope>;
  /** A turn's attached images (images/service.ts). */
  images?: { partsFor(threadId: string, ids: string[]): Promise<ImagePart[]> };
  /** A turn's attached files (attachments/service.ts, CH6). */
  attachments?: {
    partsFor(threadId: string, ids: string[]): FilePart[];
    release(ids: string[]): void;
    /** Page spans for Pro's page trimming; absent where nothing can trim. */
    pagesFor?(threadId: string, ids: string[]): Omit<TrimQuery['files'][number], 'name' | 'text'>[];
  };
  /**
   * CH6 (Pro): keep the relevant pages of attached files when the message is over the model's budget.
   * Absent in the free build; an error or a null answer sends the files whole.
   */
  trimAttachments?: (q: TrimQuery) => Promise<TrimResult | null>;
}

/** The model chosen cannot see images: say so plainly instead of sending them as nothing. */
export function noVision(model: string | null): AncileError {
  return new AncileError({
    code: 'image.model_no_vision',
    title: `${model ?? 'The model answering here'} can't see images.`,
    hint: 'Choose a model that reads images (marked vision in Admin → Models), or send the message without them.',
    status: 422,
    errorClass: 'permanent',
  });
}

/** The engines a thread can use, and the one front door for a turn. */
export class Engines {
  constructor(private readonly deps: EnginesDeps) {}

  /** CH6: ask Pro to keep the relevant pages when the files are over budget. Never stops a send. */
  private async trimmed(
    thread: ThreadRecord,
    req: Pick<TurnRequest, 'text' | 'parentId'>,
    modelId: string | null,
    ids: string[],
    files: FilePart[],
  ): Promise<FilePart[]> {
    const { trimAttachments, attachments, registry } = this.deps;
    const pages = attachments?.pagesFor?.(thread.id, ids);
    if (!trimAttachments || !pages || pages.length !== files.length) return files;
    try {
      const result = await trimAttachments({
        threadId: thread.id,
        notebookId: thread.notebook_id,
        message: req.text,
        parentId: req.parentId === undefined ? (thread.active_head_id ?? null) : req.parentId,
        contextWindow: (modelId ? registry.get(modelId)?.context_window : null) ?? null,
        files: pages.map((p, i) => ({
          ...p,
          name: files[i]?.name ?? '',
          text: files[i]?.text ?? '',
        })),
      });
      return result?.length ? applyTrim(files, ids, result) : files;
    } catch {
      // Whole files go: a failed trim must not stop the message.
      return files;
    }
  }

  list(): Engine[] {
    return [this.deps.gateway, this.deps.claudeCode];
  }

  async info(): Promise<EngineInfo[]> {
    return Promise.all(
      this.list().map(async (e) => {
        const s = await e.status().catch((err: unknown) => ({
          available: false,
          reason: (err as Error).message || 'It could not be checked',
        }));
        return {
          id: e.id,
          kind: e.kind,
          display_name: e.displayName,
          available: s.available,
          reason: s.reason,
          capabilities: e.capabilities(),
          model_prefix: e.modelPrefix,
        };
      }),
    );
  }

  /** Throws an AncileError when the thread's scope refuses Claude Code. */
  async allowClaude(thread: ThreadRecord, modelId: string | null): Promise<void> {
    await assertAllowed(this.deps.scopeOf, thread, {
      engine: 'claude_code',
      checkModel: modelId,
      local: false,
    });
  }

  async send(thread: ThreadRecord, req: TurnRequest): Promise<SendTurnResult> {
    const r = await this.run(thread, { ...req, queueIfBusy: false });
    if ('queued' in r) throw new Error('a turn sent without queue_if_busy never waits');
    return r;
  }

  /** Send, or wait while a CLI session is busy (answering, or open in a terminal): CC6. */
  sendOrQueue(thread: ThreadRecord, req: TurnRequest): Promise<SendTurnOutcome> {
    return this.run(thread, { ...req, queueIfBusy: true });
  }

  private async run(thread: ThreadRecord, req: TurnRequest): Promise<SendTurnOutcome> {
    const s = selectEngine(thread, req.model, {
      registry: this.deps.registry,
      ...(req.taskClass && { taskClass: req.taskClass }),
    });
    // The scope first: an image goes wherever the turn goes, so the engine and model checks cover it.
    await assertAllowed(this.deps.scopeOf, thread, s);
    const engine = s.mode === 'session' ? this.deps.claudeCode : this.deps.gateway;
    const { imageIds, attachmentIds, ...rest } = req;
    // Files for this message only (CH6). Claude Code reads files from its folder, so it is given a path instead.
    let files: FilePart[] = [];
    if (attachmentIds?.length) {
      if (engine === this.deps.claudeCode) throw claudeCodeFiles();
      if (!this.deps.attachments) throw goneOrOther();
      files = this.deps.attachments.partsFor(thread.id, attachmentIds);
      files = await this.trimmed(thread, req, s.checkModel, attachmentIds, files);
    }
    let images: ImagePart[] = [];
    if (imageIds?.length) {
      if (!this.deps.images || !engine.capabilities(s.checkModel).images) throw noVision(s.checkModel);
      images = await this.deps.images.partsFor(thread.id, imageIds);
    }
    const turn: EngineTurn = {
      ...rest,
      ...(images.length && { images }),
      ...(files.length && { files }),
      thread,
      modelId: s.mode === 'session' ? s.engineModel : s.modelId,
      requestedModelId: s.modelId,
    };
    // A CLI session that is busy (answering, or open in a terminal): the turn waits its turn (CC6).
    const r =
      req.queueIfBusy && engine.startOrQueue ? await engine.startOrQueue(turn) : await engine.start(turn);
    if (attachmentIds?.length) this.deps.attachments?.release(attachmentIds);
    if ('queued' in r) return r;
    return { ...r, engine: s.engine, context_notice: r.context_notice ?? null };
  }
}
