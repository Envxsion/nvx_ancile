/**
 * ------------------------------------------------------------------
 *  Title    |  Settings store
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Typed key/value settings that belong to the install, not
 *           |  to a YAML file a person edits: onboarding state, the
 *           |  permission preset, models switched on by a key test.
 *  How      |  core.settings in Postgres; MemorySettings for tests.
 *  Note     |  Setting null or undefined clears the key: the column is
 *           |  NOT NULL, and every caller that writes null means "unset".
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';

export interface SettingsStore {
  get<T>(key: string): Promise<T | undefined>;
  /** null or undefined removes the key, so get() answers undefined. */
  set(key: string, value: unknown): Promise<void>;
}

export class MemorySettings implements SettingsStore {
  private m = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.m.get(key) as T | undefined;
  }
  async set(key: string, value: unknown) {
    if (value === null || value === undefined) this.m.delete(key);
    else this.m.set(key, structuredClone(value));
  }
}

export class PgSettings implements SettingsStore {
  constructor(private readonly sql: Sql) {}

  async get<T>(key: string): Promise<T | undefined> {
    const rows = await this.sql<{ value: T }[]>`select value from core.settings where key = ${key}`;
    return rows[0]?.value;
  }

  async set(key: string, value: unknown): Promise<void> {
    if (value === null || value === undefined) {
      await this.sql`delete from core.settings where key = ${key}`;
      return;
    }
    const json = this.sql.json(value as never);
    await this.sql`
      insert into core.settings (key, value) values (${key}, ${json})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
}

export const SETTING = {
  setupComplete: 'setup.complete',
  /** true: the coding lab formats the files a run edited (lab/format.ts). Off when absent. */
  labFormat: 'lab.format',
  preset: 'permissions.preset',
  /** { [modelId]: boolean } overrides on top of config/models.yaml */
  modelEnabled: 'models.enabled',
  /** { [modelId]: boolean }: models of a keyed provider you chose to show or hide beyond its starter three (MD2). */
  modelShown: 'models.shown',
  /** { [modelId]: hue } chip colours chosen for config models (added models keep theirs inline). */
  modelHue: 'models.hue',
  /**
   * { [family]: false } keeps what varies (date, ranked memory, notes, answer instructions) in the
   * system prompt for that model family, as before CA2. Absent or true: it goes at the end of the
   * request. Read per turn; the Flow lab's evals set it (docs/prompt-caching.md).
   */
  endContext: 'cache.end_context',
  /** auto_confident | propose_all | off; read by memory capture (Phase 4). */
  memoryCapture: 'memory.capture',
  /** The mode memory capture goes back to when it is switched on again (Admin → Automations). */
  memoryCaptureLastOn: 'memory.capture.last_on',
  /** Free text from onboarding, written into memory when Phase 4 lands. */
  memoryAbout: 'memory.about',
  /** Models you added in Settings → Models: ModelConfig[] (DESIGN §16.7). */
  customModels: 'models.custom',
  /** { [taskClass]: modelId[] } chains saved in Admin → Routing; they win over config/routing.yaml. */
  routingChains: 'routing.chains',
  /** { [lineId]: LineState }: follow, current, previous and pending per model line (models/watch/linebook.ts). */
  modelLines: 'models.lines',
  /** Ids of models added from the model watch (they are stored with the added models). */
  watchAdded: 'models.watch_added',
  /** { [modelId]: { reason, at } }: models a provider refused for good on a test call (F3c). */
  modelUnavailable: 'models.unavailable',
  /** { [provider]: ProviderCheckState }: how the last check of each provider went. */
  watchChecks: 'models.watch.checks',
  /** { openrouter_prices: boolean }: the model watch's own settings. */
  watchSettings: 'models.watch.settings',
  /** ClaudeCodeSettings: Settings → Claude Code (docs/claude-code.md). */
  claudeCode: 'claude_code',
  /** { tokens, at }: the input of the latest Claude Code first turn that loaded the whole setup (lean comparison). */
  claudeCodeFullFirstTurn: 'claude_code.full_first_turn',
} as const;
