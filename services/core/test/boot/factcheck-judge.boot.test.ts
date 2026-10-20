/**
 * Roadmap FC2: a machine with Claude Code signed in and nothing else (no
 * provider key, no Ollama) must be able to fact-check. With the shipped
 * routing and model files, the judges are found by need (TR1), and when no chat
 * model is ready at all, the error says to add a key.
 */
import { resolve } from 'node:path';
import { AncileError } from '@nvx/contracts';
import { describe, expect } from 'vitest';
import { loadConfig } from '../../src/config/load';
import { syncClaudeCodeModels } from '../../src/engines/mode-a';
import { CLAUDE_CODE_JUDGE, judgeChain, verifierPlan } from '../../src/factcheck/steps';
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
    'Do not start Ancile on this build: a machine with only Claude Code signed in would be told no model is ready. Run `pnpm --filter @nvx/ancile-core test factcheck` for details.',
    async () => {
      const registry = await registryWith('signed_in');
      // Helper work aims small: Claude Code's quickest model leads.
      expect(judgeChain(registry, 'utility')[0]?.id).toBe(CLAUDE_CODE_JUDGE);
      // A fact-check aims at standard tier and finds a Claude Code model for it, whoever wrote the answer.
      for (const generatorFamily of [undefined, 'openai']) {
        const chain = judgeChain(registry, 'factcheck.verify', generatorFamily ? { generatorFamily } : {});
        expect(chain.length).toBeGreaterThan(0);
        expect(chain.every((m) => m.id.startsWith('claude-code/'))).toBe(true);
      }
    },
  );

  bootCheck(
    'with no chat model ready, the error says to add a key',
    'Routing by need must fail only when no chat model is ready, and then say how to fix it. Run `pnpm --filter @nvx/ancile-core test factcheck` for details.',
    async () => {
      for (const registry of [await registryWith('signed_out'), await registryWith('absent')]) {
        let err: unknown;
        try {
          judgeChain(registry, 'factcheck.verify');
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(AncileError);
        expect((err as AncileError).code).toBe('routing.no_chat_model');
        expect((err as AncileError).hint).toMatch(/Settings → Keys/);
      }
    },
  );

  bootCheck(
    'Claude Code writing an answer is still checked, and the check says the writer family did it',
    'A fact-check must never fail for lack of another family: it completes and says so. Run `pnpm --filter @nvx/ancile-core test factcheck` for details.',
    async () => {
      const registry = await registryWith('signed_in');
      const plan = verifierPlan(registry, { tier: 'balanced', generatorFamily: 'claude' });
      expect(plan.chain.length).toBeGreaterThan(0);
      expect(plan.degraded.join(' ')).toMatch(/writer's family/);
    },
  );
});
