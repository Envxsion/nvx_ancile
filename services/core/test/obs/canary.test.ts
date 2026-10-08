/**
 * Secrets never reach a log line (ROADMAP Phase 6, security review): a
 * canary key is logged every way the code base logs, and must not appear
 * in what the log store receives.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, setLogTap } from '../../src/obs/logger';

const CANARIES = [
  'sk-ant-api03-CANARYcanary1234567890',
  'sk-or-v1-CANARYcanary1234567890abcd',
  'hf_CANARYcanary1234567890abcd',
  'ghp_CANARYcanary1234567890abcd',
  'rpa_CANARYcanary1234567890',
];

afterEach(() => setLogTap(null));

describe('log canary', () => {
  it('keeps keys out of messages, fields, nested objects and errors', () => {
    const lines: string[] = [];
    setLogTap((l) => lines.push(JSON.stringify(l)));
    const log = createLogger('trace');
    for (const key of CANARIES) {
      log.warn(`provider said: invalid key ${key}`);
      log.info({ api_key: key, headers: { authorization: `Bearer ${key}` } }, 'calling');
      log.error({ err: new Error(`401 for ${key}`) }, 'failed');
      log.info({ detail: { text: `echo ${key}` } }, 'nested');
      log.info('printf %s', key);
    }
    expect(lines.length).toBe(CANARIES.length * 5);
    const all = lines.join('\n');
    for (const key of CANARIES) expect(all).not.toContain(key.slice(-12));
  });
});
