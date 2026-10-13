/**
 * Lean Claude Code sessions, the thread's half: PATCH /threads/:id with
 * claude_code_lean sets the flag on the thread's Claude Code binding and
 * keeps the rest of it; a thread without a session says so.
 */
import type { Thread } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('PATCH /threads/:id claude_code_lean', () => {
  it("sets lean on the thread's Claude Code binding and keeps the rest", async () => {
    h = await harness();
    const t = await h.newThread();
    const binding = {
      session_id: 's1',
      cwd: 'C:/code/app',
      last_uuid: 'u9',
      synced_at: '2026-10-13T00:00:00Z',
      started_in: 'import' as const,
    };
    await h.repo.patchThread(t, { settings: { claude_code: binding } });
    const res = await h.call<Thread>('PATCH', `/threads/${t}`, { claude_code_lean: true });
    expect(res.status).toBe(200);
    expect(res.body.settings.claude_code).toEqual({ ...binding, lean: true });
    const off = await h.call<Thread>('PATCH', `/threads/${t}`, { claude_code_lean: false });
    expect(off.body.settings.claude_code?.lean).toBe(false);
  });

  it('refuses it on a thread with no Claude Code session', async () => {
    h = await harness();
    const t = await h.newThread();
    const res = await h.call<{ error: { code: string } }>('PATCH', `/threads/${t}`, {
      claude_code_lean: true,
    });
    expect(res.status).toBe(400);
  });
});
