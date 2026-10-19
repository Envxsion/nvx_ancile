/**
 * Roadmap FC2: a machine with Claude Code signed in and nothing else (no
 * provider key, no Ollama) must be able to fact-check. With the shipped
 * routing and model files, the judges are found, and when they cannot be,
 * the error names every model that was tried and why it was skipped.
 */
import { resolve } from 'node:path';
import { AncileError } from '@nvx/contracts';
import { describe, expect } from 'vitest';
import { loadConfig } from '../../src/config/load';
import { syncClaudeCodeModels } from '../../src/engines/mode-a';
import { CLAUDE_CODE_JUDGE, judgeChain } from '../../src/factcheck/steps';
import { ModelRegistry } from '../../src/gateway/registry';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';
import { bootCheck } from './check';

const CONFIG_DIR = resolve(
  process.env.ANCILE_CONFIG_DIR ?? resolve(import.meta.dirname, '../../../../config'),
);

async function registryWith(claude: 'signed_in' | 'signed_out' | 'absent') {
  const config = await loadConfig(CONFIG_DIR);
  const registry = new ModelRegistry({
    models: config.models?.models ?? [],
    taskClasses: config.routing?.task_classes ?? {},
    secrets: new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64'))),
    settings: new MemorySettings(),
    offline: false,
    // Ollama is installed but has pulled nothing.
    ollamaTags: async () => [],
  });
  await registry.refresh();
  if (claude !== 'absent')
    syncClaudeCodeModels(registry, {
      installed: true,
      version_ok: true,
      verification: { state: 'verified', error: null },
      signed_in: claude === 'signed_in',
      auth_method: 'claude.ai',
      plan: 'max',
    });
  return registry;
}

describe('fact-check judges', () => {
  bootCheck(
    'Claude Code alone (no keys, no Ollama) judges a fact-check',
    'Do not start Ancile on this build: a machine with only Claude Code signed in would be told "No model is ready to fact-check". Run `pnpm --filter @nvx/ancile-core test factcheck` for details.',
    async () => {
      const registry = await registryWith('signed_in');
      for (const task of ['utility', 'factcheck.verify']) {
        expect(judgeChain(registry, task).map((m) => m.id)).toEqual([CLAUDE_CODE_JUDGE]);
        // Strict (GR24) with a writer from another family: Claude Code still judges.
        expect(
          judgeChain(registry, task, { strict: true, generatorFamily: 'openai' }).map((m) => m.id),
        ).toEqual([CLAUDE_CODE_JUDGE]);
      }
    },
  );

  bootCheck(
    'with nothing ready, the error names each model that was tried and why',
    'The fact-check error must say what it tried. Run `pnpm --filter @nvx/ancile-core test factcheck` for details.',
    async () => {
      const signedOut = await registryWith('signed_out');
      let err: unknown;
      try {
        judgeChain(signedOut, 'factcheck.verify');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AncileError);
      const hint = (err as AncileError).hint;
      expect((err as AncileError).code).toBe('factcheck.no_model');
      expect(hint).toMatch(/no key saved/);
      expect(hint).toMatch(/Claude Code \(signed out\)/);
      expect(hint).toMatch(/Ollama/);

      const absent = await registryWith('absent');
      try {
        judgeChain(absent, 'utility');
      } catch (e) {
        err = e;
      }
      expect((err as AncileError).hint).toMatch(/Claude Code \(not installed or not verified\)/);
    },
  );

  bootCheck(
    'Claude Code writing an answer leaves no judge of another family, and the check says so',
    'GR24 must hold: a fact-check is never judged by the family that wrote the answer. Run `pnpm --filter @nvx/ancile-core test factcheck` for details.',
    async () => {
      const registry = await registryWith('signed_in');
      let err: unknown;
      try {
        judgeChain(registry, 'factcheck.verify', { strict: true, generatorFamily: 'claude' });
      } catch (e) {
        err = e;
      }
      expect((err as AncileError).code).toBe('factcheck.no_other_family');
    },
  );
});
