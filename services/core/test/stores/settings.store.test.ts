/**
 * Settings: the same rules from the in-memory store and the Postgres one.
 * Writing null clears a key (Pro's licence and sync, and telemetry, do this).
 */
import { beforeEach, expect, it } from 'vitest';
import { MemorySettings, PgSettings, type SettingsStore } from '../../src/settings';
import { eachBackend, uid } from '../support/stores';

eachBackend('settings store', (backend) => {
  let settings: SettingsStore;

  beforeEach(() => {
    const b = backend();
    settings = b.sql ? new PgSettings(b.sql) : new MemorySettings();
  });

  it('keeps values of every JSON shape', async () => {
    const key = uid('test.settings');
    for (const v of ['text', 42, false, { a: [1, 'b'] }, [true]]) {
      await settings.set(key, v);
      expect(await settings.get(key)).toEqual(v);
    }
  });

  it('clears a key when set to null or undefined', async () => {
    const key = uid('test.settings');
    await settings.set(key, 'token');
    await settings.set(key, null);
    expect(await settings.get(key)).toBeUndefined();
    await settings.set(key, 'again');
    await settings.set(key, undefined);
    expect(await settings.get(key)).toBeUndefined();
    // Clearing a key that was never set is fine too.
    await settings.set(uid('test.settings'), null);
  });
});
