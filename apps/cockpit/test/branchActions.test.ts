/**
 * Branching actions (lib/branching.ts): jump, branch here (with Undo back to
 * where you were), name, rename, recolour and archive a branch, compact,
 * merge and the confirmed subtree delete. Each sends one call, refreshes the
 * thread, and says plainly what went wrong when Core refuses or is not there.
 */
import type { Branch } from '@nvx/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ApiCallError, api, localError } from '../src/lib/api';
import * as br from '../src/lib/branching';
import { queryClient } from '../src/lib/query';
import { useNotify } from '../src/state/notify';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;
const B: Branch = {
  id: 'brn_1',
  name: 'Plan B',
  head_message_id: 'msg_h',
  color: 'jade',
} as unknown as Branch;
const toast = () => useNotify.getState().history[0];
const errors = () => useNotify.getState().history.filter((h) => h.level === 'error');

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  useNotify.setState({ toasts: [], history: [] });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
});

describe('moving around a thread', () => {
  it('jumps to a message by making it the active head', async () => {
    mocked.patch.mockResolvedValueOnce({});
    expect(await br.jumpTo('thr_1', 'msg_9')).toBe(true);
    expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { active_head_id: 'msg_9' });
    mocked.patch.mockRejectedValueOnce(new TypeError('offline'));
    expect(await br.jumpTo('thr_1', 'msg_9')).toBe(false);
    expect(toast()?.title).toBe("Jumping there didn't reach Core");
  });

  it('branches here, and Undo archives the branch and goes back to where you were', async () => {
    mocked.post.mockResolvedValueOnce(B);
    mocked.patch.mockResolvedValue({});
    const b = await br.branchHere('thr_1', 'msg_5', { name: 'Plan B', previousHead: 'msg_old' });
    expect(b?.id).toBe('brn_1');
    expect(mocked.post).toHaveBeenCalledWith('/messages/msg_5/branch', { name: 'Plan B' });
    expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { active_head_id: 'msg_h' });
    expect(toast()?.title).toBe('Plan B starts here');
    toast()?.undo?.();
    await vi.waitFor(() =>
      expect(mocked.patch).toHaveBeenCalledWith('/threads/thr_1', { active_head_id: 'msg_old' }),
    );
    expect(mocked.patch).toHaveBeenCalledWith('/branches/brn_1', { archived: true });
    mocked.post.mockRejectedValueOnce(new TypeError('offline'));
    expect(await br.branchHere('thr_1', 'msg_5')).toBeNull();
  });
});

describe('naming branches', () => {
  it('names, renames, recolours and archives, each with one call', async () => {
    mocked.post.mockResolvedValueOnce(B);
    mocked.patch.mockResolvedValue({});
    expect((await br.nameBranch('thr_1', 'msg_h', 'Plan B'))?.name).toBe('Plan B');
    expect(mocked.post).toHaveBeenCalledWith('/messages/msg_h/branch', {
      name: 'Plan B',
      created_by: 'suggestion',
    });
    await br.renameBranch('thr_1', 'brn_1', 'Plan C');
    await br.recolourBranch('thr_1', 'brn_1', 'amber' as never);
    await br.archiveBranch('thr_1', B);
    expect(mocked.patch.mock.calls).toEqual([
      ['/branches/brn_1', { name: 'Plan C' }],
      ['/branches/brn_1', { color: 'amber' }],
      ['/branches/brn_1', { archived: true }],
    ]);
    expect(toast()?.title).toBe('Removed the name Plan B');
    toast()?.undo?.();
    await vi.waitFor(() =>
      expect(mocked.patch).toHaveBeenLastCalledWith('/branches/brn_1', { archived: false }),
    );
  });

  it('a refusal is shown in Core’s words', async () => {
    const no = new ApiCallError(409, {
      error: {
        ...localError('branch.name_taken', 'That name is taken', 'Pick another name.', 't').error,
        context: {},
      },
    });
    mocked.patch.mockRejectedValue(no);
    mocked.post.mockRejectedValue(no);
    await br.renameBranch('thr_1', 'brn_1', 'x');
    await br.recolourBranch('thr_1', 'brn_1', 'amber' as never);
    await br.archiveBranch('thr_1', B);
    expect(await br.nameBranch('thr_1', 'msg_h', 'x')).toBeNull();
    expect(errors().map((e) => e.title)).toEqual(Array(4).fill('That name is taken'));
  });
});

