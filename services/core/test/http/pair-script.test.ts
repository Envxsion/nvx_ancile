/**
 * `pnpm pair` and the dev scripts (scripts/local-api.mjs) against a real HTTP
 * server running Core's app: the script asks for a one-time code with the
 * install key, the address it builds spends the code, and the cookie that comes
 * back is the browser's way in. Also: a stranger on the same machine gets
 * nothing from the same server.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness, LOCAL_KEY } from '../support/harness';

interface LocalApi {
  pairUrl(o: { coreUrl: string; key: string; where?: string; next?: string }): Promise<string>;
  readKeyFile(file: string): string | null;
  keyFileIn(dir: string): string;
}
const script = (await import(
  pathToFileURL(join(import.meta.dirname, '../../../../scripts/local-api.mjs')).href
)) as LocalApi;

let h: Harness;
let server: ReturnType<typeof serve> | undefined;
const dirs: string[] = [];
afterEach(async () => {
  server?.close();
  server = undefined;
  await h?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function listen(): Promise<string> {
  h = await harness();
  const s = serve({ fetch: h.app.fetch, hostname: '127.0.0.1', port: 0 });
  server = s;
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('scripts/local-api.mjs', () => {
  it('reads the key from its file and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ancile-script-'));
    dirs.push(dir);
    const file = script.keyFileIn(dir);
    expect(script.readKeyFile(file)).toBeNull();
    writeFileSync(file, 'garbage');
    expect(script.readKeyFile(file)).toBeNull();
    writeFileSync(file, `${LOCAL_KEY}\n`);
    expect(script.readKeyFile(file)).toBe(LOCAL_KEY);
  });

  it('pairs a browser: a one-time address, a session cookie, and no key in the address', async () => {
    const core = await listen();
    const url = await script.pairUrl({ coreUrl: core, key: LOCAL_KEY, where: core, next: '/notebooks' });
    expect(url).not.toContain(LOCAL_KEY);
    expect(new URL(url).pathname).toBe('/api/v1/session/pair');

    const paired = await fetch(url, { redirect: 'manual' });
    expect(paired.status).toBe(303);
    expect(paired.headers.get('location')).toBe('/notebooks');
    const cookie = paired.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');
    expect(cookie[0]).toMatch(/^ancile_session_7700=/);

    // The browser, with its cookie, can read; a stranger on this machine, with nothing, cannot.
    expect((await fetch(`${core}/api/v1/threads`, { headers: { cookie: cookie.join('; ') } })).status).toBe(
      200,
    );
    expect((await fetch(`${core}/api/v1/threads`)).status).toBe(401);
    // The address works once.
    const again = await fetch(url, { redirect: 'manual' });
    expect(again.headers.get('location')).toBe('/?pair=failed');
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it('says what is wrong when Core does not accept the key, and never repeats it', async () => {
    const core = await listen();
    const wrong = 'W'.repeat(43);
    const err = await script.pairUrl({ coreUrl: core, key: wrong }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not accept the install key/);
    expect((err as Error).message).not.toContain(wrong);
  });

  it('says Core is not running when nothing answers', async () => {
    const err = await script
      .pairUrl({ coreUrl: 'http://127.0.0.1:9', key: LOCAL_KEY })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not answering/);
  });
});
