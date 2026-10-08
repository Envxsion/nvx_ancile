/**
 * ------------------------------------------------------------------
 *  Title    |  MCP stdio bridge
 *  Ref      |  DESIGN.md §4.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  For MCP clients that can only start a command: speaks
 *           |  JSON-RPC on stdin/stdout and forwards each message to
 *           |  NVX Ancile's /mcp endpoint with your token.
 *  How      |  pnpm --filter @nvx/ancile-core exec tsx src/mcp/stdio.ts
 *           |  with ANCILE_MCP_URL (default http://127.0.0.1:7700/mcp)
 *           |  and ANCILE_MCP_TOKEN set. Notifications get no reply,
 *           |  as the protocol says; everything else gets exactly one.
 * ------------------------------------------------------------------
 */

import { createInterface } from 'node:readline';

const url = process.env.ANCILE_MCP_URL ?? 'http://127.0.0.1:7700/mcp';
const token = process.env.ANCILE_MCP_TOKEN;

if (!token) {
  process.stderr.write('Set ANCILE_MCP_TOKEN to the token from NVX Ancile → Admin → Plugins.\n');
  process.exit(78);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg: { id?: unknown };
  try {
    msg = JSON.parse(line) as { id?: unknown };
  } catch {
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: line,
    });
    const text = await res.text();
    if (msg.id === undefined) return; // a notification: no reply
    if (text.trim()) process.stdout.write(`${text.trim()}\n`);
    else
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `NVX Ancile answered ${res.status}` } })}\n`,
      );
  } catch (err) {
    if (msg.id === undefined) return;
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `NVX Ancile is not reachable at ${url}: ${(err as Error).message}` } })}\n`,
    );
  }
});