describe('compacting, merging and deleting', () => {
  it('says how much lighter a compaction made the thread, or that a summary was reused', async () => {
    mocked.post.mockResolvedValueOnce({
      reused: false,
      tokens_before: 12_000,
      tokens_after: 2_000,
      replaced_messages: 14,
    });
    await br.compactNow('thr_1', 'msg_h');
    expect(mocked.post).toHaveBeenCalledWith('/threads/thr_1/compact', { head: 'msg_h' });
    expect(toast()?.body).toContain('14 older messages are now a summary, about 10,000 tokens lighter');
    mocked.post.mockResolvedValueOnce({
      reused: true,
      tokens_before: 1,
      tokens_after: 1,
      replaced_messages: 0,
    });
    await br.compactNow('thr_1');
    expect(toast()?.title).toBe('Already compacted');
    mocked.post.mockRejectedValueOnce(new TypeError('offline'));
    expect(await br.compactNow('thr_1')).toBeNull();
  });

  it('merges two paths and compares them', async () => {
    mocked.post.mockResolvedValueOnce({ thread_id: 'thr_2' });
    const req = { thread_id: 'thr_1', a: 'msg_a', b: 'msg_b', strategy: 'manual' as const };
    expect(await br.merge(req)).toEqual({ thread_id: 'thr_2' });
    expect(mocked.post).toHaveBeenCalledWith('/merge', req);
    mocked.post.mockResolvedValueOnce({ a: [], b: [] });
    await br.compare('thr_1', 'msg_a', 'msg_b');
    expect(mocked.post).toHaveBeenLastCalledWith('/threads/thr_1/compare', { a: 'msg_a', b: 'msg_b' });
    mocked.post.mockRejectedValueOnce(new TypeError('offline'));
    expect(await br.merge(req)).toBeNull();
  });

  it('asks how many messages a delete removes, then deletes them with Undo', async () => {
    mocked.del.mockRejectedValueOnce(
      new ApiCallError(409, {
        error: {
          ...localError('message.confirm_delete', 'This removes 3 messages', 'Confirm to delete them.', 't')
            .error,
          context: { subtree: 3 },
        },
      }),
    );
    expect(await br.subtreeSize('msg_5')).toBe(3);
    mocked.del.mockResolvedValueOnce({ deleted: 3 });
    mocked.post.mockResolvedValueOnce({});
    expect(await br.deleteSubtree('thr_1', 'msg_5', 3)).toBe(true);
    expect(mocked.del).toHaveBeenLastCalledWith('/messages/msg_5?confirm=3');
    expect(toast()?.title).toBe('Removed 3 messages');
    toast()?.undo?.();
    await vi.waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/messages/msg_5/restore', {}));
    mocked.del.mockRejectedValueOnce(new TypeError('offline'));
    expect(await br.subtreeSize('msg_5')).toBeNull();
    mocked.del.mockRejectedValueOnce(new TypeError('offline'));
    expect(await br.deleteSubtree('thr_1', 'msg_5', 3)).toBe(false);
  });

  it('keeps one branch suggestion per thread until it is dismissed', () => {
    const s = { threadId: 'thr_1', messageId: 'msg_1', title: 'A new topic', message: 'Branch here?' };
    br.useSuggestions.getState().offer(s);
    expect(br.useSuggestions.getState().byThread.thr_1).toEqual(s);
    br.useSuggestions.getState().dismiss('thr_1');
    expect(br.useSuggestions.getState().byThread.thr_1).toBeUndefined();
  });
});
