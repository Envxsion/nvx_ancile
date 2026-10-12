/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: the gateway's side of a mixed thread
 *  Ref      |  docs/engines.md (Context for each engine)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The conductor's engine hook: every model round gets the
 *           |  thread's and notebook's instructions and persona, and a
 *           |  thread holding Claude Code's turns gets its history
 *           |  fitted for the model (assembleForGateway) instead of
 *           |  every tool output Claude Code ever read.
 *  How      |  A path with no other engine's turns keeps the
 *           |  conductor's own history (historyFor and §8.4 compaction)
 *           |  untouched; only the instructions are added.
 * ------------------------------------------------------------------
 */

import type { EngineContextHook } from '../conductor/pipeline';
import { servedWindow } from '../gateway/ollama-chat';
import { approxTokens } from '../memory/inject';
import type { ThreadRepo } from '../threads/repo';
import { assembleForGateway, isMixed, pathTo } from './context';
import { effective, instructionsNote } from './note';
import type { EngineStore } from './store';

export function gatewayContextHook(deps: {
  threads: Pick<ThreadRepo, 'getThread'>;
  store: Pick<EngineStore, 'notebookInstructions'>;
  keepTurns?: number;
}): EngineContextHook {
  return async (a) => {
    const [thread, nb] = await Promise.all([
      deps.threads.getThread(a.threadId),
      a.notebookId ? deps.store.notebookInstructions(a.notebookId) : Promise.resolve(null),
    ]);
    const instructions = instructionsNote(effective(thread?.settings.ancile, nb));
    const path = pathTo(a.messages, a.userMessageId);
    if (!a.model || !isMixed(path)) return { history: null, note: '', instructions, report: null };
    const c = a.compaction;
    const out = assembleForGateway({
      path,
      summary: c
        ? { id: c.summaryId, uptoMessageId: c.skipThrough, content: c.note.slice(c.note.indexOf('\n\n') + 2) }
        : null,
      window: servedWindow(a.model),
      maxOutput: a.model.max_output,
      fixedTokens: a.fixedTokens + approxTokens(instructions),
      cwd: thread?.settings.claude_code?.cwd ?? null,
      ...(deps.keepTurns !== undefined && { keepTurns: deps.keepTurns }),
    });
    return { history: out.messages, note: out.note, instructions, report: out.report };
  };
}
