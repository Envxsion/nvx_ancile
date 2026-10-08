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

import type { ErrorClass, ModelConfig } from '@nvx/contracts';
import { CircuitBreaker, ClassifiedError, classify, FALLBACKABLE } from '@nvx/resilience';
import { currentContext } from '../context';
import { startSpan } from '../obs/spans';
import { type NodeWaking, nodeWakingFrom, waitOrSkip } from './compute';
import { cannotBeRefusal, isRefusalFinish, looksLikeRefusal } from './refusal';
import type { GatewayEvent, ModelClient, ModelRequest, StreamChunk } from './types';

export interface GatewayOptions {
  client: ModelClient;
  breaker?: CircuitBreaker;
  /** Characters held back to detect a refusal before committing. 0 disables. */
  refusalProbeChars?: number;
  /** How long to wait for a GPU node to wake before falling back (ms). */
  computeWaitMs?: number;
  /** The shortest pause between asking a waking node again (ms). */
  computePollMs?: number;
}

export interface FailedAttempt {
  model: string;
  errorClass: ErrorClass;
  detail: string;
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

  constructor(opts: GatewayOptions) {
    this.client = opts.client;
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.probeChars = opts.refusalProbeChars ?? 160;
    this.computeWaitMs = opts.computeWaitMs ?? 5 * 60_000;
    this.computePollMs = opts.computePollMs ?? 2_000;
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
      if (computeWaitMs <= 0 || Date.now() - started > computeWaitMs)
        throw new ClassifiedError(
          'capacity',
          `${model.display_name}'s node did not wake within ${Math.max(1, Math.round(computeWaitMs / 60_000))} min`,
        );
      yield {
        type: 'compute_waiting',
        modelId: model.id,
        nodeId: w.nodeId,
        etaS: w.etaS,
        canUseCloud: hasNext,
        detail: w.message,
      };
      const pause = Math.max(this.computePollMs, Math.min(w.retryAfterS, 15) * 1000);
      if ((await waitOrSkip(pause, signal, runId)) === 'skip')
        throw new ClassifiedError('capacity', 'You chose a cloud model instead of waiting for the node');
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
    }
  }

  async *stream(
    chain: ModelConfig[],
    req: ModelRequest,
    signal: AbortSignal,
    opts: { computeWaitMs?: number } = {},
  ): AsyncGenerator<GatewayEvent> {
    const attempts: FailedAttempt[] = [];
    let shown = ''; // text the user has already seen, across models
    let shownBy: string | null = null;

    for (let i = 0; i < chain.length; i++) {
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
        span.end('error', { error: err instanceof Error ? err.message : String(err) });
        await iterator?.return?.().catch(() => undefined);
        if (signal.aborted) throw err;
        const cls = classify(err);
        const detail = err instanceof Error ? err.message : String(err);
        attempts.push({ model: model.id, errorClass: cls, detail });
        if (!next || !FALLBACKABLE.has(cls)) throw new ChainFailedError(attempts);
        yield { type: 'fallback', from: model.id, to: next.id, reason: cls, detail };
      }
    }
  }
}
