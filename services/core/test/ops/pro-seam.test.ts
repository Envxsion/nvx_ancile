/**
 * The open-core seam (DESIGN.md §9): a clone without pro/ runs the free
 * product; with pro/, Core calls its createPro(host); if Pro fails to
 * load, Core still starts, free.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPro } from '../../src/pro';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

const host = () => ({
  settings: new MemorySettings(),
  secrets: new MemorySecretStore(new SecretBox(randomBytes(32).toString('base64'))),
  keys: {},
  licenseUrl: 'https://licence.test',
  version: '0.0.0-test',
});

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('pro seam', () => {
  it('runs the free build when pro/ is empty, and says how to get Pro', async () => {
    const m = await loadPro({
      tier: undefined,
      host: host(),
      entry: join(tmpdir(), 'no-such-pro', 'index.ts'),
    });
    expect(m.build).toBe('free');
    await m.license.start();
    const d = await m.license.details();
    expect(d).toMatchObject({ build: 'free', key_held: false, status: { tier: 'free' } });
    expect(d.device_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.features.map((f) => f.id)).toEqual(['beam', 'team', 'sync', 'fleet', 'flow_lab', 'insights']);
    expect(d.features.every((f) => !f.unlocked)).toBe(true);
    await expect(m.license.activate('NVX-ABCD-EFGH-JK23')).rejects.toMatchObject({
      code: 'license.free_build',
    });
  });

  it('loads pro/ through createPro, and NVX_TIER=free never looks', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ancile-pro-'));
    const entry = join(dir, 'index.mjs');
    await writeFile(
      entry,
      `export const createPro = (host) => ({ build: 'pro', license: { marker: host.licenseUrl } });\n`,
    );
    const pro = await loadPro({ tier: undefined, host: host(), entry });
    expect(pro.build).toBe('pro');
    expect((pro.license as unknown as { marker: string }).marker).toBe('https://licence.test');
    expect((await loadPro({ tier: 'free', host: host(), entry })).build).toBe('free');
  });

  it('starts free when Pro is broken', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ancile-pro-'));
    const entry = join(dir, 'index.mjs');
    await writeFile(entry, `export const nothing = 1;\n`);
    expect((await loadPro({ tier: 'pro', host: host(), entry })).build).toBe('free');
  });
});
