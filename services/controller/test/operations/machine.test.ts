import { describe, expect, it } from 'vitest';
import {
  advance,
  checkTimeout,
  createOperation,
  InvalidTransition,
  precheck,
  resolveIdempotency,
  targetState,
} from '../../src/operations/machine';

const t0 = new Date('2026-10-07T10:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);
const fresh = () =>
  createOperation({
    id: 'opn_1',
    nodeId: 'nod_1',
    action: 'start',
    requestedBy: 'core',
    traceId: 'a'.repeat(32),
    now: t0,
  });
const err = { code: 'x', provider_message: 'nope', suggestion: 'do y' };

describe('confirmation chain', () => {
  it('walks requested → acknowledged → in_progress → confirmed', () => {
    let op = fresh();
    op = advance(op, 'acknowledged', 'ok', at(1));
    op = advance(op, 'in_progress', 'working', at(2));
    op = advance(op, 'confirmed', 'done', at(30));
    expect(op.status).toBe('confirmed');
    expect(op.timeline.map((s) => s.status)).toEqual([
      'requested',
      'acknowledged',
      'in_progress',
      'confirmed',
    ]);
    expect(op.updated_at).toBe(at(30).toISOString());
  });

  it('fills skipped links as implied so the chain always reads whole', () => {
    const op = advance(fresh(), 'confirmed', 'instant', at(1));
    expect(op.timeline.map((s) => s.status)).toEqual([
      'requested',
      'acknowledged',
      'in_progress',
      'confirmed',
    ]);
    expect(op.timeline[1]?.detail).toMatch(/implied/);
  });

  it('allows progress notes within a state', () => {
    let op = advance(fresh(), 'in_progress', 'pulling image', at(1));
    op = advance(op, 'in_progress', 'pulling image 40%', at(5));
    expect(op.status).toBe('in_progress');
    expect(op.timeline.filter((s) => s.status === 'in_progress')).toHaveLength(2);
  });

  it('fails from any live state, but only with an actionable error', () => {
    expect(() => advance(fresh(), 'failed', 'x', at(1))).toThrow(/suggestion/);
    const op = advance(advance(fresh(), 'acknowledged', 'ok', at(1)), 'failed', 'boom', at(2), err);
    expect(op.status).toBe('failed');
    expect(op.error).toEqual(err);
  });

  it('never moves backwards or out of a terminal state', () => {
    const ack = advance(fresh(), 'acknowledged', 'ok', at(1));
    expect(() => advance(ack, 'requested', 'x', at(2))).toThrow(InvalidTransition);
    const done = advance(ack, 'confirmed', 'ok', at(2));
    expect(() => advance(done, 'failed', 'x', at(3), err)).toThrow(InvalidTransition);
  });

  it('is immutable', () => {
    const op = fresh();
    advance(op, 'acknowledged', 'ok', at(1));
    expect(op.status).toBe('requested');
    expect(op.timeline).toHaveLength(1);
  });
});

describe('timeouts', () => {
  const budgets = { requested: 10_000, acknowledged: 20_000, in_progress: 60_000 };

  it('times out a state that outstays its budget, counted from when it was entered', () => {
    let op = advance(fresh(), 'in_progress', 'start', at(0));
    op = advance(op, 'in_progress', 'note', at(50)); // notes do not reset the clock
    expect(checkTimeout(op, at(59), budgets).status).toBe('in_progress');
    const timed = checkTimeout(op, at(61), budgets);
    expect(timed.status).toBe('timed_out');
    expect(timed.timeline.at(-1)?.detail).toMatch(/In progress/);
  });

  it('leaves terminal operations alone', () => {
    const done = advance(fresh(), 'confirmed', 'ok', at(1));
    expect(checkTimeout(done, at(10_000), budgets)).toBe(done);
  });
});

describe('idempotency', () => {
  it('replays the same request and rejects a different one with the same key', () => {
    const op = fresh();
    expect(resolveIdempotency(undefined, 'nod_1', 'start').kind).toBe('new');
    expect(resolveIdempotency(op, 'nod_1', 'start')).toEqual({ kind: 'replay', op });
    expect(resolveIdempotency(op, 'nod_1', 'stop').kind).toBe('conflict');
    expect(resolveIdempotency(op, 'nod_2', 'start').kind).toBe('conflict');
  });
});

describe('precheck', () => {
  it('treats an already-satisfied intent as a no-op', () => {
    expect(precheck('start', 'running', false)).toMatchObject({ ok: true, noop: true });
    expect(precheck('stop', 'stopped', false)).toMatchObject({ ok: true, noop: true });
  });
  it('refuses while another operation is live and on terminated nodes, with a fix', () => {
    const busy = precheck('stop', 'running', true);
    expect(busy.ok).toBe(false);
    const gone = precheck('start', 'terminated', false);
    expect(gone.ok === false && gone.error.suggestion).toMatch(/Create a new node/);
  });
  it('maps actions to target states', () => {
    expect(targetState('restart')).toBe('running');
    expect(targetState('terminate')).toBe('terminated');
  });
});
