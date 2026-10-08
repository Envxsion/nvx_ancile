import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe } from 'vitest';
import { GitMemoryProvider } from '../../src/memory/repo';
import { atRealBoot, bootCheck } from './check';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../../..');
const TEMPLATE = resolve(process.env.ANCILE_MEMORY_TEMPLATE_DIR ?? join(ROOT, 'memory-template'));
const MEMORY = resolve(process.env.ANCILE_DATA_DIR ?? join(ROOT, 'data'), 'memory');
const AUTHOR = { name: 'NVX Ancile', email: 'memory@ancile.local' };

describe('memory', () => {
  bootCheck(
    'git is installed (memory is a git repository)',
    'Install git (https://git-scm.com) and make sure `git --version` works in a new terminal.',
    async () => {
      await run('git', ['--version']);
    },
  );

  bootCheck(
    `the memory template is complete (${TEMPLATE})`,
    'Restore memory-template/ from git: `git checkout -- memory-template`.',
    () => {
      for (const f of ['AGENTS.md', 'USER.md', 'PROJECTS/_template.md'])
        if (!existsSync(join(TEMPLATE, f))) throw new Error(`${f} is missing from the memory template`);
    },
  );

  bootCheck(
    'the memory repository is intact',
    `Run \`git -C ${MEMORY} fsck\` to see what is wrong. Fix the file named in the error, or restore it from the file history in Memory.`,
    async () => {
      // At real boot, check the real repository once it exists; otherwise a fresh one from the template.
      if (atRealBoot && existsSync(join(MEMORY, '.git'))) {
        const r = await new GitMemoryProvider({ root: MEMORY, author: AUTHOR }).check();
        if (!r.ok) throw new Error(r.problems.join('\n'));
        return;
      }
      const dir = await mkdtemp(join(tmpdir(), 'ancile-boot-mem-'));
      try {
        const r = await new GitMemoryProvider({
          root: join(dir, 'm'),
          author: AUTHOR,
          template: TEMPLATE,
        }).check();
        if (!r.ok) throw new Error(r.problems.join('\n'));
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  );
});
