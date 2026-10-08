/**
 * Secrets never reach a log line (ROADMAP Phase 6): a RunPod or provider
 * key in a message, a field, a nested object or an error is scrubbed.
 */
import { describe, expect, it } from 'vitest';
import { makeLogger } from '../../src/logger';

describe('log canary', () => {
  it('scrubs keys wherever they appear', () => {
    let out = '';
    const log = makeLogger({
      write: (s: string) => {
        out += s;
      },
    });
    for (const key of ['rpa_CANARYcanary1234567890', 'sk-or-v1-CANARYcanary1234567890abcd']) {
      log.warn(`RunPod said: invalid key ${key}`);
      log.info({ apiKey: key, detail: { text: `echo ${key}` } }, 'calling');
      log.error({ err: new Error(`401 for ${key}`) }, 'failed');
    }
    expect(out.split('\n').filter(Boolean)).toHaveLength(6);
    expect(out).not.toContain('CANARY');
  });
});
