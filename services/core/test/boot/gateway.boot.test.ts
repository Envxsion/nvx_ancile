import { CircuitBreaker } from '@nvx/resilience';
import { describe, expect } from 'vitest';
import { Gateway } from '../../src/gateway/gateway';
import { FakeProvider, fakeModel } from '../gateway/fake-provider';
import { bootCheck } from './check';

describe('gateway', () => {
  bootCheck(
    'a stream survives its first model failing',
    'Do not start Ancile on this build: self-healing is broken. Run `pnpm --filter @nvx/ancile-core test` for details.',
    async () => {
      const gw = new Gateway({ client: new FakeProvider(), breaker: new CircuitBreaker() });
      let text = '';
      for await (const e of gw.stream(
        [fakeModel('a', 'fail:500'), fakeModel('b', 'say:ready')],
        { messages: [] },
        new AbortController().signal,
      )) {
        if (e.type === 'chunk' && e.chunk.type === 'text') text += e.chunk.delta;
      }
      expect(text).toBe('ready');
    },
  );
});
