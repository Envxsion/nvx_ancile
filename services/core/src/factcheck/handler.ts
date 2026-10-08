/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check runs
 *  Ref      |  DESIGN.md §10, §7.5 (durable runs)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Check one answer as a durable run of kind 'factcheck',
 *           |  so it survives a restart, can be stopped, and shows its
 *           |  progress live: extracting, gathering, verifying n of m.
 *  How      |  The checkpoint carries each stage's output, so a run
 *           |  picked up by another worker continues from the stage it
 *           |  reached, never repeating a verified claim. Claims are
 *           |  verified four at a time. The result is written in one
 *           |  transaction when every claim is scored.
 *  Note     |  A fact-check run has no thread_id: it must not hold the
 *           |  thread's one live run, so you can keep talking while
 *           |  an answer is checked.
 * ------------------------------------------------------------------
 */

import { AncileError, type FactcheckFile, type RunEvent } from '@nvx/contracts';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { currentContext, newTraceId } from '../context';
import { ChainFailedError } from '../gateway/gateway';
import { NoRouteError } from '../gateway/router';
import { logFor } from '../obs/logger';
import {
  type RunContext,
  type RunHandler,
  type RunOutcome,
  RunOwnershipLost,
  type RunRecord,
  type RunStore,
} from '../runs/engine';
import type { RunEventInput } from '../runs/events';
import { type ThreadRepo, textOf } from '../threads/repo';
import {
  type ClaimOutcome,
  countVerdicts,
  DEFAULT_SCORE_CONFIG,
  type ExtractedClaim,
  isSealed,
  messageScore,
  type ScoreConfig,
  scoreOutcome,
  toStored,
} from './pipeline';
import { extractClaims, type Gathered, gatherEvidence, type StepDeps, verifyClaim } from './steps';
import type { FactcheckRecord, FactcheckStore } from './store';

const log = logFor('factcheck');
const BATCH = 4;

export interface FactcheckInput {
  factcheckId: string;
  messageId: string;
  threadId: string;
  workspaceId: string;
  notebookId: string | null;
  /** Family of the model that wrote the answer, so the verifier can differ. */
  generatorFamily: string | null;
}

export interface FactcheckCheckpoint {
  v: 1;
  input: FactcheckInput;
  claims: ExtractedClaim[] | null;
  gathered: Gathered[] | null;
  outcomes: (ClaimOutcome | null)[];
  verifier: string | null;
}

export interface FactcheckDeps extends StepDeps {
  repo: ThreadRepo;
  store: FactcheckStore;
  config?: z.infer<typeof FactcheckFile>;
}

export function scoreConfig(cfg: z.infer<typeof FactcheckFile> | undefined): ScoreConfig {
  return cfg ? { weights: cfg.weights, thresholds: cfg.thresholds } : DEFAULT_SCORE_CONFIG;
}

function failure(err: unknown): { code: string; title: string; hint: string } | null {
  if (err instanceof NoRouteError)
    return {
      code: 'factcheck.no_model',
      title: 'No model is ready to fact-check',
      hint: 'Add a provider key in Settings → Models, or start Ancile with the offline test model.',
    };
  if (err instanceof ChainFailedError)
    return {
      code: 'model.chain_exhausted',
      title: 'No model could fact-check this answer',
      hint: 'Each attempt failed. Check your keys and Admin → Health, then try again.',
    };
  if (err instanceof AncileError) return { code: err.code, title: err.title, hint: err.hint };
  return null;
}

/**
 * A short summary on the answer itself (provenance.factcheck), so a thread
 * shows which answers were checked without a request per answer.
 */
export async function markMessage(
  repo: ThreadRepo,
  messageId: string,
  summary: { id: string; status: FactcheckRecord['status']; confidence?: number | null; sealed?: boolean },
): Promise<void> {
  await repo.updateMessage(messageId, { provenance: { factcheck: summary } }).catch((err) => {
    log.warn({ err, message_id: messageId }, 'could not note the fact-check on its answer');
  });
}

