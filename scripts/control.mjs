/**
 * ------------------------------------------------------------------
 *  Title    |  Runner control and log forwarding
 *  Ref      |  DESIGN.md §7.4, §11.5 · ROADMAP Phase 5
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Two things `pnpm start` does for Core while it runs the
 *           |  services natively:
 *           |  1. restart a service when Core's supervisor asks (the
 *           |     "process" restart adapter), over a loopback HTTP
 *           |     endpoint guarded by a token made fresh each start;
 *           |  2. forward the other services' log lines to Core, so
 *           |     Admin → Logs shows every service in one place.
 *  How      |  startControl() listens on 127.0.0.1 on a free port and
 *           |  returns its URL and token, which boot.mjs hands to Core
 *           |  in ANCILE_CONTROL_URL / ANCILE_CONTROL_TOKEN. Lines are
 *           |  batched once a second; if Core is down they are dropped
 *           |  (they are still on the terminal).
 * ------------------------------------------------------------------
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { killTree } from './lib.mjs';

/** @typedef {{ name: string, child: import('node:child_process').ChildProcess }} Running */

export async function startControl() {
  const token = randomBytes(24).toString('hex');
  /** @type {Record<string, () => Promise<void>>} */
  const restarters = {};
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'bad token' });
    const m = /^\/restart\/([a-z-]+)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !m) return reply(404, { error: 'not found' });
    const restart = restarters[m[1]];
    if (!restart) return reply(404, { error: `this runner does not manage ${m[1]}` });
    try {
      await restart();
      reply(200, { restarted: m[1] });
    } catch (err) {
      reply(500, { error: String(err?.message ?? err) });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    /** Register how to bring a service back. */
    on(name, fn) {
      restarters[name] = fn;
    },
    close: () => server.close(),
  };
}

/** Kill a child and wait (up to 10 s) for it to go. */
export async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  killTree(child);
  await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes is the point
const ANSI = /\x1b\[[0-9;]*m/g;

/** Forward a child's output lines to Core's log store. */
export function forwardLogs(child, service, opts) {
  let batch = [];
  let timer = null;
  const flush = async () => {
    timer = null;
    const lines = batch;
    batch = [];
    if (!lines.length) return;
    try {
      await fetch(`${opts.coreUrl}/internal/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ service, lines }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /* Core is starting or down: the lines are still on the terminal */
    }
  };
  const take = (stream, fallbackLevel) => {
    let buf = '';
    stream?.on('data', (chunk) => {
      buf += chunk.toString();
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.replace(ANSI, '').trim();
        if (!line) continue;
        let entry;
        if (line.startsWith('{')) {
          try {
            entry = JSON.parse(line);
          } catch {
            entry = null;
          }
        }
        // Plain text (uvicorn's access lines, Bun's output) is kept as a message.
        entry ??= {
          level: /error|exception|traceback/i.test(line) ? 'error' : fallbackLevel,
          msg: line.slice(0, 4000),
        };
        if (batch.length < 2_000) batch.push(entry);
        if (!timer) timer = setTimeout(flush, 1_000);
      }
    });
  };
  take(child.stdout, 'info');
  take(child.stderr, 'warn');
}
