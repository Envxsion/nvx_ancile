/**
 * LB3: GET and PUT /lab/settings. Format on edit is off until switched on,
 * and a PUT with anything else is refused.
 */
import { describe, expect, it } from 'vitest';
import { labRoutes } from '../../src/lab/routes';
import { MemorySettings, SETTING } from '../../src/settings';

function app() {
  const settings = new MemorySettings();
  const r = labRoutes({
    engine: null,
    repo: {} as never,
    runs: {} as never,
    worker: { kick: () => undefined },
    workspaceId: 'wsp_1',
    workspaceDir: '/tmp/ws',
    workspaceRoot: '/workspace',
    snapshotsDir: '/tmp/snaps',
    settings,
  });
  const call = (method: string, body?: unknown) =>
    r.request('/lab/settings', {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    });
  return { settings, call };
}

describe('lab settings', () => {
  it('format on edit is off by default, and can be switched on and off', async () => {
    const { settings, call } = app();
    expect(await (await call('GET')).json()).toEqual({ format_on_edit: false });
    expect(await (await call('PUT', { format_on_edit: true })).json()).toEqual({ format_on_edit: true });
    expect(await settings.get(SETTING.labFormat)).toBe(true);
    expect(await (await call('PUT', { format_on_edit: false })).json()).toEqual({ format_on_edit: false });
    expect(await settings.get(SETTING.labFormat)).toBeUndefined();
  });

  it('refuses an unknown field', async () => {
    const { call } = app();
    expect((await call('PUT', { shell: true })).status).toBeGreaterThanOrEqual(400);
  });
});
