/**
 * ------------------------------------------------------------------
 *  Title    |  Real-SDK smoke run (development only)
 *  Ref      |  services/claude-bridge/LICENSE (MIT)
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  Fetch the pinned Agent SDK into a temporary folder,
 *           |  verify it, and list this machine's five newest Claude
 *           |  Code sessions: title and message count only.
 *  How      |  pnpm --filter @nvx/claude-bridge exec tsx scripts/smoke.ts
 *  Note     |  Prints nothing else: no message content, no account
 *           |  details. Not run by any test.
 * ------------------------------------------------------------------
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkLoader } from '../src/sdk';

const dir = await mkdtemp(join(tmpdir(), 'ancile-sdk-smoke-'));
try {
  const sdk = await new ClaudeSdkLoader({ dataDir: dir }).load();
  const sessions = (await sdk.listSessions()).sort((a, b) => b.lastModified - a.lastModified).slice(0, 5);
  console.log(`sessions listed: ${sessions.length}`);
  for (const s of sessions) {
    const msgs = await sdk.getSessionMessages(s.sessionId);
    const title = (s.customTitle || s.summary || s.firstPrompt || '(untitled)').split('\n')[0]?.slice(0, 80);
    console.log(`${String(msgs.length).padStart(6)}  ${title}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
