/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: Claude Code's side of a mixed thread
 *  Ref      |  docs/engines.md · docs/claude-code.md (Live sessions)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the live Claude Code layer (claudecode/live.ts)
 *           |  asks the engines module before a turn: where the
 *           |  session goes on from, what other engines said since its
 *           |  last turn, whether NVX Ancile's compaction must seed a
 *           |  fresh session, the appended system note, and what to
 *           |  do with a memory write.
 *  How      |  plan() checks the thread's scope first (Claude Code
 *           |  refused there is an AncileError before anything runs),
 *           |  reads the compaction summaries and which of them each
 *           |  session has seen, and hands the rest to
 *           |  planClaudeTurn (context.ts).
 *  Note     |  One compaction for mixed threads: NVX Ancile's summary
 *           |  is the record. A session that has not been given the
 *           |  summary that now applies starts afresh, seeded with it
 *           |  (docs/engines.md explains why not Claude Code's own
 *           |  /compact).
 * ------------------------------------------------------------------
 */

import type { LiveEngineHooks, LiveTurnPlan } from '../claudecode/live';
import type { BranchStore } from '../threads/branches';
import { compactedPath } from '../threads/compact';
import type { MessageRecord, ThreadRecord, ThreadRepo } from '../threads/repo';
import { pathTo, planClaudeTurn } from './context';
import type { ClaudeMemoryMirror } from './memory';
import { claudeSystemNote, effective } from './note';
import type { EngineStore } from './store';

export interface ClaudeHookDeps {
  threads: Pick<ThreadRepo, 'getThread'>;
  branches?: Pick<BranchStore, 'summaries'>;
  store: EngineStore;
  /** Display names for the digest ("GPT-5: …"). */
  modelName?: (id: string | null) => string | null;
  memory?: ClaudeMemoryMirror;
  /** Throws an AncileError when the thread's scope refuses Claude Code (engines/select.ts). */
  allow?: (thread: ThreadRecord, modelId: string | null) => Promise<void>;
  budget?: number;
}

/** The summary that applies to the path to this message, if any. */
export async function summaryFor(
  branches: Pick<BranchStore, 'summaries'> | undefined,
  threadId: string,
  messages: MessageRecord[],
  headId: string | null,
): Promise<{ id: string; uptoMessageId: string; content: string } | null> {
  if (!branches || !headId) return null;
  const summaries = await branches.summaries(threadId, 'compaction');
  if (!summaries.length) return null;
  const s = compactedPath(pathTo(messages, headId), summaries, 0).summary;
  return s ? { id: s.id, uptoMessageId: s.upto_message_id, content: s.content } : null;
}

export function claudeHooks(deps: ClaudeHookDeps): LiveEngineHooks {
  return {
    async plan({ thread, messages, parentId }): Promise<LiveTurnPlan> {
      await deps.allow?.(thread, null);
      const cc = thread.settings.claude_code;
      const [summary, seen] = await Promise.all([
        summaryFor(deps.branches, thread.id, messages, parentId),
        deps.store.seenForThread(thread.workspace_id, thread.id),
      ]);
      const p = planClaudeTurn({
        messages,
        parentId,
        threadSessionId: cc?.session_id ?? '',
        summary,
        seen: (sid, sum) => seen.get(sid) === sum,
        ...(deps.modelName && { names: deps.modelName }),
        cwd: cc?.cwd ?? null,
        ...(deps.budget !== undefined && { budget: deps.budget }),
      });
      const fresh = !!p.seed || (!p.anchor && parentId !== null);
      return {
        sessionId: p.sessionId,
        anchorId: p.anchor?.id ?? null,
        resumeAt: p.resumeAt,
        goneOn: p.goneOn,
        prefix: p.prefix,
        fresh,
        seedSummaryId: p.seed?.summaryId ?? null,
        report: p.prefix ? p.report : null,
      };
    },

    async systemNote({ threadId, notebookId, base }) {
      const [thread, nb] = await Promise.all([
        deps.threads.getThread(threadId),
        notebookId ? deps.store.notebookInstructions(notebookId) : Promise.resolve(null),
      ]);
      return claudeSystemNote(base, effective(thread?.settings.ancile, nb));
    },

    async seen({ workspaceId, threadId, sessionId, summaryId }) {
      await deps.store.markSeen(workspaceId, sessionId, threadId, summaryId);
    },

    ...(deps.memory && {
      toolDone: (e: Parameters<NonNullable<LiveEngineHooks['toolDone']>>[0]) =>
        (deps.memory as ClaudeMemoryMirror).onToolDone(e),
    }),
  };
}
