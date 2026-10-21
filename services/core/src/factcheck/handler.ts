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
 *           |  Each claim is announced as it is found and again as its
 *           |  verdict lands (factcheck.claim), so the Evidence tab fills
 *           |  in live (EV1).
 *  Tiers    |  Each claim is triaged (triage.ts) and checked by the
 *           |  best ready model of the tier it needs, from another
 *           |  family when one is ready, a same-family one with a note
 *           |  when not (TR1, TR3): a check never fails for lack of a
 *           |  listed model. It goes up a tier on low confidence or a
 *           |  contradiction, twice at most. An earlier verdict for the
 *           |  same claim and sources answers first (cache.ts, SI1).
 *           |  Mission-critical mode (the notebook's setting, or one
 *           |  check) uses two checkers at standard tier or better.
 *  Limits   |  Hard limits per check (budget.ts, config/factcheck.yaml):
 *           |  model calls per claim and per answer, minutes, and spend.
 *           |  A claim that meets one reads "Not checked: <reason>" and
 *           |  the rest go on; so does a claim no checker could answer
 *           |  in the format asked for. A stop ends the run as cancelled,
 *           |  never as a crash.
 *  Guards   |  The judges are held to the thread's scope (keep-local), and
 *           |  the web is searched only when the check may (web.ts), each
 *           |  search through the permission gate (FC4).
 *  Note     |  A fact-check run has no thread_id: it must not hold the
 *           |  thread's one live run, so you can keep talking while
 *           |  an answer is checked.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import {
  AncileError,
  type ClaimCheckInfo,
  type EffectiveScope,
  type FactcheckFile,
  type RunEvent,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { currentContext, newTraceId } from '../context';
import { ChainFailedError } from '../gateway/gateway';
import { NoRouteError } from '../gateway/router';
import { logFor } from '../obs/logger';
import type { Gate } from '../permissions/gate';
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
import { scopeAllow } from './allow';
import {
  type BudgetState,
  CheckBudget,
  CheckLimit,
  type CheckLimits,
  DEFAULT_LIMITS,
  notChecked,
} from './budget';
import type { VerdictCache } from './cache';
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
import { relevantAt } from './score';
import {
  type Checked,
  cachedCheck,
  checkClaim,
  checkWebLast,
  declarativeSentences,
  EXTRACTOR_VERSION,
  extractClaims,
  type Gathered,
  gatherEvidence,
  lookupWebEvidence,
  NeedsChoice,
  type StepDeps,
  unsureGeneral,
  WEB_MAX_QUERIES,
  type WebLookup,
} from './steps';
import type { FactcheckRecord, FactcheckStore } from './store';
import { type Triage, triageClaim, triageClaims } from './triage';
import { gatedWeb, newTally, tallyOutcome, type WebDecision, type WebSearch, type WebTally } from './web';

const log = logFor('factcheck');
const BATCH = 4;

export interface FactcheckInput {
  factcheckId: string;
  messageId: string;
  threadId: string;
  workspaceId: string;
  notebookId: string | null;
  /** Family of the model that wrote the answer: another family checks it when one is ready. */
  generatorFamily: string | null;
  /** This check may search the web (FC4); checks started before it existed read as false. */
  web?: boolean;
  /** Mission-critical: standard tier or better, two checkers (TR3). */
  critical?: boolean;
  /** The models the person chose for a critical check; absent: picked automatically. */
  checkers?: string[];
  /** The model that wrote the answer, so it never checks itself. */
  generatorModelId?: string | null;
  /** Check again even when an earlier verdict is kept. */
  again?: boolean;
  /** Find the claims again instead of reusing the ones kept for this answer. */
  reextract?: boolean;
  /** This notebook shares its verdicts with the others (SI1). */
  sharing?: boolean;
}

export interface FactcheckCheckpoint {
  v: 1;
  input: FactcheckInput;
  claims: ExtractedClaim[] | null;
  gathered: Gathered[] | null;
  outcomes: (ClaimOutcome | null)[];
  verifier: string | null;
  /** How much model each claim needs, decided once so a resumed run does not decide again. */
  triage?: Triage[];
  /** What the web lookups did and cost, kept so a resumed run adds to it. */
  webTally?: WebTally;
  /** Model calls, spend and start time so far (budget.ts), kept so a resumed run honours the same limits. */
  budget?: BudgetState;
}

export interface FactcheckDeps extends StepDeps {
  /** Earlier verdicts (SI1); absent: every claim is asked. */
  cache?: VerdictCache;
  repo: ThreadRepo;
  store: FactcheckStore;
  config?: z.infer<typeof FactcheckFile>;
  /** The thread's scope now, so judges follow the keep-local rules; absent: no filter. */
  scopeOf?: (ref: { threadId: string }) => Promise<EffectiveScope>;
  /** Web search (FC4); absent: sources only. */
  web?: WebSearch | null;
  /** The permission gate: every web search is decided on its real query before it leaves. */
  gate?: Gate;
  userId?: string;
}

/** The limits on one check, from config/factcheck.yaml (limits), else the defaults. */
export function checkLimits(cfg: z.infer<typeof FactcheckFile> | undefined): CheckLimits {
  const l = cfg?.limits;
  return l
    ? {
        callsPerClaim: l.calls_per_claim,
        callsPerCheck: l.calls_per_check,
        minutes: l.minutes,
        spendUsd: l.spend_usd,
      }
    : DEFAULT_LIMITS;
}

export function scoreConfig(cfg: z.infer<typeof FactcheckFile> | undefined): ScoreConfig {
  return cfg ? { weights: cfg.weights, thresholds: cfg.thresholds } : DEFAULT_SCORE_CONFIG;
}

/** What each model that was tried did, in a line apiece, so "no model" is never the whole story (FC2). */
export function chainFailure(err: ChainFailedError): { code: string; title: string; hint: string } {
  const tried = err.attempts
    .slice(0, 4)
    .map((a) => `${a.model} (${(a.title ?? a.detail ?? a.errorClass).replace(/\s+/g, ' ').slice(0, 120)})`)
    .join('; ');
  return {
    code: 'model.chain_exhausted',
    title: 'No model could fact-check this answer',
    hint: `${tried ? `Tried ${tried}. ` : ''}Check your keys and Admin → Health, wait if Claude Code is at its plan limit, or add another model in Settings → Models, then try again.`,
  };
}

function failure(err: unknown): { code: string; title: string; hint: string } | null {
  if (err instanceof NoRouteError)
    return {
      code: 'routing.no_chat_model',
      title: 'No model is ready yet',
      hint: 'Add a key in Settings → Keys, set up Claude Code in Settings → Claude Code, or pull a model with Ollama.',
    };
  if (err instanceof NeedsChoice)
    return {
      code: 'factcheck.needs_choice',
      title: 'Choose the models to check with',
      hint: 'Start the check again from the answer and pick the models that should check it.',
    };
  if (err instanceof CheckLimit)
    return {
      code: 'factcheck.limit',
      title: 'The fact-check reached its limit',
      hint: `${err.words.charAt(0).toUpperCase()}${err.words.slice(1)} before the claims could be found. Try again, or raise the limits in config/factcheck.yaml.`,
    };
  if (err instanceof ChainFailedError) return chainFailure(err);
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
  /** A stop: the check reads cancelled, as the run does. */
  const cancel = async (factcheckId: string, messageId: string) => {
    await deps.store.cancel(factcheckId, {
      code: 'run.cancelled',
      title: 'The fact-check was stopped',
      hint: 'Start it again from the answer when you want it.',
    });
    await markMessage(deps.repo, messageId, { id: factcheckId, status: 'cancelled' });
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

      const budget = new CheckBudget(checkLimits(deps.config), cp.budget);
      cp.budget = budget.state;
      const stopped = async (): Promise<RunOutcome> => {
        await cancel(input.factcheckId, input.messageId);
        return { kind: 'cancelled' };
      };

      try {
        const scope = (await deps.scopeOf?.({ threadId: input.threadId }).catch(() => null)) ?? null;
        const allow = scopeAllow(scope);
        const tally: WebTally = cp.webTally ?? newTally();
        const webLookup: WebLookup | undefined = input.web
          ? gatedWeb({
              web: deps.web,
              gate: deps.gate,
              userId: deps.userId,
              ctx: {
                threadId: input.threadId,
                notebookId: input.notebookId,
                workspaceId: input.workspaceId,
                runId: run.id,
                traceId: run.traceId,
              },
              tally,
              // A private notebook only gets here when Settings → Private notebooks allowed it (webPolicy).
              ...(scope?.private && { leaveOk: true }),
            })
          : undefined;
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
          const answerSha = createHash('sha256').update(answer).digest('hex');
          // The claims found the first time, when the answer is the same and the extraction is not newer:
          // a model does not find the same ones twice, and two checks should judge the same sentences.
          const kept = input.reextract ? undefined : await deps.store.extractionFor(input.messageId);
          let claims: ExtractedClaim[];
          // An empty list kept for an answer that states several things is a miss, not an answer: ask again.
          if (
            kept &&
            kept.answer_sha === answerSha &&
            kept.version === EXTRACTOR_VERSION &&
            (kept.claims.length > 0 || declarativeSentences(answer) < 2)
          ) {
            claims = kept.claims;
          } else {
            const parent = message.parent_id ? await deps.repo.getMessage(message.parent_id) : undefined;
            claims = (
              await extractClaims(
                deps,
                { answer, question: parent ? textOf(parent.parts) : '', allow, budget: budget.forCheck() },
                ctx.signal,
              )
            ).claims;
            // Whatever extractClaims returns is final: an empty list for an answer with several statements
            // was already asked a second time, plainly, and the second reading agreed.
            await deps.store
              .saveExtraction({
                message_id: input.messageId,
                answer_sha: answerSha,
                version: EXTRACTOR_VERSION,
                claims,
              })
              .catch((err) => log.warn({ err }, 'could not keep the claims found in the answer'));
          }
          cp.claims = claims;
          cp.outcomes = claims.map(() => null);
          await ctx.checkpoint(cp);
          for (const [index, c] of claims.entries())
            await emit({
              type: 'factcheck.claim',
              factcheck_id: input.factcheckId,
              message_id: input.messageId,
              state: 'found',
              index,
              total: claims.length,
              text: c.text,
              checkable: c.checkable,
            });
        }
        const claims = cp.claims;

        if (!cp.gathered) {
          await progress('gathering', 0, claims.length);
          const checkable = claims.flatMap((c, i) => (c.checkable ? [i] : []));
          const found = await gatherEvidence(deps, {
            workspaceId: input.workspaceId,
            notebookId: input.notebookId,
            claims: checkable.map((i) => (claims[i] as ExtractedClaim).text),
            web: webLookup,
            signal: ctx.signal,
            minRelevance: relevantAt(deps.config?.thresholds),
            // An obvious claim no source covers is judged from common knowledge first; the web only if that is unsure.
            obvious: (text) => triageClaim(text, { critical: input.critical === true }).obvious,
            // A claim an earlier verdict already answers from its sources is not looked up on the web.
            ...(!input.again && {
              skipWeb: async (k: number, g: Gathered) => {
                const claim = claims[checkable[k] as number] as ExtractedClaim;
                return (
                  (await cachedCheck(deps, {
                    notebookId: input.notebookId,
                    shared: input.sharing === true,
                    claim: claim.text,
                    evidence: g.evidence,
                    critical: input.critical === true,
                  })) !== null
                );
              },
            }),
          });
          const gathered: Gathered[] = claims.map(() => ({ evidence: [], coverage: 0 }));
          checkable.forEach((ci, k) => {
            gathered[ci] = found[k] ?? { evidence: [], coverage: 0 };
          });
          cp.gathered = gathered;
          cp.webTally = tally;
          await ctx.checkpoint(cp);
        }
        const gathered = cp.gathered;

        // Earlier verdicts first: they need only the claim and its evidence, so a re-run is answered
        // before anything slow (the decision layer, a model) is asked. Only the rest is triaged.
        const known = new Map<number, Checked>();
        const probed = !cp.triage && !input.again;
        if (probed)
          await Promise.all(
            claims.map(async (c, i) => {
              if (!c.checkable) return;
              const hit = await cachedCheck(deps, {
                notebookId: input.notebookId,
                shared: input.sharing === true,
                claim: c.text,
                evidence: gathered[i]?.evidence ?? [],
                critical: input.critical === true,
              }).catch(() => null);
              if (hit) known.set(i, hit);
            }),
          );
        if (!cp.triage) {
          const rules = { critical: input.critical === true, notebookId: input.notebookId };
          const asked = claims.flatMap((c, i) => (c.checkable && !known.has(i) ? [i] : []));
          const decided = await triageClaims(
            asked.map((i) => (claims[i] as ExtractedClaim).text),
            rules,
          );
          // The rest (cached or not checkable) need no model, so the plain rules stand.
          cp.triage = claims.map((c) => triageClaim(c.text, rules));
          asked.forEach((i, k) => {
            cp.triage?.splice(i, 1, decided[k] as Triage);
          });
          await ctx.checkpoint(cp);
        }
        const triage = cp.triage;
        const chosen = (input.checkers ?? []).flatMap((id) => {
          const m = deps.registry.get(id);
          return m ? [m] : [];
        });

        // The web for a claim that was held back (obvious, no source covers it). At most WEB_MAX_QUERIES in all.
        const searched = () => gathered.filter((g) => g?.webTried).length;
        const searchLater = async (i: number, g: Gathered): Promise<void> => {
          g.webDeferred = false;
          if (!webLookup || searched() >= WEB_MAX_QUERIES) return;
          g.webTried = true;
          g.evidence.push(
            ...(await lookupWebEvidence(webLookup, (claims[i] as ExtractedClaim).text, ctx.signal)),
          );
        };
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
              const t = triage[i] as Triage;
              let v: Awaited<ReturnType<typeof checkClaim>>;
              try {
                v = await checkWebLast({
                  earlier: known.get(i),
                  g,
                  obvious: t.obvious,
                  search: () => searchLater(i, g),
                  ask: (firstLook) =>
                    checkClaim(
                      deps,
                      {
                        claim: claim.text,
                        evidence: g.evidence,
                        triage: t,
                        critical: input.critical === true,
                        generatorFamily: input.generatorFamily,
                        generatorModelId: input.generatorModelId ?? null,
                        allow,
                        chosen,
                        notebookId: input.notebookId,
                        sharing: input.sharing === true,
                        again: input.again,
                        budget: budget.forClaim(i),
                        // The first look at a held-back claim is common knowledge alone: no stronger model, and
                        // nothing kept if it is unsure, because the web is asked next.
                        ...(firstLook && { escalate: false, recordIf: (c: Checked) => !unsureGeneral(c) }),
                        ...(probed && { known: null }),
                      },
                      ctx.signal,
                    ),
                });
              } catch (err) {
                // A limit, or a claim no checker could answer in the format asked for: said plainly, and the
                // rest of the answer is still checked. Anything else (every model down) fails the run.
                const why =
                  err instanceof CheckLimit
                    ? err.words
                    : err instanceof AncileError && err.code === 'factcheck.bad_output'
                      ? 'no checker gave a reply that could be read'
                      : null;
                if (why === null || ctx.signal.aborted) throw err;
                return {
                  claim,
                  evidence: [],
                  coverage: g.coverage,
                  verdict: 'insufficient',
                  rationale: notChecked(why),
                };
              }
              if (v.modelId) cp.verifier = v.modelId;
              const check: ClaimCheckInfo | undefined =
                v.modelId || v.cached
                  ? {
                      tier_used: v.tier,
                      model_id: v.modelId || null,
                      escalated_from: v.escalatedFrom,
                      cached: v.cached,
                      degraded: v.degraded,
                      general_knowledge: v.general,
                      ...(v.checkers && v.checkers.length > 1 && { checkers: v.checkers }),
                    }
                  : undefined;
              return {
                claim,
                evidence: v.evidence,
                coverage: g.coverage,
                verdict: v.verdict,
                rationale: v.rationale,
                verdicts: v.verdicts,
                confidence: v.confidence,
                general: v.general,
                ...(check && { check }),
              };
            }),
          );
          for (const [k, i] of batch.entries()) {
            const outcome = results[k];
            if (!outcome) continue;
            cp.outcomes[i] = outcome;
            const scored = scoreOutcome(outcome, cfg);
            await emit({
              type: 'factcheck.claim',
              factcheck_id: input.factcheckId,
              message_id: input.messageId,
              state: 'judged',
              index: i,
              total: claims.length,
              text: outcome.claim.text,
              checkable: outcome.claim.checkable,
              verdict: scored.score.verdict,
              rationale: scored.rationale,
              judge: cp.verifier,
              quotes: outcome.evidence
                .filter((e) => e.stance !== 'neutral')
                .slice(0, 3)
                .map((e) => ({
                  source_title: e.source_title,
                  quote: e.quote.slice(0, 280),
                  stance: e.stance,
                  origin: e.origin ?? 'source',
                })),
            });
          }
          await ctx.checkpoint(cp);
          remaining = todo();
        }

        if (ctx.signal.aborted) {
          if (ctx.signal.reason instanceof RunOwnershipLost) throw ctx.signal.reason;
          return await stopped();
        }

        const checked = cp.outcomes.map((o) => scoreOutcome(o as ClaimOutcome, cfg));
        const confidence = messageScore(checked);
        const stored = checked.map((c) => toStored(c, `clm_${ulid()}`));
        await deps.store.finish(input.factcheckId, {
          confidence,
          verifier_model_id: cp.verifier,
          claims: stored,
          ...(input.web && {
            scope: {
              web_cost_usd: tally.costUsd,
              web_lookups: tally.lookups ?? [],
              ...(tallyOutcome(tally) && {
                web_note: tallyOutcome(tally)?.note ?? null,
                web_reason: tallyOutcome(tally)?.reason ?? null,
              }),
            },
          }),
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
        // A stop in the middle of a model call is a stop, not a crash.
        if (ctx.signal.aborted) return await stopped();
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
      await cancel(cp.input.factcheckId, cp.input.messageId);
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
  /** The notebook's mission-critical and verdict-sharing settings (TR3, SI1). */
  notebookFlags?: (notebookId: string | null) => Promise<{ critical: boolean; sharing: boolean }>;
  /** May this check use the web? (the notebook's setting, the one-click allow, the scope); absent: no. */
  webFor?: (a: {
    threadId: string;
    notebookId: string | null;
    requested: boolean | undefined;
  }) => Promise<WebDecision>;
}

/**
 * Start a fact-check of an answer, or return the one already running for it.
 * Only a finished assistant answer with text can be checked.
 */
export async function startFactcheck(
  deps: StartDeps,
  messageId: string,
  scope: {
    workspaceId: string;
    notebookId: string | null;
    web?: boolean;
    critical?: boolean;
    checkers?: string[];
    again?: boolean;
    reextract?: boolean;
  },
): Promise<{ record: FactcheckRecord; started: boolean; web: WebDecision }> {
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
      return {
        record: latest,
        started: false,
        web: {
          use: latest.scope.web,
          note: latest.scope.web_note ?? null,
          reason: latest.scope.web_reason ?? null,
        },
      };
  }
  const web: WebDecision = (await deps.webFor?.({
    threadId: message.thread_id,
    notebookId: scope.notebookId,
    requested: scope.web,
  })) ?? { use: false, note: null, reason: null };
  const flags = (await deps.notebookFlags?.(scope.notebookId)) ?? { critical: false, sharing: false };
  const critical = scope.critical ?? flags.critical;
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
      web: web.use,
      critical,
      ...(scope.checkers?.length && { checkers: scope.checkers }),
      generatorModelId: message.model_id ?? null,
      ...(scope.again && { again: true }),
      ...(scope.reextract && { reextract: true }),
      sharing: flags.sharing,
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
    scope: {
      notebook_id: scope.notebookId,
      web: web.use,
      web_note: web.note,
      web_reason: web.reason,
      critical,
    },
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
  return { record, started: true, web };
}
