/**
 * ------------------------------------------------------------------
 *  Title    |  Repeated failing call guard
 *  Ref      |  ROADMAP LB1 · DESIGN.md §5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A model that keeps making the same tool call, and keeps
 *           |  getting the same failure, burns time and money for
 *           |  nothing. After a few identical failures in a row the
 *           |  turn stops, the model is told why, and so is the user.
 *  How      |  Each result is compared with the last: the same tool
 *           |  and the same arguments (key order, spacing and case in
 *           |  text ignored). A different call, or any success, starts
 *           |  the count again. A person declining a call does not
 *           |  count: that was their answer. Tools that are polled
 *           |  (spec.polls) get a higher limit so a back-off retry is
 *           |  not cut short. The state lives in the run's checkpoint,
 *           |  so a restart does not forget it.
 *  Note     |  Never silent: the model gets the reason in the tool
 *           |  result, the user gets a line in the answer, and the log
 *           |  records the tool and a hash, never the arguments.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';

/** Identical failing calls in a row that stop a turn. */
export const LOOP_LIMIT = 3;
/** The same, for a tool that is polled and may fail a few times on purpose. */
export const POLL_LIMIT = 6;

export interface LoopState {
  tool: string;
  /** Hash of the normalised call. */
  sig: string;
  /** Failures in a row for that call. */
  n: number;
}

/** Key order, spacing and letter case are not differences between two calls. */
function canon(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.trim().replace(/\s+/g, ' ').toLowerCase();
  if (Array.isArray(v)) return depth > 6 ? '…' : v.map((x) => canon(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 6) return '…';
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canon(x, depth + 1)]),
    );
  }
  return v;
}

export function callSignature(tool: string, args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([tool, canon(args)]))
    .digest('hex')
    .slice(0, 16);
}

export interface LoopStop {
  /** Added to the tool result the model reads next. */
  forModel: string;
  /** Added to the answer the user reads. */
  forUser: string;
  count: number;
  sig: string;
}

export interface Outcome {
  ok: boolean;
  /** What the tool said, for the user's line. */
  text: string;
  /** The person said no: not a failure of the call. */
  declinedByUser?: boolean;
}

const shorten = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Record one result. Returns the new state, and a stop when this was the
 * failure that reached the limit.
 */
export function noteResult(
  state: LoopState | undefined,
  call: { tool: string; args: unknown; polls?: boolean },
  outcome: Outcome,
): { state: LoopState | undefined; stop: LoopStop | null } {
  if (outcome.ok || outcome.declinedByUser) return { state: undefined, stop: null };
  const sig = callSignature(call.tool, call.args);
  const n = state && state.sig === sig ? state.n + 1 : 1;
  const next: LoopState = { tool: call.tool, sig, n };
  const limit = call.polls ? POLL_LIMIT : LOOP_LIMIT;
  if (n < limit) return { state: next, stop: null };
  return {
    state: next,
    stop: {
      count: n,
      sig,
      forModel: `Stop. This exact call to ${call.tool} has now failed ${n} times in a row. Do not make it again. Tell the user what is blocking you, or ask them for what you need.`,
      forUser: `I stopped because the same ${call.tool} call failed ${n} times in a row, and repeating it will not help. The last error was: "${shorten(outcome.text)}". Tell me how you want to go on, or change what you are asking for.`,
    },
  };
}
