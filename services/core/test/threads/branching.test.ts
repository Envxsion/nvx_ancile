import type {
  Branch,
  BranchTree,
  CompactResult,
  CompareResult,
  DeleteMessageResult,
  GlobalEvent,
  Message,
  PathBudget,
  ThreadPath,
} from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeModel } from '../../src/gateway/fake';
import { harness } from '../support/harness';

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Send on a parent and wait for the reply. */
async function turn(hh: H, threadId: string, text: string, parent: string | null) {
  const r = await hh.send(threadId, text, { parent_id: parent });
  await hh.settle(r.run_id);
  return r;
}

/** u1 a1 u2 a2 u3 a3, one straight line. */
async function line(hh: H, n = 3) {
  const t = await hh.newThread();
  let parent: string | null = null;
  const ids: { user: string; reply: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const r = await turn(hh, t, `Question ${i} about pumps and valves`, parent);
    ids.push({ user: r.user_message_id, reply: r.assistant_message_id });
    parent = r.assistant_message_id;
  }
  return { t, ids };
}

describe('the branch tree', () => {
  it('folds linear runs and marks the active path', async () => {
    h = await harness();
    const { t, ids } = await line(h, 3);
    // Edit the second question: a fork at a1.
    const fork = await turn(h, t, 'A different second question', ids[0]?.reply ?? null);
    const tree = (await h.call<BranchTree>('GET', `/threads/${t}/tree`)).body;
    expect(tree.total).toBe(8);
    // root run (u1 a1 folded), two sides after the fork, each folded into one node
    expect(tree.nodes).toHaveLength(3);
    const root = tree.nodes.find((n) => n.parent_id === null);
    expect(root?.collapsed).toBe(1);
    expect(root?.end_id).toBe(ids[0]?.reply);
    expect(root?.children).toBe(2);
    const sides = tree.nodes.filter((n) => n.parent_id === root?.id);
    expect(sides.map((n) => n.collapsed).sort()).toEqual([1, 3]);
    expect(tree.active_head_id).toBe(fork.assistant_message_id);
    expect(sides.find((n) => n.active)?.id).toBe(fork.user_message_id);
  });

  it('names a branch, follows its tip, and refuses a reply still being written', async () => {
    h = await harness();
    const { t, ids } = await line(h, 1);
    const at = ids[0]?.reply as string;
    const b = await h.call<Branch>('POST', `/messages/${at}/branch`, { name: 'Try metric units' });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ head_message_id: at, fork_message_id: at, color: 'azure' });

    const next = await turn(h, t, 'Use litres please', at);
    const list = (await h.call<{ items: Branch[] }>('GET', `/threads/${t}/branches`)).body.items;
    expect(list[0]?.head_message_id).toBe(next.assistant_message_id);

    const second = await h.call<Branch>('POST', `/messages/${at}/branch`, {});
    expect(second.body).toMatchObject({ name: 'Branch 2', color: 'jade' });

    const renamed = await h.call<Branch>('PATCH', `/branches/${b.body.id}`, {
      name: 'Metric',
      archived: true,
    });
    expect(renamed.body).toMatchObject({ name: 'Metric' });
    expect(renamed.body.archived_at).not.toBeNull();

    await h.repo.updateMessage(next.assistant_message_id, { status: 'streaming' });
    const refused = await h.call<{ error: { code: string } }>(
      'POST',
      `/messages/${next.assistant_message_id}/branch`,
      {},
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('branch.streaming');
  });

  it('stops at the asked message with ?exact=1 so a new branch can start there', async () => {
    h = await harness();
    const { t, ids } = await line(h, 2);
    const exact = (await h.call<ThreadPath>('GET', `/threads/${t}/path?head=${ids[0]?.reply}&exact=1`)).body;
    expect(exact.head_id).toBe(ids[0]?.reply);
    expect(exact.messages).toHaveLength(2);
    const leaf = (await h.call<ThreadPath>('GET', `/threads/${t}/path?head=${ids[0]?.reply}`)).body;
    expect(leaf.messages).toHaveLength(4);

    // A named branch pins its head: the thread opens there, ready for the first message on it.
    await h.call('POST', `/messages/${ids[0]?.reply}/branch`, {});
    await h.call('PATCH', `/threads/${t}`, { active_head_id: ids[0]?.reply });
    const pinned = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    expect(pinned.head_id).toBe(ids[0]?.reply);
    const sent = await turn(h, t, 'On the new branch', ids[0]?.reply ?? null);
    const moved = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    expect(moved.head_id).toBe(sent.assistant_message_id);
  });
});

