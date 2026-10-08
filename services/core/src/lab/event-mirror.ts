/**
 * ------------------------------------------------------------------
 *  Title    |  Lab event mirror and permission bridge
 *  Ref      |  DESIGN.md §1.4, §5; vendor/opencode/PATCHES.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The one listener on the engine's event stream. For each
 *           |  lab session Core started it (a) mirrors text, tool steps
 *           |  and usage into the run's event log, so a lab answer
 *           |  streams into the thread exactly like a chat answer, and
 *           |  (b) answers every permission request through Core's
 *           |  gate: allowed → "once", denied → "reject" with the
 *           |  reason, otherwise an approval in Ancile's dialog whose
 *           |  answer is relayed back.
 *  How      |  Core never replies "always": what is remembered lives
 *           |  in Core's grants, so the engine asks again next time and
 *           |  Core answers from its grant. Parts of user messages are
 *           |  skipped (roles come from message.updated). A request for
 *           |  a session Core did not start is rejected.
 *  Note     |  After a restart attach() re-reads the engine's pending
 *           |  requests, reusing an approval that is already waiting.
 *           |  A session that went idle while nobody was listening (a
 *           |  restart, a dropped event stream) is caught up from the
 *           |  engine's own message list by check(). wait() never hangs:
 *           |  Stop ends it at once and a deadline ends it with an error.
 *           |  TODO(phase-5): treat a "permission.replied" with "always"
 *           |  that Core did not send as a tamper signal.
 * ------------------------------------------------------------------
 */

import { AncileError, type Part } from '@nvx/contracts';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import type { Gate } from '../permissions/gate';
import { APPROVAL_TTL_MS } from '../permissions/reconcile';
import type { ApprovalRecord, PermissionStore } from '../permissions/store';
import type { RunEventLog } from '../runs/events';
import type { Engine, EngineEvent, PendingPermission } from './engine-client';
import { type LabPlace, mapAsk } from './permission-map';

const log = logFor('lab');

export const LAB_PRINCIPAL = 'agent:lab';

export interface LabTurn {
  runId: string;
  traceId: string;
  threadId: string;
  workspaceId: string;
  /** The Ancile message this run is writing. */
  messageId: string;
  sessionId: string;
  place: LabPlace;
}

export interface LabOutcome {
  status: 'complete' | 'error' | 'stopped';
  parts: Part[];
  usage: { input: number; output: number; costUsd: number };
  error: { title: string; hint: string; code?: string } | null;
  /** The engine's id for the prompt this run sent: undo reverts to it. */
  promptMessageId: string | null;
}

interface PartState {
  kind: 'text' | 'reasoning' | 'tool';
  text: string;
  call?: { callId: string; tool: string; args: unknown };
  result?: { ok: boolean; output: unknown };
}

interface Live {
  turn: LabTurn;
  roles: Map<string, 'user' | 'assistant'>;
  held: Map<string, EngineEvent[]>; // events for messages whose role is not known yet
  parts: Map<string, PartState>;
  started: boolean;
  promptMessageId: string | null;
  usage: { input: number; output: number; costUsd: number };
  error: { title: string; hint: string; aborted: boolean } | null;
  done: ((o: LabOutcome) => void) | null;
  outcome: LabOutcome | null;
  seq: number;
}

export interface MirrorDeps {
  engine: Engine;
  events: RunEventLog;
  gate: Gate;
  permissions: PermissionStore;
  bus?: EventBus;
  userId: string;
  /** How long a question waits for an answer before it expires (default 24 h). */
  approvalTtlMs?: number;
}

const MAX_RESULT = 4_000;

