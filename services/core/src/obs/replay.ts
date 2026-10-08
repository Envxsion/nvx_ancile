/**
 * ------------------------------------------------------------------
 *  Title    |  Replay
 *  Ref      |  DESIGN.md §11.2 · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Step through a run as it happened, and re-run it from a
 *           |  chosen step with another model, without doing anything
 *           |  twice: no tool runs for real during a re-run.
 *  How      |  Steps come from the run's own event log (run_events):
 *           |  streamed text is folded into one step per stretch, a
 *           |  tool call and its result are one step, model choices,
 *           |  fallbacks, retrieval, memory and approvals are steps.
 *           |  A re-run keeps the answer's parts before the chosen
 *           |  tool call (steps before it stand as they were), and the
 *           |  new model continues. Any tool it calls is answered from
 *           |  the original run's record (same tool and arguments), or
 *           |  told plainly that it was not run.
 * ------------------------------------------------------------------
 */

import type { Part, ReplayStep, RunEvent, RunReplay } from '@nvx/contracts';

export interface RecordedCall {
  tool: string;
  args: unknown;
  ok: boolean;
  result: unknown;
}

/** What a re-run carries in its turn input. */
export interface ReplayInput {
  fromRunId: string;
  fromStep: number;
  calls: RecordedCall[];
}

const clip = (s: string, n = 280) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The finished tool calls in an answer's parts, in order. */
export function recordedCalls(parts: Part[]): RecordedCall[] {
  const results = new Map<string, { ok: boolean; result: unknown }>();
  for (const p of parts) if (p.type === 'tool_result') results.set(p.call_id, { ok: p.ok, result: p.result });
  const out: RecordedCall[] = [];
  for (const p of parts) {
    if (p.type !== 'tool_call') continue;
    const r = results.get(p.call_id);
    if (r) out.push({ tool: p.tool, args: p.args, ok: r.ok, result: r.result });
  }
  return out;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );

/**
 * The answer to a tool call during a re-run: the recorded result for the
 * same tool and arguments (each used once), or a plain refusal. Never runs
 * anything.
 */
export function replayedResult(
  replay: ReplayInput,
  used: number[],
  call: { tool: string; args: unknown },
): { ok: boolean; result: unknown; index: number | null } {
  const key = stable(call.args);
  const index = replay.calls.findIndex(
    (c, i) => !used.includes(i) && c.tool === call.tool && stable(c.args) === key,
  );
  if (index >= 0) {
    const c = replay.calls[index] as RecordedCall;
    return { ok: c.ok, result: c.result, index };
  }
  return {
    ok: false,
    result: `Not run: this is a replay, and tools have no effects in a replay. The original run did not call ${call.tool} with these arguments.`,
    index: null,
  };
}

