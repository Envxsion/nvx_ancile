/**
 * ------------------------------------------------------------------
 *  Title    |  Gateway
 *  Ref      |  DESIGN.md §1.2, §7
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every token Ancile spends goes through here: one place
 *           |  for fallback chains, circuit breakers, refusals, mid-
 *           |  stream recovery, tracing and cost.
 *  How      |  stream() walks the resolved chain. For each model it
 *           |  opens a stream (the first read runs under the model's
 *           |  circuit breaker) and holds back the opening characters
 *           |  so an outright refusal or an early failure can fall
 *           |  through invisibly. Once text is flowing it is committed.
 *           |  If the stream breaks after that, the next model
 *           |  continues from the partial answer and a `seam` event
 *           |  marks the join.
 * ------------------------------------------------------------------
 */

import { AncileError, CLAUDE_CODE_PROVIDER, type ErrorClass, type ModelConfig } from '@nvx/contracts';
import { CircuitBreaker, ClassifiedError, classify, FALLBACKABLE, isConnectionError } from '@nvx/resilience';
import { currentContext } from '../context';
import { startSpan } from '../obs/spans';
import { type CallLedger, COUNTED_ON_MESSAGE } from '../usage/ledger';
import { type NodeWaking, nodeWakingFrom, waitOrSkip } from './compute';
import { cannotBeRefusal, isRefusalFinish, looksLikeRefusal } from './refusal';
import type { GatewayEvent, ModelClient, ModelRequest, StreamChunk } from './types';
import { priceOf } from './usage';

export interface GatewayOptions {
  client: ModelClient;
  breaker?: CircuitBreaker;
  /** Characters held back to detect a refusal before committing. 0 disables. */
  refusalProbeChars?: number;
  /** How long to wait for a GPU node to wake before falling back (ms). */
  computeWaitMs?: number;
  /** The shortest pause between asking a waking node again (ms). */
  computePollMs?: number;
  /**
   * When set, a node that says how long it needs (eta_s) is waited for up to
   * that estimate plus this margin, even past computeWaitMs: a cold GPU node
   * loading a large model can take longer than the usual wait (ms).
   */
  computeEtaMarginMs?: number;
  /**
   * Where a finished call that is not a chat answer is counted (usage/ledger.ts), with the
   * purpose it was made for. Absent: nothing is recorded (tests that do not look).
   */
  ledger?: CallLedger;
  /** Wait before asking the same model again after a short Retry-After (tests replace it). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * A provider refused this model for this account for good (provider.model_not_permitted: not
   * offered to the key, or the account's privacy settings leave it no provider). The registry marks
   * it unavailable, so no chain asks it again until a key or setting changes.
   */
  onModelRefused?: (model: ModelConfig, attempt: FailedAttempt) => void;
}

/**
 * A provider that says "try again in this long" with this much or less is
 * waited for, and asked again, before the chain moves on to another model.
 */
export const SHORT_RETRY_AFTER_MS = 10_000;

/** How many times one model is asked again after a short Retry-After, per call. */
const SAME_MODEL_RETRIES = 1;

/**
 * A connection that failed (nothing came back, nothing was refused) is asked again on the same model,
 * after these pauses, before any fallback: a network blip is not the model's fault.
 */
export const CONNECTION_BACKOFF_MS = [400, 1_200] as const;

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

export interface FailedAttempt {
  model: string;
  errorClass: ErrorClass;
  detail: string;
  /** A documented provider.* code the adapter recognised (no credit, wrong region...), with its words. */
  code?: string;
  title?: string;
  hint?: string;
}

export class ChainFailedError extends Error {
  readonly errorClass: ErrorClass;
  constructor(readonly attempts: FailedAttempt[]) {
    super(
      `Every model in the chain failed (${attempts.map((a) => `${a.model}: ${a.errorClass}`).join(', ')})`,
    );
    this.name = 'ChainFailedError';
    this.errorClass = attempts.at(-1)?.errorClass ?? 'bug';
  }
}

export const CONTINUE_INSTRUCTION =
  'Your previous answer was cut off. Continue it exactly where it stopped, without repeating anything or mentioning the interruption.';

export class Gateway {
  private readonly client: ModelClient;
  private readonly breaker: CircuitBreaker;
  private readonly probeChars: number;
  private readonly computeWaitMs: number;
  private readonly computePollMs: number;
  private readonly computeEtaMarginMs: number | null;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly ledger: CallLedger | undefined;
  private readonly onModelRefused: GatewayOptions['onModelRefused'];
  /** What a call is for when its caller does not say (see `as`). */
  private purpose = 'other';

