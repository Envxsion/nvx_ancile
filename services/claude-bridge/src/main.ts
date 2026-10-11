/**
 * ------------------------------------------------------------------
 *  Title    |  Claude bridge entry point
 *  Ref      |  services/claude-bridge/LICENSE (MIT) · docs/claude-code.md
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  A small separate program that reads Claude Code sessions
 *           |  through Anthropic's Agent SDK for NVX Ancile.
 *  How      |  MIT, a separate program; Core talks to it over a local
 *           |  WebSocket. Core starts it with ANCILE_BRIDGE_TOKEN (a
 *           |  per-launch secret) and ANCILE_BRIDGE_DATA_DIR. It listens
 *           |  on 127.0.0.1 at a random port and prints one line,
 *           |  "ANCILE_BRIDGE_READY {port, protocol, version}", on
 *           |  stdout. It exits when its stdin closes, so it never
 *           |  outlives Core.
 * ------------------------------------------------------------------
 */

import { PROTOCOL, READY_TAG } from './protocol';
import { ClaudeSdkLoader } from './sdk';
import { BRIDGE_VERSION, startServer } from './server';
import { log } from './util';

async function main() {
  const token = process.env.ANCILE_BRIDGE_TOKEN ?? '';
  const dataDir = process.env.ANCILE_BRIDGE_DATA_DIR ?? '';
  if (token.length < 24 || !dataDir) {
    log('error', 'ANCILE_BRIDGE_TOKEN (24+ characters) and ANCILE_BRIDGE_DATA_DIR are required');
    process.exit(78);
  }
  const sdk = new ClaudeSdkLoader({ dataDir });
  const server = await startServer({ token, sdk });
  process.stdout.write(
    `${READY_TAG} ${JSON.stringify({ port: server.port, protocol: PROTOCOL, version: BRIDGE_VERSION })}\n`,
  );
  log('info', 'listening', { port: server.port });

  const stop = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.stdin.resume();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  log('error', 'the bridge could not start', { err: (err as Error).message });
  process.exit(1);
});