export function factcheckHandler(deps: FactcheckDeps): RunHandler {
  const cfg = scoreConfig(deps.config);
  const fail = async (
    factcheckId: string,
    messageId: string,
    error: NonNullable<FactcheckRecord['error']>,
  ) => {
    await deps.store.fail(factcheckId, error);
    await markMessage(deps.repo, messageId, { id: factcheckId, status: 'failed' });
  };

  return {
    async execute(ctx: RunContext): Promise<RunOutcome> {
      const run = ctx.run;
      const cp = structuredClone(run.checkpoint) as FactcheckCheckpoint;
      const { input } = cp;
      const emit = (e: RunEventInput) => ctx.events.append(run.id, e);
      const progress = (
        stage: Extract<RunEvent, { type: 'factcheck.progress' }>['stage'],
        done: number,
        total: number,
      ) =>
        emit({
          type: 'factcheck.progress',
          factcheck_id: input.factcheckId,
          message_id: input.messageId,
          stage,
          done,
          total,
        });

      try {
        const message = await deps.repo.getMessage(input.messageId);
        if (!message || message.deleted_at)
          throw new AncileError({
            code: 'factcheck.message_gone',
            title: 'The answer was deleted',
            hint: 'There is nothing left to check.',
            status: 404,
            errorClass: 'permanent',
          });

        if (!cp.claims) {
          await progress('extracting', 0, 0);
          const answer = textOf(message.parts);
          const parent = message.parent_id ? await deps.repo.getMessage(message.parent_id) : undefined;
          const { claims } = await extractClaims(
            deps,
            { answer, question: parent ? textOf(parent.parts) : '' },
            ctx.signal,
          );
          cp.claims = claims;
          cp.outcomes = claims.map(() => null);
          await ctx.checkpoint(cp);
        }
        const claims = cp.claims;

        if (!cp.gathered) {
          await progress('gathering', 0, claims.length);
          const checkable = claims.flatMap((c, i) => (c.checkable ? [i] : []));
          const found = await gatherEvidence(deps, {
            workspaceId: input.workspaceId,
            notebookId: input.notebookId,
            claims: checkable.map((i) => (claims[i] as ExtractedClaim).text),
          });
          const gathered: Gathered[] = claims.map(() => ({ evidence: [], coverage: 0 }));
          checkable.forEach((ci, k) => {
            gathered[ci] = found[k] ?? { evidence: [], coverage: 0 };
          });
          cp.gathered = gathered;
          await ctx.checkpoint(cp);
        }
        const gathered = cp.gathered;

        const todo = () => cp.outcomes.flatMap((o, i) => (o ? [] : [i]));
        let remaining = todo();
        while (remaining.length) {
          if (ctx.signal.aborted) break;
          await progress('verifying', claims.length - remaining.length, claims.length);
          const batch = remaining.slice(0, BATCH);
          const results = await Promise.all(
            batch.map(async (i): Promise<ClaimOutcome> => {
              const claim = claims[i] as ExtractedClaim;
              const g = gathered[i] ?? { evidence: [], coverage: 0 };
              if (!claim.checkable)
                return { claim, evidence: [], coverage: 0, verdict: 'insufficient', rationale: '' };
              const v = await verifyClaim(
                deps,
                { claim: claim.text, evidence: g.evidence, generatorFamily: input.generatorFamily },
                ctx.signal,
              );
              if (v.modelId) cp.verifier = v.modelId;
              return {
                claim,
                evidence: v.evidence,
                coverage: g.coverage,
                verdict: v.verdict,
                rationale: v.rationale,
              };
            }),
          );
          batch.forEach((i, k) => {
            cp.outcomes[i] = results[k] ?? null;
          });
          await ctx.checkpoint(cp);
          remaining = todo();
        }

        if (ctx.signal.aborted) {
          if (ctx.signal.reason instanceof RunOwnershipLost) throw ctx.signal.reason;
          await fail(input.factcheckId, input.messageId, {
            code: 'run.cancelled',
            title: 'The fact-check was stopped',
            hint: 'Start it again from the answer when you want it.',
          });
          return { kind: 'cancelled' };
        }

        const checked = cp.outcomes.map((o) => scoreOutcome(o as ClaimOutcome, cfg));
        const confidence = messageScore(checked);
        const stored = checked.map((c) => toStored(c, `clm_${ulid()}`));
        await deps.store.finish(input.factcheckId, {
          confidence,
          verifier_model_id: cp.verifier,
          claims: stored,
        });
        await markMessage(deps.repo, input.messageId, {
          id: input.factcheckId,
          status: 'done',
          confidence,
          sealed: isSealed(countVerdicts(stored)),
        });
        await progress('done', claims.length, claims.length);
        await emit({ type: 'done', message_id: input.messageId });
        return { kind: 'done' };
      } catch (err) {
        if (err instanceof RunOwnershipLost || ctx.signal.reason instanceof RunOwnershipLost) throw err;
        const f = failure(err) ?? {
          code: 'run.crashed',
          title: 'The fact-check stopped unexpectedly',
          hint: 'Try again. If it keeps happening, the trace has the details.',
        };
        if (!failure(err)) log.error({ err, run_id: run.id }, 'fact-check failed');
        await fail(input.factcheckId, input.messageId, f);
        await progress('failed', 0, cp.claims?.length ?? 0).catch(() => undefined);
        await emit({ type: 'error', ...f, attempts: [] }).catch(() => undefined);
        return { kind: 'failed', error: f };
      }
    },

    async cancelled(run: RunRecord) {
      const cp = run.checkpoint as FactcheckCheckpoint;
      await fail(cp.input.factcheckId, cp.input.messageId, {
        code: 'run.cancelled',
        title: 'The fact-check was stopped',
        hint: 'Start it again from the answer when you want it.',
      });
    },

    async failed(run: RunRecord, error) {
      const cp = run.checkpoint as FactcheckCheckpoint;
      await fail(cp.input.factcheckId, cp.input.messageId, error);
    },
  };
}

