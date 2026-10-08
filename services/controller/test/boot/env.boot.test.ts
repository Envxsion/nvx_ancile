/**
 * Boot suite (DESIGN.md §14): fast checks before the Controller accepts
 * traffic. Failures read as "VARIABLE: what is wrong. How to fix it."
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/env';
import { parseCron } from '../../src/rules/schedule';

describe('controller boot', () => {
  it('rejects a short token with the variable name and the fix', () => {
    expect(() => loadEnv({ CONTROLLER_TOKEN: 'short', CONTROLLER_STORE: 'memory' })).toThrow(
      /CONTROLLER_TOKEN: .*Set CONTROLLER_TOKEN/,
    );
  });

  it('requires DATABASE_URL for the postgres store', () => {
    expect(() => loadEnv({ CONTROLLER_TOKEN: 'x'.repeat(32) })).toThrow(/DATABASE_URL/);
  });

  it('accepts a minimal valid environment', () => {
    const env = loadEnv({
      CONTROLLER_TOKEN: 'x'.repeat(32),
      CONTROLLER_STORE: 'memory',
      CONTROLLER_PROVIDER: 'local',
    });
    expect(env.CONTROLLER_PORT).toBe(7720);
    expect(env.RUNPOD_API_BASE).toBe('https://api.runpod.io');
  });

  it('can evaluate time zones (ICU data present)', () => {
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Melbourne' })).not.toThrow();
    expect(parseCron('0 19 * * 1-5').hour.values.has(19)).toBe(true);
  });

  it('validates the live environment when the boot runner asks for it', () => {
    if (process.env.ANCILE_BOOT_LIVE !== '1') return;
    expect(() => loadEnv()).not.toThrow();
  });
});
