/**
 * ------------------------------------------------------------------
 *  Title    |  Settings store
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Typed key/value settings that belong to the install, not
 *           |  to a YAML file a person edits: onboarding state, the
 *           |  permission preset, models switched on by a key test.
 *  How      |  core.settings in Postgres; MemorySettings for tests.
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';

export interface SettingsStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class MemorySettings implements SettingsStore {
  private m = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.m.get(key) as T | undefined;
  }
  async set(key: string, value: unknown) {
    this.m.set(key, structuredClone(value));
  }
}

export class PgSettings implements SettingsStore {
  constructor(private readonly sql: Sql) {}

  async get<T>(key: string): Promise<T | undefined> {
    const rows = await this.sql<{ value: T }[]>`select value from core.settings where key = ${key}`;
    return rows[0]?.value;
  }

  async set(key: string, value: unknown): Promise<void> {
    const json = this.sql.json(value as never);
    await this.sql`
      insert into core.settings (key, value) values (${key}, ${json})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
}

export const SETTING = {
  setupComplete: 'setup.complete',
  preset: 'permissions.preset',
  /** { [modelId]: boolean } overrides on top of config/models.yaml */
  modelEnabled: 'models.enabled',
  /** { [modelId]: hue } chip colours chosen for config models (added models keep theirs inline). */
  modelHue: 'models.hue',
  /** auto_confident | propose_all | off; read by memory capture (Phase 4). */
  memoryCapture: 'memory.capture',
  /** Free text from onboarding, written into memory when Phase 4 lands. */
  memoryAbout: 'memory.about',
  /** Models you added in Settings → Models: ModelConfig[] (DESIGN §16.7). */
  customModels: 'models.custom',
  /** { [taskClass]: modelId[] } chains saved in Admin → Routing; they win over config/routing.yaml. */
  routingChains: 'routing.chains',
} as const;