/** Steps for the replay view, from the run's events. */
export function stepsFrom(events: RunEvent[]): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const toolSteps = new Map<string, ReplayStep>();
  let text: ReplayStep | null = null;
  let reasoning: ReplayStep | null = null;
  const push = (s: Omit<ReplayStep, 'n'>): ReplayStep => {
    const step = { ...s, n: steps.length } as ReplayStep;
    steps.push(step);
    return step;
  };
  const close = () => {
    text = null;
    reasoning = null;
  };

  for (const e of events) {
    switch (e.type) {
      case 'text.delta': {
        if (!text) {
          reasoning = null;
          text = push({
            kind: 'text',
            title: 'Wrote',
            detail: '',
            at: e.at ?? null,
            seqs: [],
            tool: null,
            rerunnable: false,
          });
        }
        text.detail = clip(`${text.detail ?? ''}${e.delta}`, 4_000);
        text.seqs.push(e.seq);
        break;
      }
      case 'reasoning.delta': {
        if (!reasoning) {
          text = null;
          reasoning = push({
            kind: 'reasoning',
            title: 'Thought',
            detail: '',
            at: e.at ?? null,
            seqs: [],
            tool: null,
            rerunnable: false,
          });
        }
        reasoning.detail = clip(`${reasoning.detail ?? ''}${e.delta}`, 4_000);
        reasoning.seqs.push(e.seq);
        break;
      }
      case 'tool.call': {
        close();
        const s = push({
          kind: 'tool',
          title: `Called ${e.tool}`,
          detail: null,
          at: e.at ?? null,
          seqs: [e.seq],
          tool: { name: e.tool, args: e.args_preview, ok: null, result: null },
          rerunnable: true,
        });
        toolSteps.set(e.call_id, s);
        break;
      }
      case 'tool.result': {
        const s = toolSteps.get(e.call_id);
        if (s?.tool) {
          s.tool.ok = e.ok;
          s.tool.result = e.preview;
          s.detail = clip(e.preview);
          s.seqs.push(e.seq);
        }
        break;
      }
      case 'model':
        close();
        push({
          kind: 'model',
          title: `${e.display_name} answered`,
          detail: e.model_id,
          at: e.at ?? null,
          seqs: [e.seq],
          tool: null,
          rerunnable: false,
        });
        break;
      case 'fallback':
        close();
        push({
          kind: 'fallback',
          title: `Switched from ${e.from_model} to ${e.to_model}`,
          detail: clip(e.detail),
          at: e.at ?? null,
          seqs: [e.seq],
          tool: null,
          rerunnable: false,
        });
        break;
      case 'retrieval.done':
        close();
        push({
          kind: 'retrieval',
          title: `Found ${e.chunks} ${e.chunks === 1 ? 'passage' : 'passages'} in ${e.sources} ${e.sources === 1 ? 'source' : 'sources'}`,
          detail: `${Math.round(e.ms)} ms`,
          at: e.at ?? null,
          seqs: [e.seq],
          tool: null,
          rerunnable: false,
        });
        break;
      case 'memory.injected':
        close();
        push({
          kind: 'memory',
          title: `Read memory from ${e.files.length} ${e.files.length === 1 ? 'file' : 'files'}`,
          detail: e.files.map((f) => `${f.path} (${f.entries})`).join(', ') || null,
          at: e.at ?? null,
          seqs: [e.seq],
          tool: null,
          rerunnable: false,
        });
        break;
      case 'approval.required':
        close();
        push({
          kind: 'approval',
          title: `Asked to ${e.action} ${e.resource}`,
          detail: e.tool,
          at: e.at ?? null,
          seqs: [e.seq],
          tool: null,
          rerunnable: false,
        });
        break;
      case 'approval.resolved':
        push({
          kind: 'approval',
          title: `Request ${e.decision}`,
          detail: null,
          at: e.at ?? null,
          seqs: [e.seq],
          tool: null,
          rerunnable: false,
        });
        break;
      case 'error':
        close();
        push({
          kind: 'status',
          title: e.title,
          detail: e.hint,
          at: e.at ?? null,
          seqs: [e.seq],
          tool: null,
          rerunnable: false,
        });
        break;
      case 'run.status':
        if (e.status === 'succeeded' || e.status === 'failed' || e.status === 'cancelled')
          push({
            kind: 'status',
            title: `Run ${e.status}`,
            detail: e.detail ?? null,
            at: e.at ?? null,
            seqs: [e.seq],
            tool: null,
            rerunnable: false,
          });
        break;
      default:
        break;
    }
  }
  // From the very start is always possible.
  const first = steps[0];
  if (first) first.rerunnable = true;
  return steps;
}

/**
 * The parts a re-run from `fromStep` starts with: everything in the answer
 * before the tool call that step made (nothing, from the start or from any
 * step before the first tool call).
 */
export function prefixFor(parts: Part[], steps: ReplayStep[], fromStep: number): Part[] {
  const toolIndex = steps.filter((s) => s.kind === 'tool' && s.n < fromStep).length;
  const target = steps.find((s) => s.n >= fromStep && s.kind === 'tool') ? toolIndex : null;
  if (fromStep <= 0 || target === null) {
    // From a step after the last tool call: keep every finished tool round.
    if (fromStep > 0 && target === null) return keepThroughLastResult(parts);
    return [];
  }
  let seen = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as Part;
    if (p.type === 'tool_call') {
      if (seen === target) return parts.slice(0, i).filter(notCitation);
      seen++;
    }
  }
  return keepThroughLastResult(parts);
}

const notCitation = (p: Part) => p.type !== 'citation_ref';

function keepThroughLastResult(parts: Part[]): Part[] {
  let last = -1;
  parts.forEach((p, i) => {
    if (p.type === 'tool_result') last = i;
  });
  return parts.slice(0, last + 1).filter(notCitation);
}

export function replayOf(opts: {
  run: {
    id: string;
    kind: string;
    status: string;
    traceId: string;
    threadId: string | null;
    messageId: string | null;
  };
  events: RunEvent[];
  modelId: string | null;
}): RunReplay {
  return {
    run_id: opts.run.id,
    kind: opts.run.kind,
    status: opts.run.status,
    trace_id: opts.run.traceId,
    thread_id: opts.run.threadId,
    message_id: opts.run.messageId,
    model_id: opts.modelId,
    steps: stepsFrom(opts.events),
    events: opts.events.map((e) => {
      const { seq, type, at, ...data } = e as RunEvent & { at?: string };
      return { seq, type, at: at ?? null, data };
    }),
  };
}
