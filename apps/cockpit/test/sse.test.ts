/**
 * openStream's close is idempotent: a caller whose onState('closed') handler
 * closes again (the fact-check follower does) must not recurse forever.
 * Live QA found "Maximum call stack size exceeded" on every fact-check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openStream } from '../src/lib/sse';

class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openStream', () => {
  it('closes once, even when its closed handler closes it again', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const states: string[] = [];
    let close: () => void = () => undefined;
    close = openStream({
      url: '/api/v1/runs/run_1/stream',
      schema: z.object({ seq: z.number() }),
      onEvent: () => undefined,
      onState: (s) => {
        states.push(s);
        if (s === 'closed') close();
      },
    });
    expect(() => close()).not.toThrow();
    expect(states.filter((s) => s === 'closed')).toHaveLength(1);
  });
});
