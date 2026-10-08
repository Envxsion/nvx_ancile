import { describe, expect, it } from 'vitest';
import {
  Bulkhead,
  BulkheadFullError,
  ChainExhaustedError,
  ClassifiedError,
  classify,
  classifyStatus,
  Deadline,
  DeadlineExceededError,
  instantClock,
  ManualClock,
  runChain,
  withTimeout,
} from '../src';

describe('classify', () => {
  it.each([
    [429, '', 'transient'],
    [500, '', 'transient'],
    [503, 'node_waking', 'capacity'],
    [529, '', 'capacity'],
    [402, 'cost_cap', 'policy'],
    [401, '', 'permanent'],
    [400, 'prompt is too long: 210000 tokens', 'context_overflow'],
    [400, 'blocked by content_filter', 'refusal'],
    [400, 'invalid param', 'permanent'],
  ] as const)('%i %s → %s', (status, msg, cls) => {
    expect(classifyStatus(status, msg)).toBe(cls);
  });

  it('reads network codes, timeouts, aborts and causes', () => {
    expect(classify(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('transient');
    expect(classify(new DeadlineExceededError(10))).toBe('transient');
    expect(classify(new DOMException('stop', 'AbortError'))).toBe('permanent');
    expect(classify(new Error('wrap', { cause: { status: 503 } }))).toBe('transient');
    expect(classify(new Error('who knows'))).toBe('bug');
    expect(classify({ finishReason: 'content-filter' })).toBe('refusal');
  });
});

describe('Deadline', () => {
  it('children never outlive parents', () => {
    const clock = instantClock(0);
    const d = Deadline.after(1000, clock);
    expect(d.child(5000).remaining()).toBe(1000);
    expect(d.child(200).remaining()).toBe(200);
  });
});

describe('withTimeout', () => {
  it('rejects with DeadlineExceededError and aborts the work', async () => {
    const clock = new ManualClock();
    let aborted = false;
    const p = withTimeout(
      (signal) =>
        new Promise<string>((_r, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted inside'));
          });
        }),
      { ms: 50, clock },
    );
    const settled = expect(p).rejects.toBeInstanceOf(DeadlineExceededError);
    await clock.advance(50);
    await settled;
    expect(aborted).toBe(true);
  });

  it('returns the value when the work finishes first', async () => {
    await expect(withTimeout(async () => 7, { ms: 1000, clock: new ManualClock() })).resolves.toBe(7);
  });
});

describe('Bulkhead', () => {
  it('caps concurrency and rejects past the queue limit', async () => {
    const b = new Bulkhead('k', 1, 1);
    let release!: () => void;
    const first = b.run(() => new Promise<void>((r) => (release = r)));
    const second = b.run(async () => 'second');
    await expect(b.run(async () => 'third')).rejects.toBeInstanceOf(BulkheadFullError);
    expect(b.inFlight).toBe(1);
    expect(b.queued).toBe(1);
    release();
    await first;
    await expect(second).resolves.toBe('second');
    expect(b.inFlight).toBe(0);
  });
});

describe('runChain', () => {
  it('falls through fallbackable errors and records every attempt', async () => {
    const seen: string[] = [];
    const out = await runChain(
      ['a', 'b', 'c'],
      async (t) => {
        if (t === 'a') throw new ClassifiedError('transient', 'a down', { status: 503 });
        if (t === 'b') throw new ClassifiedError('refusal', 'b refused');
        return `answer from ${t}`;
      },
      { clock: instantClock(), onFallback: (i) => seen.push(`${i.from}>${i.to}:${i.errorClass}`) },
    );
    expect(out.value).toBe('answer from c');
    expect(out.attempts.map((a) => a.class ?? 'ok')).toEqual(['transient', 'refusal', 'ok']);
    expect(out.attempts[0]?.status).toBe(503);
    expect(seen).toEqual(['a>b:transient', 'b>c:refusal']);
  });

  it('stops on context overflow: another model will not fix it here', async () => {
    let calls = 0;
    await expect(
      runChain(['a', 'b'], async () => {
        calls++;
        throw new ClassifiedError('context_overflow', 'too long');
      }),
    ).rejects.toBeInstanceOf(ChainExhaustedError);
    expect(calls).toBe(1);
  });
});
