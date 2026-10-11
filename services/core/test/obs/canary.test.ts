/**
 * Secrets never reach a log line (ROADMAP Phase 6, security review): a
 * canary key is logged every way the code base logs, and must not appear
 * in what the log store receives.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, setLogTap } from '../../src/obs/logger';
import { fakeModel } from '../gateway/fake-provider';
import { harness } from '../support/harness';

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

describe('API keys canary', () => {
  it('never returns or logs a key, whether it is saved or refused', async () => {
    const lines: string[] = [];
    setLogTap((l) => lines.push(JSON.stringify(l)));
    const [good, bad, hf, gh, runpod] = CANARIES as [string, string, string, string, string];
    const h = await harness({
      models: [{ ...fakeModel('c', 'echo'), id: 'anthropic/c', provider: 'anthropic', enabled: false }],
      // A provider that echoes the key back in its error, as some do.
      tester: async ({ key }) => {
        if (key === bad) throw Object.assign(new Error(`401 invalid x-api-key ${key}`), { status: 401 });
        return { model: 'anthropic/c' };
      },
      credentials: {
        serviceCheck: async (_id, token) => {
          throw new Error(`could not check ${token}`);
        },
        runpod: {
          connect: async (key) => {
            throw new Error(`RunPod refused ${key}`);
          },
          disconnect: async () => undefined,
        },
      },
    });
    try {
      const bodies: string[] = [];
      const call = async (method: string, path: string, body?: unknown) =>
        bodies.push(JSON.stringify((await h.call(method, path, body)).body));
      await call('PUT', '/credentials/anthropic', { value: good });
      await call('GET', '/credentials');
      await call('PUT', '/credentials/anthropic', { value: bad });
      await call('PUT', '/credentials/huggingface', { value: hf });
      await call('PUT', '/credentials/github', { value: gh });
      await call('PUT', '/credentials/runpod', { value: runpod });
      await call('DELETE', '/credentials/anthropic');
      expect(bodies).toHaveLength(7);
      const all = `${bodies.join('\n')}\n${lines.join('\n')}`;
      for (const key of CANARIES) expect(all).not.toContain(key.slice(-12));
    } finally {
      await h.close();
    }
  });
});
