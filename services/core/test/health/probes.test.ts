import { describe, expect, it } from 'vitest';
import { explainFetchFailure } from '../../src/health/probes';

const url = 'http://localhost:7710/ready';
const failed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

describe('explainFetchFailure', () => {
  it('turns undici codes into sentences a person can act on', () => {
    expect(explainFetchFailure(url, failed('ECONNREFUSED'))).toBe(
      'Nothing is answering at localhost:7710 (connection refused). The service is not running.',
    );
    expect(explainFetchFailure(url, failed('ENOTFOUND'))).toMatch(/could not be found/);
    expect(explainFetchFailure(url, Object.assign(new Error('x'), { name: 'TimeoutError' }))).toMatch(
      /did not answer in time/,
    );
  });

  it('never surfaces the bare "fetch failed"', () => {
    expect(explainFetchFailure(url, new TypeError('fetch failed'))).toBe(
      'localhost:7710 could not be reached (TypeError).',
    );
  });
});