  constructor(opts: GatewayOptions) {
    this.ledger = opts.ledger;
    this.onModelRefused = opts.onModelRefused;
    this.client = opts.client;
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.probeChars = opts.refusalProbeChars ?? 160;
    this.computeWaitMs = opts.computeWaitMs ?? 5 * 60_000;
    this.computePollMs = opts.computePollMs ?? 2_000;
    this.computeEtaMarginMs = opts.computeEtaMarginMs ?? null;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /**
   * This gateway, with every call it makes counted under `purpose` unless the call says otherwise.
   * Hand a part of Ancile (memory, the permission reviewer, Knowledge's calls) its own view, and
   * nothing it asks can go uncounted or be counted as something else.
   */
  as(purpose: string): Gateway {
    const view = Object.create(this) as Gateway;
    view.purpose = purpose;
    return view;
  }

  /** One finished call goes into the ledger (a chat answer is counted on its message, not here). */
  private note(model: ModelConfig, chunk: Extract<StreamChunk, { type: 'finish' }>, purpose: string) {
    if (!this.ledger || COUNTED_ON_MESSAGE.has(purpose)) return;
    const ctx = currentContext();
    void this.ledger
      .record({
        purpose,
        engine: model.provider === CLAUDE_CODE_PROVIDER ? 'claude_code' : 'gateway',
        modelId: model.id,
        provider: chunk.served?.provider ?? null,
        inputTokens: chunk.usage.inputTokens,
        outputTokens: chunk.usage.outputTokens,
        cachedTokens: chunk.usage.cachedTokens ?? 0,
        costUsd: chunk.costUsd ?? priceOf(model, chunk.usage),
        at: new Date(),
        traceId: ctx?.traceId ?? null,
        runId: ctx?.runId ?? null,
      })
      .catch(() => undefined);
  }

  /**
   * Open a model's stream and make the first read (the connection, which
   * the breaker judges). A node that is waking is not a failure: say so,
   * wait, and ask again until it answers, the wait runs out, or the person
   * chooses the cloud (see compute.ts).
   */
  private async *open(
    model: ModelConfig,
    req: ModelRequest,
    signal: AbortSignal,
    hasNext: boolean,
    // Flows (Phase 5b): a node may wait less (or more) for a sleeping GPU node.
    computeWaitMs: number = this.computeWaitMs,
  ): AsyncGenerator<GatewayEvent, { it: AsyncIterator<StreamChunk>; step: IteratorResult<StreamChunk> }> {
    const runId = currentContext()?.runId ?? null;
    const started = Date.now();
    let limit = computeWaitMs;
    let asked = 0;
    for (;;) {
      const it = this.client.stream(model, req, signal)[Symbol.asyncIterator]();
      let waking: NodeWaking | null = null;
      const step = await this.breaker.run(model.id, async () => {
        try {
          return await it.next();
        } catch (err) {
          waking = model.via === 'controller' ? nodeWakingFrom(err) : null;
          if (waking) return null;
          throw err;
        }
      });
      if (step) return { it, step };
      await it.return?.().catch(() => undefined);
      const w = waking as NodeWaking | null;
      if (!w) throw new ClassifiedError('transient', `${model.display_name} gave no answer`);
      // The node's own estimate, plus a margin, can stretch the wait (never a wait of 0).
      if (computeWaitMs > 0 && asked === 0 && w.etaS !== null && this.computeEtaMarginMs !== null)
        limit = Math.max(computeWaitMs, w.etaS * 1000 + this.computeEtaMarginMs);
      if (computeWaitMs <= 0 || Date.now() - started > limit)
        throw new ClassifiedError(
          'capacity',
          `${model.display_name}'s node did not wake within ${Math.max(1, Math.round(limit / 60_000))} min`,
        );
      yield {
        type: 'compute_waiting',
        modelId: model.id,
        nodeId: w.nodeId,
        etaS: w.etaS,
        canUseCloud: hasNext,
        detail: w.message,
      };
      // Back off while it wakes: ask often at first, then less, never more than 15 s apart.
      const pause = Math.min(
        15_000,
        Math.max(this.computePollMs * 1.5 ** asked, Math.min(w.retryAfterS, 15) * 1000),
      );
      asked += 1;
      if ((await waitOrSkip(pause, signal, runId)) === 'skip')
        throw new ClassifiedError('capacity', 'You chose a cloud model instead of waiting for the node');
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
    }
  }

  async *stream(
    chain: ModelConfig[],
    req: ModelRequest,
    signal: AbortSignal,
    opts: { computeWaitMs?: number; purpose?: string } = {},
  ): AsyncGenerator<GatewayEvent> {
    const purpose = opts.purpose ?? this.purpose;
    const attempts: FailedAttempt[] = [];
    let shown = ''; // text the user has already seen, across models
    let shownBy: string | null = null;
    // How often each model was asked again after a short Retry-After (GW1).
    const asked = new Map<string, number>();
    const reconnects = new Map<string, number>();

    for (let i = 0; i < chain.length; i++) {
      // A stop ends the walk: no further attempt, no span, no fallback event for a model never asked.
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const model = chain[i] as ModelConfig;
      const next = chain[i + 1];
      const continuing = shown !== '';
      const effective: ModelRequest = continuing
        ? {
            ...req,
            messages: [
              ...req.messages,
              { role: 'assistant', content: shown },
              { role: 'user', content: CONTINUE_INSTRUCTION },
            ],
          }
        : req;

      let iterator: AsyncIterator<StreamChunk> | undefined;
      const held: StreamChunk[] = [];
      let heldText = '';
      const state = { committed: false };

      const commit = (): GatewayEvent[] => {
        const out: GatewayEvent[] = [];
        if (shownBy !== null && shownBy !== model.id) {
          out.push({
            type: 'seam',
            from: shownBy,
            to: model.id,
            reason: attempts.at(-1)?.detail ?? 'stream interrupted',
          });
        }
        out.push({ type: 'model', modelId: model.id });
        for (const c of held) {
          if (c.type === 'text') shown += c.delta;
          out.push({ type: 'chunk', modelId: model.id, chunk: c });
        }
        held.length = 0;
        shownBy = model.id;
        state.committed = true;
        return out;
      };

      // Admin → Traces: one span per model attempt (obs/spans.ts).
      const span = startSpan(`model ${model.id}`, 'client', { model: model.id, attempt: i + 1 });
      try {
        // The first read is the connection: it is what the breaker judges.
        const opened = yield* this.open(model, effective, signal, Boolean(next), opts.computeWaitMs);
        iterator = opened.it;
        const it = iterator;
        let step = opened.step;

        while (!step.done) {
          const chunk = step.value;
          if (chunk.type === 'finish') this.note(model, chunk, purpose);
          if (!state.committed) {
            if (chunk.type === 'finish' && isRefusalFinish(chunk.finishReason)) {
              throw new ClassifiedError('refusal', `${model.display_name} declined (${chunk.finishReason})`);
            }
            held.push(chunk);
            if (chunk.type === 'text') heldText += chunk.delta;
            // Release as soon as the opening rules a refusal out (most answers,
            // after their first word), so nothing waits on the probe needlessly.
            const decided =
              heldText.length >= this.probeChars ||
              chunk.type === 'tool_call' ||
              chunk.type === 'finish' ||
              (!continuing && cannotBeRefusal(heldText));
            if (decided) {
              if (!continuing && looksLikeRefusal(heldText)) {
                throw new ClassifiedError('refusal', `${model.display_name} declined the request`);
              }
              yield* commit();
            }
          } else {
            if (chunk.type === 'text') shown += chunk.delta;
            yield { type: 'chunk', modelId: model.id, chunk };
          }
          step = await it.next();
        }

        if (!state.committed) {
          if (!continuing && looksLikeRefusal(heldText))
            throw new ClassifiedError('refusal', `${model.display_name} declined the request`);
          yield* commit();
        }
        span.end('ok', { chars: shown.length });
        return;
      } catch (err) {
        // A stop is not the model's failure: the span says so, and the walk ends here.
        span.end('error', {
          error: err instanceof Error ? err.message : String(err),
          ...(signal.aborted ? { aborted: true } : {}),
        });
        await iterator?.return?.().catch(() => undefined);
        if (signal.aborted) throw err;
        const cls = classify(err);
        const detail = err instanceof Error ? err.message : String(err);
        // A rate limit with a short Retry-After: wait, then ask the same model again, before any fallback.
        const wait = err instanceof ClassifiedError ? err.retryAfterMs : undefined;
        if (
          !state.committed &&
          cls === 'transient' &&
          wait !== undefined &&
          wait <= SHORT_RETRY_AFTER_MS &&
          (asked.get(model.id) ?? 0) < SAME_MODEL_RETRIES
        ) {
          asked.set(model.id, (asked.get(model.id) ?? 0) + 1);
          // A little extra, so the retry does not land on the very edge of the window.
          await this.sleep(wait + 250, signal);
          i -= 1;
          continue;
        }
        // A dropped connection: ask the same model again after a short, growing pause, before any fallback.
        const redo = reconnects.get(model.id) ?? 0;
        if (
          !state.committed &&
          cls === 'transient' &&
          model.provider !== 'ollama' &&
          isConnectionError(err) &&
          redo < CONNECTION_BACKOFF_MS.length
        ) {
          reconnects.set(model.id, redo + 1);
          await this.sleep(CONNECTION_BACKOFF_MS[redo] as number, signal);
          i -= 1;
          continue;
        }
        const named = (err instanceof ClassifiedError || err instanceof AncileError) && err.code ? err : null;
        const attempt: FailedAttempt = {
          model: model.id,
          errorClass: cls,
          detail,
          ...(named?.code && { code: named.code }),
          ...(named?.title && { title: named.title }),
          ...(named?.hint && { hint: named.hint }),
        };
        attempts.push(attempt);
        if (attempt.code === 'provider.model_not_permitted') {
          try {
            this.onModelRefused?.(model, attempt);
          } catch {
            /* noting a refusal must never fail the call */
          }
        }
        if (!next || !FALLBACKABLE.has(cls)) throw new ChainFailedError(attempts);
        yield { type: 'fallback', from: model.id, to: next.id, reason: cls, detail };
      }
    }
  }
}