function clip(v: unknown): unknown {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}…` : v;
}

function preview(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > 280 ? `${s.slice(0, 280)}…` : s;
}

const ERROR_WORDS: Record<string, { title: string; hint: string }> = {
  ProviderAuthError: {
    title: 'The lab could not reach a model',
    hint: 'Check your provider keys in Settings → Models.',
  },
  APIError: { title: 'The model behind the lab failed', hint: 'Try again; Ancile falls back where it can.' },
  ContextOverflowError: {
    title: 'The lab ran out of context',
    hint: 'Start a new thread for a fresh session.',
  },
  MessageOutputLengthError: { title: 'The lab hit its output limit', hint: 'Ask it to continue.' },
  ContentFilterError: { title: 'The model declined this', hint: 'Rephrase, or pick another model.' },
};

export function labTimedOut(ms: number): AncileError {
  const minutes = Math.round(ms / 60_000);
  return new AncileError({
    code: 'lab.timed_out',
    title: `The lab did not finish within ${minutes} minutes`,
    hint: 'It was stopped. Check what it changed, then run it again with a smaller task.',
    status: 504,
    errorClass: 'transient',
  });
}

export class LabMirror {
  private readonly live = new Map<string, Live>(); // by engine session id
  private readonly pending = new Map<string, { requestId: string; sessionId: string; directory: string }>(); // approval id → engine request
  private stopper: AbortController | null = null;

  constructor(private readonly deps: MirrorDeps) {}

  start(): void {
    if (this.stopper) return;
    this.stopper = new AbortController();
    void this.deps.engine
      .follow(
        (e) => void this.handle(e).catch((err) => log.error({ err }, 'lab event failed')),
        this.stopper.signal,
        // Events sent while the stream was down are lost: catch up from the engine.
        () => void this.checkAll(),
      )
      .catch((err) => log.error({ err }, 'lab event stream stopped'));
  }

  stop(): void {
    this.stopper?.abort();
    this.stopper = null;
  }

  /** Start mirroring a session for a run, and pick up any requests already waiting. */
  async attach(turn: LabTurn): Promise<void> {
    this.live.set(turn.sessionId, {
      turn,
      roles: new Map(),
      held: new Map(),
      parts: new Map(),
      started: false,
      promptMessageId: null,
      usage: { input: 0, output: 0, costUsd: 0 },
      error: null,
      done: null,
      outcome: null,
      seq: 1_000,
    });
    try {
      for (const p of await this.deps.engine.pendingPermissions(turn.place.realDir))
        if (p.sessionID === turn.sessionId) await this.bridge(p);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not read the lab’s pending requests');
    }
  }

  /** Stop mirroring a session. Questions it left open are withdrawn: nobody can act on them now. */
  async detach(sessionId: string): Promise<void> {
    const l = this.live.get(sessionId);
    this.live.delete(sessionId);
    for (const [id, p] of this.pending) if (p.sessionId === sessionId) this.pending.delete(id);
    if (!l) return;
    const cancelled = await this.deps.permissions.cancelApprovalsForRun(l.turn.runId);
    for (const id of cancelled)
      await this.deps.bus?.publish({ type: 'approval.resolved', approval_id: id }).catch(() => undefined);
  }

  /**
   * Resolves when the session goes idle after this run's prompt (or fails).
   * A Stop (the signal) resolves at once as stopped, even when the engine is
   * down; the deadline rejects with lab.timed_out.
   */
  wait(sessionId: string, opts: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<LabOutcome> {
    const l = this.live.get(sessionId);
    if (!l) return Promise.reject(new Error(`lab session ${sessionId} is not attached`));
    if (l.outcome) return Promise.resolve(l.outcome);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        l.done = null;
      };
      const onAbort = () => {
        cleanup();
        resolve({
          status: 'stopped',
          parts: this.partsOf(l),
          usage: l.usage,
          error: null,
          promptMessageId: l.promptMessageId,
        });
      };
      l.done = (o) => {
        cleanup();
        resolve(o);
      };
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.deadlineMs) {
        timer = setTimeout(() => {
          cleanup();
          reject(labTimedOut(opts.deadlineMs as number));
        }, opts.deadlineMs);
        timer.unref?.();
      }
    });
  }

  /**
   * Ask the engine whether an attached session already finished while Core
   * was not listening; if it did, rebuild the answer from its messages and
   * finish. Only a completed answer counts, so a prompt that is still being
   * picked up is never mistaken for an idle session.
   */
  async check(sessionId: string): Promise<boolean> {
    const l = this.live.get(sessionId);
    if (!l || l.outcome || !l.started) return false;
    try {
      const busy = await this.deps.engine.statuses(l.turn.place.realDir);
      const state = busy[sessionId]?.type ?? 'idle';
      if (state !== 'idle') return false;
      const msgs = await this.deps.engine.messages(sessionId, l.turn.place.realDir);
      const lastUser = msgs.findLastIndex((m) => m.info.role === 'user');
      if (lastUser < 0) return false;
      const answer = msgs.slice(lastUser + 1).filter((m) => m.info.role === 'assistant');
      const last = answer.at(-1);
      if (!last || (!last.info.time?.completed && !last.info.error)) return false;
      l.promptMessageId ??= msgs[lastUser]?.info.id ?? null;
      for (const m of answer) {
        l.roles.set(m.info.id, 'assistant');
        for (const part of m.parts) await this.onPart(l, part);
        if (m.info.tokens)
          l.usage = {
            input: m.info.tokens.input ?? 0,
            output: m.info.tokens.output ?? 0,
            costUsd: m.info.cost ?? 0,
          };
        if (m.info.error) this.recordError(l, m.info.error);
      }
      this.finish(l);
      return true;
    } catch (err) {
      log.warn({ err: (err as Error).message, session: sessionId }, 'could not check a lab session');
      return false;
    }
  }

  private async checkAll(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.check(id);
  }

  /** Mark that the prompt was sent: from now on, idle means finished. */
  markStarted(sessionId: string): void {
    const l = this.live.get(sessionId);
    if (l) l.started = true;
  }

  /** Called when a person answers an approval: relay it to the engine. */
  async resolved(
    approval: ApprovalRecord,
    status: 'approved' | 'denied' | 'expired' | 'cancelled',
    reason?: string | null,
  ): Promise<boolean> {
    const p = this.pending.get(approval.id);
    if (!p) return false;
    this.pending.delete(approval.id);
    const ok = status === 'approved';
    try {
      await this.deps.engine.reply(
        p.requestId,
        p.directory,
        ok ? 'once' : 'reject',
        ok ? undefined : reason || 'The user declined this.',
      );
    } catch (err) {
      // The decision is saved; only the relay failed. Say so rather than fail the answer.
      log.error({ err, approval_id: approval.id }, 'could not pass the answer to the lab');
      await this.deps.bus
        ?.publish({
          type: 'notification',
          id: `ntf_lab_${approval.id}`,
          level: 'error',
          title: 'The lab did not get your answer',
          body: 'Your decision is saved, but the lab could not be told. Stop the lab run and start it again.',
          category: 'approvals',
        })
        .catch(() => undefined);
      return false;
    }
    await this.deps.events.append(approval.run_id, {
      type: 'approval.resolved',
      approval_id: approval.id,
      decision: ok ? 'approved' : status === 'expired' ? 'expired' : 'denied',
    });
    return true;
  }

  private emit(l: Live, e: Parameters<RunEventLog['append']>[1]) {
    return this.deps.events.append(l.turn.runId, e);
  }

  private async handle(e: EngineEvent): Promise<void> {
    const p = e.properties;
    const sessionId =
      (p.sessionID as string | undefined) ??
      (p.info as { sessionID?: string } | undefined)?.sessionID ??
      (p.part as { sessionID?: string } | undefined)?.sessionID;
    if (e.type === 'permission.asked') {
      await this.bridge(p as unknown as PendingPermission);
      return;
    }
    const l = sessionId ? this.live.get(sessionId) : undefined;
    if (!l) return;

    switch (e.type) {
      case 'message.updated': {
        const info = p.info as {
          id: string;
          role: 'user' | 'assistant';
          tokens?: { input?: number; output?: number };
          cost?: number;
          error?: { name?: string; data?: { message?: string } };
        };
        if (!l.roles.has(info.id)) {
          l.roles.set(info.id, info.role);
          if (info.role === 'user' && l.started && !l.promptMessageId) l.promptMessageId = info.id;
          for (const held of l.held.get(info.id) ?? []) await this.handle(held);
          l.held.delete(info.id);
        }
        if (info.role === 'assistant') {
          if (info.tokens)
            l.usage = {
              input: info.tokens.input ?? 0,
              output: info.tokens.output ?? 0,
              costUsd: info.cost ?? 0,
            };
          if (info.error) this.recordError(l, info.error);
        }
        return;
      }
      case 'message.part.updated':
      case 'message.part.delta': {
        const messageId = (
          e.type === 'message.part.delta' ? p.messageID : (p.part as { messageID?: string }).messageID
        ) as string;
        const role = l.roles.get(messageId);
        if (!role) {
          l.held.set(messageId, [...(l.held.get(messageId) ?? []), e]);
          return;
        }
        if (role !== 'assistant' || !l.started) return;
        if (e.type === 'message.part.delta')
          await this.onDelta(l, p.partID as string, p.field as string, p.delta as string);
        else await this.onPart(l, p.part as Record<string, unknown>);
        return;
      }
      case 'session.status':
        if ((p.status as { type?: string })?.type === 'busy') l.started = true;
        return;
      case 'session.error':
        this.recordError(l, p.error as { name?: string; data?: { message?: string } });
        return;
      case 'session.idle':
        if (l.started) this.finish(l);
        return;
      default:
        return;
    }
  }

  private recordError(l: Live, err: { name?: string; data?: { message?: string } } | undefined) {
    if (!err) return;
    const aborted = err.name === 'MessageAbortedError';
    const known = err.name ? ERROR_WORDS[err.name] : undefined;
    const words = known ?? {
      title: 'The lab stopped with an error',
      hint: err.data?.message ?? 'Try again.',
    };
    l.error = { ...words, aborted };
  }

  private async onDelta(l: Live, partId: string, field: string, delta: string) {
    if (field !== 'text' || !delta) return;
    const s = l.parts.get(partId) ?? { kind: 'text' as const, text: '' };
    s.text += delta;
    l.parts.set(partId, s);
    if (s.kind !== 'tool')
      await this.emit(l, {
        type: s.kind === 'reasoning' ? 'reasoning.delta' : 'text.delta',
        message_id: l.turn.messageId,
        delta,
      });
  }

  private async onPart(l: Live, part: Record<string, unknown>) {
    const id = part.id as string;
    const type = part.type as string;
    if (type === 'text' || type === 'reasoning') {
      const s = l.parts.get(id) ?? { kind: type, text: '' };
      s.kind = type;
      const full = (part.text as string | undefined) ?? '';
      if (full.length > s.text.length && full.startsWith(s.text)) {
        const delta = full.slice(s.text.length);
        s.text = full;
        l.parts.set(id, s);
        await this.emit(l, {
          type: type === 'reasoning' ? 'reasoning.delta' : 'text.delta',
          message_id: l.turn.messageId,
          delta,
        });
      } else {
        l.parts.set(id, s);
      }
      return;
    }
    if (type !== 'tool') return;
    const state = part.state as { status: string; input?: unknown; output?: unknown; error?: unknown };
    const tool = part.tool as string;
    const callId = part.callID as string;
    let s = l.parts.get(id);
    if (!s) {
      s = { kind: 'tool', text: '', call: { callId, tool, args: state.input ?? {} } };
      l.parts.set(id, s);
      const tier = mapAsk({ permission: tool, patterns: [], metadata: {} }, l.turn.place).tier;
      await this.emit(l, { type: 'tool.call', call_id: callId, tool, args_preview: state.input ?? {}, tier });
    } else if (s.call && state.input !== undefined) s.call.args = state.input;
    if (!s.result && (state.status === 'completed' || state.status === 'error')) {
      const ok = state.status === 'completed';
      s.result = { ok, output: clip(ok ? state.output : state.error) };
      await this.emit(l, {
        type: 'tool.result',
        call_id: callId,
        ok,
        preview: preview(ok ? state.output : state.error),
      });
    }
  }

  private partsOf(l: Live): Part[] {
    const out: Part[] = [];
    for (const s of l.parts.values()) {
      if (s.kind === 'text' && s.text) out.push({ type: 'text', text: s.text });
      else if (s.kind === 'reasoning' && s.text) out.push({ type: 'reasoning', text: s.text });
      else if (s.kind === 'tool' && s.call) {
        out.push({ type: 'tool_call', call_id: s.call.callId, tool: s.call.tool, args: s.call.args });
        if (s.result)
          out.push({ type: 'tool_result', call_id: s.call.callId, ok: s.result.ok, result: s.result.output });
      }
    }
    return out;
  }

  private finish(l: Live) {
    if (l.outcome) return;
    l.outcome = {
      status: l.error?.aborted ? 'stopped' : l.error ? 'error' : 'complete',
      parts: this.partsOf(l),
      usage: l.usage,
      error: l.error && !l.error.aborted ? { title: l.error.title, hint: l.error.hint } : null,
      promptMessageId: l.promptMessageId,
    };
    l.done?.(l.outcome);
  }

  /** Parts so far, for a snapshot after a restart. */
  snapshot(sessionId: string): Part[] {
    const l = this.live.get(sessionId);
    return l ? this.partsOf(l) : [];
  }

  private async bridge(ask: PendingPermission): Promise<void> {
    const l = this.live.get(ask.sessionID);
    if (!l) {
      // Not a session Core started, or one no run is following now. It is
      // never approved; a run that re-attaches picks it up from the
      // engine's pending list.
      log.warn(
        { session: ask.sessionID, permission: ask.permission },
        'lab request for a session no run is following',
      );
      return;
    }
    const { turn } = l;
    const callId = ask.tool?.callID ?? ask.id;
    for (const p of this.pending.values()) if (p.requestId === ask.id) return; // already waiting on a person
    const existing = (await this.deps.permissions.pendingApprovals()).find(
      (a) => a.run_id === turn.runId && a.call_id === callId,
    );
    if (existing) {
      this.pending.set(existing.id, {
        requestId: ask.id,
        sessionId: ask.sessionID,
        directory: turn.place.realDir,
      });
      return;
    }

    const mapped = mapAsk(
      { permission: ask.permission, patterns: ask.patterns ?? [], metadata: ask.metadata ?? {} },
      turn.place,
    );
    const decision = await this.deps.gate.check({
      userId: this.deps.userId,
      principal: LAB_PRINCIPAL,
      action: mapped.action,
      resource: mapped.resource,
      toolTier: mapped.tier,
      destructive: mapped.destructive,
      scope: { threadId: turn.threadId, notebookId: null, workspaceId: turn.workspaceId },
      runId: turn.runId,
      traceId: turn.traceId,
    });
    if (decision.outcome === 'allow') {
      await this.deps.engine.reply(ask.id, turn.place.realDir, 'once');
      return;
    }
    if (decision.outcome === 'deny') {
      const why =
        decision.via === 'policy'
          ? `A policy blocks this (${decision.policyId ?? 'policy'}).`
          : decision.reason;
      await this.deps.engine.reply(ask.id, turn.place.realDir, 'reject', why);
      return;
    }
    const approval = await this.deps.permissions.createApproval({
      runId: turn.runId,
      stepSeq: l.seq++,
      threadId: turn.threadId,
      callId,
      principal: LAB_PRINCIPAL,
      tool: mapped.tool,
      action: mapped.action,
      resource: decision.resource,
      args: ask.metadata ?? {},
      argsPreview: ask.metadata ?? {},
      tier: decision.tier,
      suggestions: decision.tier === 'critical' ? [] : decision.suggestions,
      expiresAt: new Date(Date.now() + (this.deps.approvalTtlMs ?? APPROVAL_TTL_MS)).toISOString(),
    });
    this.pending.set(approval.id, {
      requestId: ask.id,
      sessionId: ask.sessionID,
      directory: turn.place.realDir,
    });
    await this.emit(l, {
      type: 'approval.required',
      approval_id: approval.id,
      tool: mapped.tool,
      action: mapped.action,
      resource: decision.resource,
      tier: decision.tier,
      call_id: callId,
      args_preview: approval.args_preview,
      suggestions: approval.suggestions,
    });
    await this.deps.bus
      ?.publish({
        type: 'approval.requested',
        approval_id: approval.id,
        run_id: turn.runId,
        tool: mapped.tool,
        tier: decision.tier,
      })
      .catch(() => undefined);
  }

  /** For tests and the health view. */
  get attached(): number {
    return this.live.size;
  }
}
