/**
 * ------------------------------------------------------------------
 *  Title    |  The install key, for scripts
 *  Ref      |  docs/api.md (Calling the API)
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Core's /api/v1 answers only the owner: a script with the
 *           |  install key, or a browser paired with it. This is how a
 *           |  script in this checkout finds the key of the profile it
 *           |  talks to, calls Core with it, and pairs a browser.
 *  How      |  The key is the file local-api.key in the profile's data
 *           |  folder (data/ for `pnpm start`, data/e2e/ for
 *           |  `pnpm start:e2e`). readLocalKey() reads it;
 *           |  localHeaders() is the Authorization header; pairUrl()
 *           |  asks Core for a one-time code and returns the address
 *           |  that turns it into a browser session; openBrowser() opens
 *           |  it. Nothing here prints the key or a code.
 *  Note     |  No dependencies on purpose (it runs before `pnpm i`).
 *           |  A child process is handed the key's FILE, never its
 *           |  value: environments are copied and logged, files are not.
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCAL_KEY_FILE = 'local-api.key';
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Where this profile's key is: <data folder>/local-api.key. */
export const keyFileIn = (dataDir) => join(dataDir, LOCAL_KEY_FILE);

/** The key in a file, or null when there is none (Core has not started on this data folder yet). */
export function readKeyFile(file) {
  if (!existsSync(file)) return null;
  const key = readFileSync(file, 'utf8').trim();
  return KEY_SHAPE.test(key) ? key : null;
}

/** The Authorization header that proves a script is the owner. */
export const bearer = (key) => ({ authorization: `Bearer ${key}` });

/** Why there is no key, in words for a person. */
export const noKeyHelp = (file) =>
  `There is no install key at ${file}. Core makes it the first time it starts: run pnpm start (or pnpm start:e2e for the test profile) and try again.`;

/**
 * A one-time code from Core and the address that spends it. `where` is the address the browser should
 * open (the Cockpit's dev address, or Core's own); the code is good for 60 seconds, once.
 */
export async function pairUrl({ coreUrl, key, where = coreUrl, next = '/' }) {
  let res;
  try {
    res = await fetch(`${coreUrl}/api/v1/session/pair-codes`, {
      method: 'POST',
      headers: bearer(key),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error(`Core is not answering at ${coreUrl}. Start it with pnpm start, then try again.`);
  }
  if (res.status === 401)
    throw new Error(
      'Core did not accept the install key. If Core was started before the key was replaced, restart it (pnpm stop, then pnpm start).',
    );
  if (!res.ok) throw new Error(`Core answered ${res.status} when asked for a pairing code.`);
  const { code } = await res.json();
  const url = new URL('/api/v1/session/pair', where);
  url.searchParams.set('code', code);
  if (next !== '/') url.searchParams.set('next', next);
  return url.toString();
}

/** Open an address in the default browser. Resolves to false when the system has no way to. */
export function openBrowser(url) {
  return new Promise((resolve) => {
    let child;
    try {
      if (process.platform === 'win32')
        // No shell in between, so nothing in the address is read as a command.
        child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore' });
      else if (process.platform === 'darwin') child = spawn('open', [url], { stdio: 'ignore' });
      else child = spawn('xdg-open', [url], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
    child.unref();
  });
}