/* ---- Starting one ------------------------------------------------------------ */

export interface StartDeps {
  repo: ThreadRepo;
  runs: RunStore;
  store: FactcheckStore;
  worker: { kick(): void };
  familyOf: (modelId: string | null) => string | null;
}

/**
 * Start a fact-check of an answer, or return the one already running for it.
 * Only a finished assistant answer with text can be checked.
 */
export async function startFactcheck(
  deps: StartDeps,
  messageId: string,
  scope: { workspaceId: string; notebookId: string | null },
): Promise<{ record: FactcheckRecord; started: boolean }> {
  const message = await deps.repo.getMessage(messageId);
  if (
    !message ||
    message.deleted_at ||
    message.role !== 'assistant' ||
    message.status !== 'complete' ||
    !textOf(message.parts).trim()
  )
    throw new AncileError({
      code: 'factcheck.not_answer',
      title: 'Only a finished answer can be fact-checked',
      hint: 'Wait for the answer to finish, then fact-check it.',
      status: 409,
      errorClass: 'permanent',
    });
  const latest = await deps.store.latestFor(messageId);
  if (latest?.status === 'running' && latest.run_id) {
    const run = await deps.runs.get(latest.run_id);
    if (run && !['succeeded', 'failed', 'cancelled'].includes(run.status))
      return { record: latest, started: false };
  }
  const factcheckId = `fck_${ulid()}`;
  const runId = `run_${ulid()}`;
  const checkpoint: FactcheckCheckpoint = {
    v: 1,
    input: {
      factcheckId,
      messageId,
      threadId: message.thread_id,
      workspaceId: scope.workspaceId,
      notebookId: scope.notebookId,
      generatorFamily: deps.familyOf(message.model_id),
    },
    claims: null,
    gathered: null,
    outcomes: [],
    verifier: null,
  };
  const record = await deps.store.create({
    id: factcheckId,
    message_id: messageId,
    run_id: runId,
    scope: { notebook_id: scope.notebookId, web: false },
  });
  await deps.runs.create({
    id: runId,
    kind: 'factcheck',
    traceId: currentContext()?.traceId ?? newTraceId(),
    threadId: null,
    messageId,
    checkpoint,
  });
  await markMessage(deps.repo, messageId, { id: factcheckId, status: 'running' });
  deps.worker.kick();
  return { record, started: true };
}
