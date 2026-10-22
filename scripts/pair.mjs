#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  pnpm pair
 *  Ref      |  docs/api.md (Calling the API) · docs/getting-started.md
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Connect your browser to the NVX Ancile that `pnpm start`
 *           |  is running. Core answers only its owner, and a browser
 *           |  proves it is yours once, with a session it keeps for
 *           |  400 days. Until then the Cockpit says "Connect this
 *           |  browser".
 *  How      |  Reads the install key (data/local-api.key; the test
 *           |  profile's is in data/e2e), asks Core for a one-time code
 *           |  and opens the default browser at the address that spends
 *           |  it. Core sets the session cookie and sends the browser to
 *           |  the Cockpit. The key never goes into an address, and
 *           |  nothing printed here is the key or a code.
 *  Note     |  Flags: --e2e (the test profile)  --url=<address> (the
 *           |  Cockpit or Core address to open, e.g. a production
 *           |  Core)  --no-open (do not open a browser; print the
 *           |  one-time link instead, good for 60 seconds, once).
 * ------------------------------------------------------------------
 */

import net from 'node:net';
import { c, mark, readEnv } from './lib.mjs';
import { keyFileIn, noKeyHelp, openBrowser, pairUrl, readKeyFile } from './local-api.mjs';
import { composeEnv } from './runtime.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.includes('--e2e')) process.env.ANCILE_PROFILE = 'e2e';

// The dev server may listen on localhost only (IPv6 ::1 on Windows), so `localhost` is what to try:
// it resolves to whichever address the server took, and it is the host the browser uses.
const reachable = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: 'localhost' });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.setTimeout(1_500, () => {
      s.destroy();
      resolve(false);
    });
  });

function fail(message) {
  console.log(`\n${mark.fail} ${c.bold('Could not connect this browser')}\n  ${message}\n`);
  process.exit(1);
}

const env = composeEnv(readEnv());
const file = keyFileIn(env.ANCILE_DATA_DIR);
const key = readKeyFile(file);
if (!key) fail(noKeyHelp(file));

const coreUrl = `http://127.0.0.1:${env.ANCILE_PORT}`;
// The Cockpit's dev address when it is running (it forwards the API to Core), else Core's own.
const cockpitUp = await reachable(Number(env.COCKPIT_PORT));
const where = flag('url') ?? (cockpitUp ? `http://localhost:${env.COCKPIT_PORT}` : coreUrl);

let url;
try {
  url = await pairUrl({ coreUrl, key, where });
} catch (e) {
  fail(e.message);
}

if (args.includes('--no-open')) {
  console.log(
    `\n${mark.ok} Open this address in the browser you want to connect. It works once, for 60 seconds:\n\n  ${url}\n`,
  );
} else if (await openBrowser(url)) {
  console.log(`\n${mark.ok} Opened your browser to connect it to NVX Ancile ${c.dim(`· ${where}`)}\n`);
} else {
  fail(
    'No browser could be opened from here. Run pnpm pair --no-open and open the address it prints yourself.',
  );
}
