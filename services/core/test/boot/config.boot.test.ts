import { resolve } from 'node:path';
import { describe } from 'vitest';
import { loadConfig } from '../../src/config/load';
import { bootCheck } from './check';

const CONFIG_DIR = resolve(
  process.env.ANCILE_CONFIG_DIR ?? resolve(import.meta.dirname, '../../../../config'),
);

describe('configuration', () => {
  bootCheck(
    `every file in ${CONFIG_DIR} is valid`,
    'Open the file and key named in the error. Settings → Models and Settings → Routing rewrite these files for you, or restore them from git.',
    async () => {
      await loadConfig(CONFIG_DIR);
    },
  );
});
