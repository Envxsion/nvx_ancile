/**
 * ------------------------------------------------------------------
 *  Title    |  Lab runs
 *  Ref      |  DESIGN.md §1.4, ROADMAP.md Phase 2 (lab lane)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  "Run in lab" on a message: the engine works on it in the
 *           |  thread's lab folder (<workspace>/labs/<thread>), its
 *           |  steps stream into the thread, every tool it uses asks
 *           |  Core first, and Undo puts the files back.
 *  How      |  An `agent` run. One engine session per thread, so a
 *           |  second "Run in lab" continues with what the first did.
 *           |  The prompt is sent once (a recorded step), then the run
 *           |  waits for the mirror to see the session go idle. A
 *           |  restart re-attaches to the same session and asks the
 *           |  engine whether it already finished. Stop ends the wait at
 *           |  once (even with the engine down); a deadline (default 30
 *           |  minutes) ends it with lab.timed_out.
 * ------------------------------------------------------------------
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AncileError, type Usage } from '@nvx/contracts';
import { logFor } from '../obs/logger';
import {
  type RunContext,
  type RunHandler,
  type RunOutcome,
  RunOwnershipLost,
  type RunRecord,
  StepUncertain,
} from '../runs/engine';
import type { ThreadRepo } from '../threads/repo';
import type { Engine } from './engine-client';
import type { LabMirror, LabOutcome } from './event-mirror';
import { takeSnapshot } from './snapshot';

export interface LabCheckpoint {
  v: 1;
  threadId: string;
  workspaceId: string;
  messageId: string;
  prompt: string;
  sessionId: string | null;
  promptMessageId: string | null;
}

export interface LabDeps {
  engine: Engine;
  mirror: LabMirror;
  repo: ThreadRepo;
  /** Real folder of the workspace; labs live in its labs/ folder. */
  workspaceDir: string;
  workspaceRoot: string;
  /** Where each run's copy of the lab folder is kept, for diff and undo. */
  snapshotsDir: string;
  /** How long one lab run may take before it is stopped (default 30 minutes). */
  deadlineMs?: number;
}

const log = logFor('lab');
export const LAB_DEADLINE_MS = 30 * 60_000;

export const snapshotDir = (deps: Pick<LabDeps, 'snapshotsDir'>, runId: string) =>
  join(deps.snapshotsDir, runId);

export const LAB_MODEL_NAME = 'The lab';

export function labPlace(deps: Pick<LabDeps, 'workspaceDir' | 'workspaceRoot'>, threadId: string) {
  return {
    realDir: join(deps.workspaceDir, 'labs', threadId),
    virtualDir: `${deps.workspaceRoot}/labs/${threadId}`,
  };
}