describe('compare and merge', () => {
  it('compares two branches from their common ancestor', async () => {
    h = await harness();
    const { t, ids } = await line(h, 2);
    const other = await turn(h, t, 'Something else entirely', ids[0]?.reply ?? null);
    const res = await h.call<CompareResult>('POST', `/threads/${t}/compare`, {
      a: ids[1]?.reply,
      b: other.assistant_message_id,
    });
    expect(res.status).toBe(200);
    expect(res.body.lca_id).toBe(ids[0]?.reply);
    expect(res.body.shared).toBe(2);
    expect(res.body.a.message_ids).toEqual([ids[1]?.user, ids[1]?.reply]);
    expect(res.body.b.metrics.models).toEqual(['offline/test']);
    expect(res.body.comparison?.differences.length).toBeGreaterThan(0);
    expect(res.body.comparison_model).toBe('offline/test');
  });

  it('merges picked messages into a new thread with provenance and no shared rows', async () => {
    h = await harness();
    const { t, ids } = await line(h, 2);
    const other = await turn(h, t, 'Something else entirely', ids[0]?.reply ?? null);
    const res = await h.call<{ thread_id: string; head_id: string; copied: number }>('POST', '/merge', {
      thread_id: t,
      a: ids[1]?.reply,
      b: other.assistant_message_id,
      strategy: 'manual',
      picks: [ids[1]?.user, other.assistant_message_id],
    });
    expect(res.status).toBe(201);
    expect(res.body.copied).toBe(4); // u1 a1 shared, then two picks
    const merged = await h.repo.messages(res.body.thread_id);
    const root = merged.find((m) => m.parent_id === null) as Message;
    expect(root.role).toBe('system');
    expect(root.provenance).toMatchObject({ merge: { thread_id: t, strategy: 'manual' } });
    // One parent each: a line, not a graph.
    const parents = new Set(merged.map((m) => m.parent_id));
    expect(parents.size).toBe(merged.length);
    const last = merged.find((m) => m.id === res.body.head_id) as Message;
    expect(last.provenance).toMatchObject({
      merged_from: { thread_id: t, message_id: other.assistant_message_id, side: 'b' },
    });
    // The source thread is untouched.
    expect(await h.repo.messages(t)).toHaveLength(6);
  });

  it('synthesises one answer from both sides', async () => {
    h = await harness();
    const { t, ids } = await line(h, 1);
    const regen = await h.call<{ run_id: string; assistant_message_id: string }>(
      'POST',
      `/messages/${ids[0]?.reply}/regenerate`,
      {},
    );
    await h.settle(regen.body.run_id);
    const res = await h.call<{ thread_id: string; head_id: string; model_id: string }>('POST', '/merge', {
      thread_id: t,
      a: ids[0]?.reply,
      b: regen.body.assistant_message_id,
      strategy: 'synthesize',
    });
    expect(res.status).toBe(201);
    const merged = await h.repo.messages(res.body.thread_id);
    const head = merged.find((m) => m.id === res.body.head_id) as Message;
    expect(head.role).toBe('assistant');
    // The fork is the user message, so the answer sits directly under its copy.
    expect(merged.find((m) => m.id === head.parent_id)?.role).toBe('user');
    expect(JSON.stringify(head.parts)).toContain('[A]');
    expect(head.provenance).toMatchObject({ synthesized: true });
  });

  it('refuses a pick that is not after the fork', async () => {
    h = await harness();
    const { t, ids } = await line(h, 2);
    const res = await h.call<{ error: { code: string } }>('POST', '/merge', {
      thread_id: t,
      a: ids[1]?.reply,
      b: ids[0]?.reply,
      strategy: 'manual',
      picks: [ids[0]?.user],
    });
    expect(res.status).toBe(400);
  });
});

