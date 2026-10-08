import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect } from 'vitest';
import { CedarPolicy } from '../../src/permissions/cedar';
import { decide } from '../../src/permissions/decide';
import { depsWith, GOLDEN } from '../permissions/golden';
import { bootCheck } from './check';

// A broken permission engine must never serve traffic.
describe('permissions', () => {
  bootCheck(
    `the permission engine passes all ${GOLDEN.length} golden cases`,
    'Do not start Ancile on this build. Reinstall the last release, or run `pnpm --filter @nvx/ancile-core test` to see which case broke.',
    async () => {
      for (const c of GOLDEN) {
        const out = await decide(c.request, depsWith(c.grants));
        expect(out.outcome, c.name).toBe(c.expect.outcome);
      }
    },
  );
});

describe('policies', () => {
  bootCheck(
    'every policy file in config/policies parses and evaluates',
    'Fix the file and line named above, or move it out of config/policies. Policy syntax: https://docs.cedarpolicy.com/policies/syntax-policy.html',
    async () => {
      const dir = join(resolve(process.env.ANCILE_CONFIG_DIR ?? '../../config'), 'policies');
      const files: Record<string, string> = {};
      for (const f of await readdir(dir).catch(() => [] as string[]))
        if (f.endsWith('.cedar')) files[f] = await readFile(join(dir, f), 'utf8');
      for (const preset of ['careful', 'balanced', 'hands_off']) await CedarPolicy.load({ files, preset });
    },
  );
});