export function labHandler(deps: LabDeps): RunHandler {
  return {
    async execute(ctx: RunContext): Promise<RunOutcome> {
      const run = ctx.run;
      const cp = structuredClone(run.checkpoint) as LabCheckpoint;
      const place = labPlace(deps, cp.threadId);
      const emit = (e: Parameters<RunContext['events']['append']>[1]) => ctx.events.append(run.id, e);
      await mkdir(place.realDir, { recursive: true });
      await deps.repo.updateMessage(cp.messageId, { status: 'streaming', run_id: run.id });

      if (!cp.sessionId) {
        const thread = await deps.repo.getThread(cp.threadId);
        const known = (thread?.settings as { lab_session?: string } | undefined)?.lab_session;
        cp.sessionId = known ?? (await deps.engine.createSession(place.realDir, thread?.title ?? 'Lab')).id;
        if (!known)
          await deps.repo.patchThread(cp.threadId, { settings: { lab_session: cp.sessionId } as never });
        await ctx.checkpoint(cp);
      }
      const sessionId = cp.sessionId;
      await deps.mirror.attach({
        runId: run.id,
        traceId: run.traceId,
        threadId: cp.threadId,
        workspaceId: cp.workspaceId,
        messageId: cp.messageId,
        sessionId,
        place,
      });
      await emit({
        type: 'model',
        message_id: cp.messageId,
        model_id: 'lab/engine',
        display_name: LAB_MODEL_NAME,
      });

      const onAbort = () => void deps.engine.abort(sessionId).catch(() => undefined);
      ctx.signal.addEventListener('abort', onAbort);
      try {
        if (run.attempt > 0)
          await emit({
            type: 'message.snapshot',
            message_id: cp.messageId,
            parts: deps.mirror.snapshot(sessionId),
          });
        // Copying the folder again is harmless as long as the prompt was not sent.
        await ctx.once(
          0,
          'lab_snapshot',
          {},
          async () => (await takeSnapshot(place.realDir, snapshotDir(deps, run.id))).ok,
          { rerunnable: true },
        );
        try {
          await ctx.once(1, 'lab_prompt', { sessionId }, async () => {
            deps.mirror.markStarted(sessionId);
            await deps.engine.prompt(sessionId, place.realDir, cp.prompt);
            return true;
          });
        } catch (err) {
          // A restart hit while the prompt was being sent: it may or may not
          // have reached the engine, and sending it twice would do the work twice.
          if (!(err instanceof StepUncertain)) throw err;
          const error = { code: err.code, title: err.title, hint: err.hint };
          await deps.repo.updateMessage(cp.messageId, {
            status: 'error',
            provenance: { model_name: LAB_MODEL_NAME, error },
          });
          await emit({ type: 'error', ...error, attempts: [] });
          return { kind: 'failed', error };
        }
        deps.mirror.markStarted(sessionId);
        // After a restart the session may have finished while nobody was listening.
        if (run.attempt > 0) await deps.mirror.check(sessionId);
        let outcome: LabOutcome;
        try {
          outcome = await deps.mirror.wait(sessionId, {
            signal: ctx.signal,
            deadlineMs: deps.deadlineMs ?? LAB_DEADLINE_MS,
          });
        } catch (err) {
          if (!(err instanceof AncileError) || err.code !== 'lab.timed_out') throw err;
          log.warn({ run_id: run.id, session: sessionId }, 'lab run hit its deadline; stopping it');
          await deps.engine.abort(sessionId).catch(() => undefined);
          outcome = {
            status: 'error',
            parts: deps.mirror.snapshot(sessionId),
            usage: { input: 0, output: 0, costUsd: 0 },
            error: { code: err.code, title: err.title, hint: err.hint },
            promptMessageId: null,
          };
        }
        // Another worker owns this run now: leave the message to it.
        if (ctx.signal.reason instanceof RunOwnershipLost) throw ctx.signal.reason;
        cp.promptMessageId = outcome.promptMessageId;
        await ctx.checkpoint(cp);
        const status = ctx.signal.aborted ? 'stopped' : outcome.status;
        const usage: Usage = {
          input_tokens: outcome.usage.input,
          output_tokens: outcome.usage.output,
          cached_tokens: 0,
          cost_usd: outcome.usage.costUsd,
        };
        await deps.repo.updateMessage(cp.messageId, {
          parts: outcome.parts,
          status,
          model_id: null,
          usage,
          provenance: {
            model_name: LAB_MODEL_NAME,
            lab: {
              session_id: sessionId,
              prompt_message_id: outcome.promptMessageId,
              folder: place.virtualDir,
            },
            ...(outcome.error && { error: { code: 'lab.failed', ...outcome.error } }),
          },
        });
        await deps.repo.patchThread(cp.threadId, {});
        await emit({ type: 'usage', message_id: cp.messageId, usage });
        if (status === 'stopped') return { kind: 'cancelled' };
        if (outcome.error) {
          const error = {
            code: outcome.error.code ?? 'lab.failed',
            title: outcome.error.title,
            hint: outcome.error.hint,
          };
          await emit({ type: 'error', ...error, attempts: [] });
          return { kind: 'failed', error };
        }
        return { kind: 'done' };
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
        await deps.mirror
          .detach(sessionId)
          .catch((err) =>
            log.warn({ err, run_id: run.id }, 'could not withdraw the open questions of a lab run'),
          );
      }
    },

    async cancelled(run: RunRecord) {
      const cp = run.checkpoint as LabCheckpoint;
      if (cp.sessionId) await deps.engine.abort(cp.sessionId).catch(() => undefined);
      await deps.repo.updateMessage(cp.messageId, { status: 'stopped' });
    },

    async failed(run: RunRecord, error) {
      const cp = run.checkpoint as LabCheckpoint;
      if (cp.sessionId) await deps.engine.abort(cp.sessionId).catch(() => undefined);
      await deps.repo.updateMessage(cp.messageId, {
        status: 'error',
        provenance: { model_name: LAB_MODEL_NAME, error },
      });
    },
  };
}
