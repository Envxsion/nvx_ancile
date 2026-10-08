import { randomBytes } from 'node:crypto';
import { describe, expect } from 'vitest';
import { EnvSchema, explainEnvErrors } from '../../src/env';
import { atRealBoot, bootCheck } from './check';

/** A complete, valid environment shaped like .env.example, for CI. */
function exampleEnv(): Record<string, string> {
  return {
    ANCILE_SECRET_KEY: randomBytes(32).toString('base64'),
    ANCILE_SERVICE_TOKEN: randomBytes(24).toString('base64url'),
    DATABASE_URL: 'postgres://ancile:pw@localhost:5433/ancile',
  };
}

describe('environment', () => {
  bootCheck(
    'the environment is valid',
    'Copy .env.example to .env and fill in the values it asks for. The error lists each variable that is wrong.',
    () => {
      const source = atRealBoot ? process.env : exampleEnv();
      const parsed = EnvSchema.safeParse(source);
      if (!parsed.success) throw new Error(explainEnvErrors(parsed.error));
    },
  );

  bootCheck(
    'Core refuses to listen on the network without a passphrase',
    'Set ANCILE_PASSPHRASE_REQUIRED=true, or keep ANCILE_HOST=127.0.0.1.',
    () => {
      const r = EnvSchema.safeParse({ ...exampleEnv(), ANCILE_HOST: '0.0.0.0', NODE_ENV: 'production' });
      expect(r.success).toBe(false);
    },
  );
});
