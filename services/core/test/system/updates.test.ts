/**
 * Desktop updates (NVX licensing and updates v2 §7): the channel is a
 * setting, the licence token goes to the desktop host for the update
 * request in every edition, and the host reports the update it offers so
 * the Cockpit can say Pro is ready, or that Pro ended.
 */
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/obs/errors';
import { MemorySettings } from '../../src/settings';
import { UpdateOfferBox, updateInternalRoutes, updateRoutes } from '../../src/system/updates';

describe('desktop updates', () => {
  it('keeps the channel, stable by default, and refuses anything else', async () => {
    const settings = new MemorySettings();
    const app = updateRoutes({ settings, offer: new UpdateOfferBox(() => false) });
    expect(await (await app.request('/system/updates')).json()).toEqual({
      channel: 'stable',
      beta_available: true,
    });
    const put = await app.request('/system/updates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'beta' }),
    });
    expect(put.status).toBe(200);
    expect(await (await app.request('/system/updates')).json()).toEqual({
      channel: 'beta',
      beta_available: true,
    });
    const bad = await app.request('/system/updates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'nightly' }),
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('gives the host the licence token in every edition, so a lapsed Pro install can come back to Pro', async () => {
    const settings = new MemorySettings();
    await settings.set('license.token', 'h.p.s');
    const pro = await (
      await updateInternalRoutes({ settings, offer: new UpdateOfferBox(() => true) }).request(
        '/desktop/updates',
      )
    ).json();
    expect(pro).toEqual({ channel: 'stable', token: 'h.p.s' });
    const free = await (
      await updateInternalRoutes({ settings, offer: new UpdateOfferBox(() => false) }).request(
        '/desktop/updates',
      )
    ).json();
    expect(free).toEqual({ channel: 'stable', token: 'h.p.s' });
    const none = await (
      await updateInternalRoutes({
        settings: new MemorySettings(),
        offer: new UpdateOfferBox(() => false),
      }).request('/desktop/updates')
    ).json();
    expect(none).toEqual({ channel: 'stable', token: null });
  });

  it('a Pro install whose licence was revoked still sends the last token, so nvx.sh can end Pro', async () => {
    // The Pro licence manager clears license.token on revoked, released and
    // bad_token, but keeps license.last_token for the updater.
    const settings = new MemorySettings();
    await settings.set('license.last_token', 'h.last.s');
    const internal = updateInternalRoutes({ settings, offer: new UpdateOfferBox(() => true) });
    expect(await (await internal.request('/desktop/updates')).json()).toEqual({
      channel: 'stable',
      token: 'h.last.s',
    });
    // A current token wins over the last one.
    await settings.set('license.token', 'h.now.s');
    const now = (await (await internal.request('/desktop/updates')).json()) as { token: string };
    expect(now.token).toBe('h.now.s');
  });

  const post = (b: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });

  it('keeps the offer the host reports and tells the Cockpit what kind it is', async () => {
    const settings = new MemorySettings();
    const at = new Date('2026-10-11T09:00:00Z');
    const freeBuild = new UpdateOfferBox(
      () => false,
      () => at,
    );
    const internal = updateInternalRoutes({ settings, offer: freeBuild });
    const pub = updateRoutes({ settings, offer: freeBuild });
    const read = async () => (await pub.request('/system/update-offer')).json();

    expect(await read()).toEqual({ offer: null });
    // A free install offered the Pro build: Pro is arriving.
    expect(
      (await internal.request('/desktop/update-offer', post({ version: '0.4.0', edition: 'pro' }))).status,
    ).toBe(200);
    expect(await read()).toEqual({
      offer: {
        version: '0.4.0',
        edition: 'pro',
        kind: 'pro',
        older: false,
        found_at: at.toISOString(),
        notes: null,
        size_bytes: null,
        state: 'available',
        progress: null,
        when: 'none',
        scheduled_for: null,
        error: null,
        previous_version: null,
      },
    });
    // The same edition: a plain update.
    await internal.request(
      '/desktop/update-offer',
      post({ version: '0.4.1', edition: 'free', downgrade: false }),
    );
    expect(freeBuild.get().offer?.kind).toBe('update');
    // Nothing newer any more: the host clears it.
    expect((await internal.request('/desktop/update-offer', { method: 'DELETE' })).status).toBe(200);
    expect(await read()).toEqual({ offer: null });

    // A Pro install whose licence ended: back to the free edition.
    const proBuild = new UpdateOfferBox(
      () => true,
      () => at,
    );
    const proInternal = updateInternalRoutes({ settings, offer: proBuild });
    await proInternal.request(
      '/desktop/update-offer',
      post({ version: '0.5.0', edition: 'free', downgrade: true }),
    );
    expect(proBuild.get().offer?.kind).toBe('downgrade');
    await proInternal.request('/desktop/update-offer', post({ version: '0.5.1', edition: 'pro' }));
    expect(proBuild.get().offer?.kind).toBe('update');
    // An older build (a rollback): the Cockpit warns as the tray does.
    await proInternal.request(
      '/desktop/update-offer',
      post({ version: '0.3.9', edition: 'pro', older: true }),
    );
    expect(proBuild.get().offer).toMatchObject({ kind: 'update', older: true });
  });

  it('refuses an offer that does not match the contract', async () => {
    const offer = new UpdateOfferBox(() => false);
    const internal = updateInternalRoutes({ settings: new MemorySettings(), offer });
    const bad = await internal.request('/desktop/update-offer', post({ version: '1.0.0', edition: 'gold' }));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const extra = await internal.request(
      '/desktop/update-offer',
      post({ version: '1.0.0', edition: 'pro', token: 'x' }),
    );
    expect(extra.status).toBeGreaterThanOrEqual(400);
    expect(offer.get()).toEqual({ offer: null });
  });
  it('keeps Beta for Pro: a free install stays on stable, and a Pro one that lapsed goes back to it', async () => {
    const settings = new MemorySettings();
    let pro = false;
    const deps = { settings, offer: new UpdateOfferBox(() => false), canBeta: () => pro };
    const app = updateRoutes(deps);
    app.onError(errorHandler);
    const put = (channel: string) =>
      app.request('/system/updates', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
    const refused = await put('beta');
    expect(refused.status).toBe(402);
    const err = (await refused.json()) as { error: { code: string; context: { feature: string } } };
    expect(err.error).toMatchObject({ code: 'pro.feature_required', context: { feature: 'desktop' } });
    expect((await put('stable')).status).toBe(200);
    pro = true;
    expect((await put('beta')).status).toBe(200);
    const internal = updateInternalRoutes(deps);
    expect(((await (await internal.request('/desktop/updates')).json()) as { channel: string }).channel).toBe(
      'beta',
    );
    // Pro ended while Beta was chosen: the next check asks for stable.
    pro = false;
    expect(((await (await internal.request('/desktop/updates')).json()) as { channel: string }).channel).toBe(
      'stable',
    );
    expect(await (await app.request('/system/updates')).json()).toEqual({
      channel: 'stable',
      beta_available: false,
    });
  });

  it('carries the notes, size, progress and what the person chose for the update', () => {
    const box = new UpdateOfferBox(
      () => false,
      () => new Date('2026-10-19T09:00:00Z'),
    );
    box.set({
      version: '0.1.1',
      edition: 'free',
      downgrade: false,
      older: false,
      notes: 'Fixes.',
      size_bytes: 1234,
      state: 'downloading',
      progress: 0.5,
      when: 'tonight',
      scheduled_for: '2026-10-20T03:00:00Z',
    });
    expect(box.get().offer).toMatchObject({
      notes: 'Fixes.',
      size_bytes: 1234,
      state: 'downloading',
      progress: 0.5,
      when: 'tonight',
    });
    const first = box.get().offer?.found_at;
    box.set({
      version: '0.1.1',
      edition: 'free',
      downgrade: false,
      older: false,
      state: 'ready',
      progress: 1,
    });
    expect(box.get().offer?.found_at).toBe(first);
    expect(box.get().offer?.state).toBe('ready');
  });
});
