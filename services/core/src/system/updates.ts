/**
 * ------------------------------------------------------------------
 *  Title    |  Desktop updates
 *  Ref      |  NVX licensing and updates v2 §7 · docs/desktop.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the desktop host needs to ask nvx.sh for updates:
 *           |  the channel this person chose, and the licence token
 *           |  (when one is held) to send as its Authorization header.
 *  How      |  GET/PUT /api/v1/system/updates: the channel (stable or
 *           |  beta), kept in settings. GET /internal/v1/desktop/
 *           |  updates (service token: only the desktop host has it):
 *           |  {channel, token}. The token is given in every edition:
 *           |  a Pro install whose licence lapsed is moved to the free
 *           |  build, and only the token lets it ask for Pro again once
 *           |  the licence is renewed. The host asks for the Pro edition
 *           |  when Pro is bundled or a token is held.
 *  Note     |  The token never appears in a log line or an /api reply.
 * ------------------------------------------------------------------
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { SettingsStore } from '../settings';

export const UpdateChannel = z.enum(['stable', 'beta']);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

const CHANNEL = 'updates.channel';
const TOKEN = 'license.token';

async function channelOf(settings: SettingsStore): Promise<UpdateChannel> {
  const v = UpdateChannel.safeParse(await settings.get(CHANNEL));
  return v.success ? v.data : 'stable';
}

/** The channel, for Settings: public, no token. */
export function updateRoutes(deps: { settings: SettingsStore }) {
  const r = new Hono<AppEnv>();
  r.get('/system/updates', async (c) => c.json({ channel: await channelOf(deps.settings) }));
  r.put('/system/updates', async (c) => {
    const req = await body(c, z.object({ channel: UpdateChannel }).strict());
    await deps.settings.set(CHANNEL, req.channel);
    return c.json({ channel: req.channel });
  });
  return r;
}

/** For the desktop host only (service token): the channel and the licence token, if any. */
export function updateInternalRoutes(deps: { settings: SettingsStore; pro: () => boolean }) {
  const r = new Hono<AppEnv>();
  r.get('/desktop/updates', async (c) => {
    const token = (await deps.settings.get<string>(TOKEN)) ?? null;
    c.header('cache-control', 'no-store');
    return c.json({ channel: await channelOf(deps.settings), token });
  });
  return r;
}