describe('compaction', () => {
  const tiny = { ...fakeModel('tiny', 'script'), context_window: 1_400, max_output: 100 };
  const opts = {
    models: [tiny],
    taskClasses: { 'chat.default': ['fake/tiny'], utility: ['fake/tiny'] },
    offline: false,
  };

  it('reports the budget, compacts on request, and reuses the summary across branches', async () => {
    h = await harness(opts);
    const { t, ids } = await line(h, 4);
    const before = (await h.call<PathBudget>('GET', `/threads/${t}/context-budget`)).body;
    expect(before.model_id).toBe('fake/tiny');
    expect(before.compaction).toBeNull();
    expect(before.compactable).toBeGreaterThan(0);

    const c = await h.call<CompactResult>('POST', `/threads/${t}/compact`, {});
    expect(c.status).toBe(201);
    expect(c.body.upto_message_id).toBe(ids[1]?.reply); // keeps the last 4 messages verbatim
    expect(c.body.tokens_after).toBeLessThan(c.body.tokens_before);

    const after = (await h.call<PathBudget>('GET', `/threads/${t}/context-budget`)).body;
    expect(after.compaction?.summary_id).toBe(c.body.summary_id);
    expect(after.used.history).toBeLessThan(before.used.history);

    // A branch off the last reply shares the compacted prefix: same summary, nothing new written.
    const branch = await turn(h, t, 'Another angle on question four', ids[3]?.reply ?? null);
    const again = await h.call<CompactResult>('POST', `/threads/${t}/compact`, {
      head: ids[3]?.reply,
    });
    expect(again.status).toBe(200);
    expect(again.body.reused).toBe(true);

    // The turn on the branch used the summary and says so.
    const reply = (await h.repo.getMessage(branch.assistant_message_id)) as Message;
    expect(reply.provenance).toMatchObject({ compaction: { summary_id: c.body.summary_id } });
    const sent = h.provider.calls.at(-1)?.req;
    expect(sent?.system).toContain('Summary of the earlier part of this conversation');
    expect(sent?.messages.some((m) => m.content.includes('Question 1'))).toBe(false);
  });

  it('compacts by itself past the critical line', async () => {
    h = await harness({ ...opts, models: [{ ...tiny, context_window: 1_000 }] });
    const { t, ids } = await line(h, 4);
    const last = await turn(h, t, 'And a fifth question about seals', ids[3]?.reply ?? null);
    const reply = (await h.repo.getMessage(last.assistant_message_id)) as Message;
    expect(reply.provenance).toMatchObject({ compaction: { auto: true } });
    expect(await h.branches.summaries(t, 'compaction')).toHaveLength(1);
  });

  it('says when there is nothing to compact', async () => {
    h = await harness();
    const { t } = await line(h, 1);
    const res = await h.call<{ error: { code: string } }>('POST', `/threads/${t}/compact`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('thread.nothing_to_compact');
  });
});

describe('deleting a subtree', () => {
  it('asks for the size, removes it, and undoes within 30 seconds', async () => {
    h = await harness();
    const { t, ids } = await line(h, 3);
    const target = ids[1]?.user as string;
    const ask = await h.call<{ error: { code: string; context: { subtree: number } } }>(
      'DELETE',
      `/messages/${target}`,
    );
    expect(ask.status).toBe(409);
    expect(ask.body.error.context.subtree).toBe(4);

    const del = await h.call<DeleteMessageResult>('DELETE', `/messages/${target}?confirm=4`);
    expect(del.status).toBe(200);
    expect(del.body.head_id).toBe(ids[0]?.reply);
    expect(await h.repo.messages(t)).toHaveLength(2);

    const undo = await h.call<{ restored: number }>('POST', `/messages/${target}/restore`, {});
    expect(undo.body.restored).toBe(4);
    expect(await h.repo.messages(t)).toHaveLength(6);
    expect((await h.repo.getThread(t))?.active_head_id).toBe(ids[2]?.reply);
  });

  it('does not restore a subtree whose parent has since been deleted', async () => {
    h = await harness();
    const { t, ids } = await line(h, 3);
    const inner = ids[2]?.user as string;
    const outer = ids[1]?.user as string;
    await h.call('DELETE', `/messages/${inner}?confirm=2`);
    await h.call('DELETE', `/messages/${outer}?confirm=2`);
    const res = await h.call<{ error: { code: string } }>('POST', `/messages/${inner}/restore`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('message.restore_parent_first');
    // Nothing came back as an orphan; undoing the outer delete first works.
    expect(await h.repo.messages(t)).toHaveLength(2);
    expect((await h.call('POST', `/messages/${outer}/restore`, {})).status).toBe(200);
    expect((await h.call('POST', `/messages/${inner}/restore`, {})).status).toBe(200);
    expect(await h.repo.messages(t)).toHaveLength(6);
  });

  it('cannot be undone after 30 seconds', async () => {
    h = await harness();
    const { ids } = await line(h, 1);
    const target = ids[0]?.reply as string;
    await h.call('DELETE', `/messages/${target}?confirm=1`);
    h.clock.now += 31_000;
    const late = await h.call<{ error: { code: string } }>('POST', `/messages/${target}/restore`, {});
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('message.undo_expired');
  });
});

describe('branch suggestions', () => {
  it('offers a branch when a message changes topic, and never branches by itself', async () => {
    h = await harness();
    const seen: GlobalEvent[] = [];
    h.bus.subscribe(0, (e) => seen.push(e));
    const t = await h.newThread();
    let parent: string | null = null;
    for (const q of [
      'How often should the pump impeller be inspected?',
      'What wear signs on the impeller matter most?',
      'Which pump impeller material resists cavitation?',
    ]) {
      parent = (await turn(h, t, q, parent)).assistant_message_id;
    }
    const shift = await turn(
      h,
      t,
      'Draft a birthday invitation for my grandmother Rosalind next Saturday',
      parent,
    );
    await new Promise((r) => setTimeout(r, 50));
    const s = seen.find((e) => e.type === 'suggestion');
    expect(s).toMatchObject({ kind: 'branch', ref: shift.user_message_id, thread_id: t });
    expect((await h.call<{ items: Branch[] }>('GET', `/threads/${t}/branches`)).body.items).toHaveLength(0);
  });
});
