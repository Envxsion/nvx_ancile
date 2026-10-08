/**
 * ------------------------------------------------------------------
 *  Title    |  Merge two branches into a new thread
 *  Ref      |  DESIGN.md §8.3, prompts/threads/merge.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Bring the best of two branches together without making
 *           |  the tree a graph: the result is a NEW thread whose
 *           |  messages say where each one came from.
 *  How      |  The new thread opens with a system record of the merge,
 *           |  then a copy of the shared history up to the fork, then
 *           |  either the picked messages (manual) or one consolidated
 *           |  reply written by the utility model (synthesize). Every
 *           |  copy has exactly one parent and `provenance.merged_from`;
 *           |  nothing in the source thread changes.
 * ------------------------------------------------------------------
 */

import { AncileError, type MergeResult, type MergeThreadsRequest, type Part } from '@nvx/contracts';
import { ulid } from 'ulid';
import { badRequest } from '../obs/errors';
import { transcript } from './compact';
import { ancestorPath, lowestCommonAncestor } from './path';
import { asTree, type MessageRecord, type ThreadRecord, type ThreadRepo, type TreeRecord } from './repo';
import { runUtility, type UtilityDeps } from './utility';

const FALLBACK =
  'Combine these two branches into one answer, marking each point [A], [B] or [A, B].\n\nShared context:\n{{shared_context}}\n\nBranch A:\n{{branch_a}}\n\nBranch B:\n{{branch_b}}';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[…cut]` : s);

export const COMBINE_PROMPT = 'Combine what the two branches found into one answer.';

export function noModelToMerge(): AncileError {
  return new AncileError({
    code: 'thread.merge_no_model',
    title: 'No model could write the combined answer',
    hint: 'Pick the messages to keep yourself (Merge → Pick messages), or add a model in Settings → Models.',
    status: 503,
    errorClass: 'transient',
  });
}

export async function mergeBranches(
  deps: UtilityDeps & { repo: ThreadRepo },
  opts: {
    thread: ThreadRecord;
    messages: MessageRecord[];
    req: MergeThreadsRequest;
    traceId: string;
    signal?: AbortSignal;
  },
): Promise<MergeResult> {
  const { thread, req } = opts;
  const byId = new Map(asTree(opts.messages).map((m) => [m.id, m] as const));
  if (!byId.has(req.a) || !byId.has(req.b))
    throw badRequest('a, b: both heads must be messages in this thread');
  const pa = ancestorPath(byId, req.a);
  const pb = ancestorPath(byId, req.b);
  const { lca, aRest, bRest } = lowestCommonAncestor<TreeRecord>(pa, pb);
  const shared = lca ? pa.slice(0, pa.findIndex((m) => m.id === lca.id) + 1) : [];
  const side = new Map<string, 'a' | 'b'>([
    ...aRest.map((m) => [m.id, 'a'] as const),
    ...bRest.map((m) => [m.id, 'b'] as const),
  ]);

  let picks: TreeRecord[] = [];
  let synthesis: { text: string; modelId: string | null } | null = null;
  if (req.strategy === 'manual') {
    if (!req.picks.length) throw badRequest('picks: choose at least one message to carry over');
    const seen = new Set<string>();
    for (const id of req.picks) {
      const m = byId.get(id);
      if (!m || !side.has(id)) throw badRequest(`picks: ${id} is not on either branch after the fork`);
      if (seen.has(id)) throw badRequest(`picks: ${id} is listed twice`);
      seen.add(id);
      picks.push(m);
    }
  } else {
    if (!aRest.length && !bRest.length) throw badRequest('a, b: the branches are the same path');
    const res = await runUtility(deps, {
      promptId: 'threads.merge',
      fallback: FALLBACK,
      vars: {
        shared_context: clip(transcript(shared.slice(-6)) || '(none)', 6_000),
        branch_a: clip(transcript(aRest), 12_000),
        branch_b: clip(transcript(bRest), 12_000),
      },
      ...(opts.signal && { signal: opts.signal }),
      maxOutputTokens: 2_000,
    }).catch(() => null);
    if (!res?.text) throw noModelToMerge();
    synthesis = { text: res.text, modelId: res.modelId };
  }

  const title = req.title ?? `${thread.title} (merged)`.slice(0, 200);
  const created = await deps.repo.createThread({
    id: `thr_${ulid()}`,
    workspace_id: thread.workspace_id,
    title,
    notebook_id: thread.notebook_id,
    settings: { model: thread.settings.model ?? null },
  });

  let parent: string | null = null;
  let copied = 0;
  const add = async (
    m: { role: MessageRecord['role']; parts: Part[]; model_id?: string | null },
    provenance: Record<string, unknown>,
  ) => {
    const id = `msg_${ulid()}`;
    await deps.repo.insertMessage({
      id,
      thread_id: created.id,
      parent_id: parent,
      role: m.role,
      parts: structuredClone(m.parts),
      status: 'complete',
      model_id: m.model_id ?? null,
      trace_id: opts.traceId,
    });
    await deps.repo.updateMessage(id, { provenance });
    parent = id;
    return id;
  };

  const record = [
    `Merged from "${thread.title}".`,
    req.strategy === 'manual'
      ? `${picks.length} ${picks.length === 1 ? 'message was' : 'messages were'} picked from two branches after the fork.`
      : 'The two branches after the fork were combined into one answer.',
  ].join(' ');
  const rootId = await add(
    { role: 'system', parts: [{ type: 'text', text: record }] },
    {
      merge: {
        thread_id: thread.id,
        strategy: req.strategy,
        a: req.a,
        b: req.b,
        lca: lca?.id ?? null,
        picks: req.picks,
      },
    },
  );

  for (const m of shared) {
    if (m.role === 'system') continue;
    await add(m, { merged_from: { thread_id: thread.id, message_id: m.id, side: 'shared' } });
    copied++;
  }

  if (synthesis) {
    if (lca?.role !== 'user') {
      await add({ role: 'user', parts: [{ type: 'text', text: COMBINE_PROMPT }] }, { merge_prompt: true });
    }
    await add(
      { role: 'assistant', parts: [{ type: 'text', text: synthesis.text }], model_id: synthesis.modelId },
      {
        merged_from: [
          { thread_id: thread.id, message_id: req.a, side: 'a' },
          { thread_id: thread.id, message_id: req.b, side: 'b' },
        ],
        synthesized: true,
      },
    );
  } else {
    picks = picks.filter((m) => m.role !== 'system');
    for (const m of picks) {
      await add(m, { merged_from: { thread_id: thread.id, message_id: m.id, side: side.get(m.id) } });
      copied++;
    }
  }

  const head = parent ?? rootId;
  await deps.repo.patchThread(created.id, { active_head_id: head, root_message_id: rootId });
  return { thread_id: created.id, head_id: head, copied, model_id: synthesis?.modelId ?? null };
}
