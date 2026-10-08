/**
 * Desktop updates (NVX licensing and updates v2 §7): the channel is a
 * setting, and only a Pro install hands its licence token to the desktop
 * host for the update request.
 */
import { describe, expect, it } from 'vitest';
import { MemorySettings } from '../../src/settings';
import { updateInternalRoutes, updateRoutes } from '../../src/system/updates';

describe('desktop updates', () => {
  it('keeps the channel, stable by default, and refuses anything else', async () => {
    const settings = new MemorySettings();
    const app = updateRoutes({ settings });
    expect(await (await app.request('/system/updates')).json()).toEqual({ channel: 'stable' });
    const put = await app.request('/system/updates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'beta' }),
    });
    expect(put.status).toBe(200);
    expect(await (await app.request('/system/updates')).json()).toEqual({ channel: 'beta' });
    const bad = await app.request('/system/updates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'nightly' }),
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('gives the host the licence token only on a Pro install', async () => {
    const settings = new MemorySettings();
    await settings.set('license.token', 'h.p.s');
    const pro = await (
      await updateInternalRoutes({ settings, pro: () => true }).request('/desktop/updates')
    ).json();
    expect(pro).toEqual({ channel: 'stable', token: 'h.p.s' });
    const free = await (
      await updateInternalRoutes({ settings, pro: () => false }).request('/desktop/updates')
    ).json();
    expect(free).toEqual({ channel: 'stable', token: null });
  });
});
