/**
 * ------------------------------------------------------------------
 *  Title    |  Desktop updates
 *  Ref      |  NVX licensing and updates v2 §7 · docs/desktop.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the desktop host needs to ask nvx.sh for updates
 *           |  (the channel, and the licence token when one is held),
 *           |  and what it found, so the Cockpit can say so. Pro
 *           |  arrives and leaves only by update.
 *  How      |  GET/PUT /api/v1/system/updates: the channel (stable or
 *           |  beta), kept in settings. GET /internal/v1/desktop/
 *           |  updates (service token: only the desktop host has it):
 *           |  {channel, token}: license.token, else license.last_token
 *           |  (kept through a revocation, so nvx.sh can tell a Pro
 *           |  that ended from a fresh reinstall). It is given in every edition:
 *           |  a free install that turned a key on asks for Pro with
 *           |  it. POST /internal/v1/desktop/update-offer {version,
 *           |  edition, downgrade, older}: the update now waiting in the
 *           |  tray menu (older: a rollback the tray warns about);
 *           |  DELETE clears it. GET /api/v1/system/update-offer
 *           |  reads it back as update, pro (crossing to Pro) or
 *           |  downgrade (Pro ended: back to the free edition).
 *           |  The Beta channel is a Pro extra (feature `desktop`): a
 *           |  free install, or a Pro one that lapsed, stays on
 *           |  stable, and PUT beta answers 402 pro.feature_required.
 *  Note     |  The token never appears in a log line or an /api reply.
 *           |  The offer is kept in memory: the host reports it again
 *           |  after every check, and a restart (an install) clears it.
 * ------------------------------------------------------------------
 */

import { AncileError, license } from '@nvx/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { SettingsStore } from '../settings';

export const UpdateChannel = z.enum(['stable', 'beta']);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

const CHANNEL = 'updates.channel';
const TOKEN = 'license.token';
/**
 * The last token this install was given. Never cleared when the server
 * revokes or releases the licence, only when the person moves it to another
 * computer: nvx.sh measures the 90 days from it, and a Pro install that sends
 * no token is held (a fresh reinstall), not moved to the free edition.
 */
const LAST_TOKEN = 'license.last_token';

/** Asked at the moment of use: may this install follow the Beta channel? */
export type CanBeta = () => boolean;

async function channelOf(settings: SettingsStore, canBeta: CanBeta = () => true): Promise<UpdateChannel> {
  const v = UpdateChannel.safeParse(await settings.get(CHANNEL));
  return v.success && (v.data !== 'beta' || canBeta()) ? v.data : 'stable';
}

/** The update the host is offering, shared by the internal and public routes. */
export class UpdateOfferBox {
  private current: license.UpdateOffer['offer'] = null;

  constructor(
    /** Is this build Pro? A Pro offer to a free build is Pro arriving. */
    private readonly proBuild: () => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The offer as the shell last reported it (progress and state change as it works). */
  set(r: license.UpdateOfferReport): void {
    const kind: license.UpdateOfferKind = r.downgrade
      ? 'downgrade'
      : r.edition === 'pro' && !this.proBuild()
        ? 'pro'
        : 'update';
    this.current = {
      version: r.version,
      edition: r.edition,
      kind,
      older: r.older ?? false,
      // Kept from the first report of this version, so progress does not move "found at".
      found_at: this.current?.version === r.version ? this.current.found_at : this.now().toISOString(),
      notes: r.notes ?? null,
      size_bytes: r.size_bytes ?? null,
      state: r.state ?? 'available',
      progress: r.progress ?? null,
      when: r.when ?? 'none',
      scheduled_for: r.scheduled_for ?? null,
      error: r.error ?? null,
      previous_version: r.previous_version ?? null,
    };
  }

  clear(): void {
    this.current = null;
  }

  get(): license.UpdateOffer {
    return { offer: this.current };
  }
}

/** The channel and the update on offer, for Settings and Admin → Licence: public, no token. */
export function updateRoutes(deps: { settings: SettingsStore; offer: UpdateOfferBox; canBeta?: CanBeta }) {
  const r = new Hono<AppEnv>();
  r.get('/system/updates', async (c) =>
    c.json({
      channel: await channelOf(deps.settings, deps.canBeta),
      beta_available: deps.canBeta?.() ?? true,
    }),
  );
  r.put('/system/updates', async (c) => {
    const req = await body(c, z.object({ channel: UpdateChannel }).strict());
    if (req.channel === 'beta' && deps.canBeta && !deps.canBeta())
      throw new AncileError({
        code: 'pro.feature_required',
        title: 'The Beta channel is part of NVX Ancile Pro',
        hint: 'Turn on Pro in Admin → Licence. Updates stay on the stable channel until then.',
        status: 402,
        errorClass: 'permanent',
        context: { feature: 'desktop' },
      });
    await deps.settings.set(CHANNEL, req.channel);
    return c.json({ channel: req.channel });
  });
  r.get('/system/update-offer', (c) => {
    c.header('cache-control', 'no-store');
    return c.json(deps.offer.get());
  });
  return r;
}

/** For the desktop host only (service token): the channel and licence token, and what it found. */
export function updateInternalRoutes(deps: {
  settings: SettingsStore;
  offer: UpdateOfferBox;
  canBeta?: CanBeta;
}) {
  const r = new Hono<AppEnv>();
  r.get('/desktop/updates', async (c) => {
    const token =
      (await deps.settings.get<string>(TOKEN)) ?? (await deps.settings.get<string>(LAST_TOKEN)) ?? null;
    c.header('cache-control', 'no-store');
    return c.json({ channel: await channelOf(deps.settings, deps.canBeta), token });
  });
  r.post('/desktop/update-offer', async (c) => {
    deps.offer.set(await body(c, license.UpdateOfferReport));
    return c.json(deps.offer.get());
  });
  r.delete('/desktop/update-offer', (c) => {
    deps.offer.clear();
    return c.json(deps.offer.get());
  });
  return r;
}
