/**
 * ------------------------------------------------------------------
 *  Title    |  Activity: assembly
 *  Ref      |  docs/activity.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Build the Activity service for main.ts from the run
 *           |  store, the thread repo and the Claude Code feature.
 *  How      |  Claude Code rows come from the service's session list,
 *           |  the read-only process look (holders.ts) and transcripts
 *           |  found the usual way (findTranscript), read incrementally
 *           |  (inflight.ts). A transcript entry is matched to its
 *           |  message through the thread's mirror, cached briefly.
 *  Note     |  The service also tells the Claude Code import when the
 *           |  person is typing, so a background pass waits.
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';
import type { SessionHolders } from '../claudecode/holders';
import { InflightScanner } from '../claudecode/inflight';
import type { ClaudeCodeService } from '../claudecode/service';
import type { ClaudeCodeStore } from '../claudecode/store';
import { findTranscript } from '../claudecode/transcript';
import type { EventBus } from '../events/bus';
import type { RunStore } from '../runs/engine';
import type { ThreadRepo } from '../threads/repo';
import { pgRunProgress } from './progress';
import { ActivityService } from './service';

const MIRROR_TTL_MS = 10_000;

export function createActivity(deps: {
  sql?: Sql;
  workspaceId: string;
  runs: Pick<RunStore, 'withStatus'>;
  threads: Pick<ThreadRepo, 'getThread'>;
  bus: EventBus;
  claude?: {
    service: ClaudeCodeService;
    store: ClaudeCodeStore;
    holders: Pick<SessionHolders, 'heldSessions'>;
    /** When NVX Ancile's own turns last wrote a session (claudecode/live.ts). */
    ownWriteAt: (sessionId: string) => number | null;
  };
}): ActivityService {
  const scanner = new InflightScanner();
  const mirrors = new Map<string, { at: number; byUuid: Map<string, string> }>();
  const cc = deps.claude;
  const activity = new ActivityService({
    runs: deps.runs,
    ...(deps.sql && { runProgress: pgRunProgress(deps.sql) }),
    threadTitle: async (id) => {
      const t = await deps.threads.getThread(id);
      return t && t.workspace_id === deps.workspaceId ? t.title : null;
    },
    bus: deps.bus,
    ...(cc && {
      claude: {
        installed: () => true,
        sessions: () => cc.service.recentSessions(),
        bindings: () => cc.store.sessions(deps.workspaceId),
        heldSessions: (q) => cc.holders.heldSessions(q),
        isLive: (id) => cc.service.isLive(id),
        ownWriteAt: cc.ownWriteAt,
        transcript: async (id) => findTranscript(await cc.service.projectsDir(), id),
        scan: (path) => scanner.scan(path),
        messageFor: async (threadId, uuid) => {
          let m = mirrors.get(threadId);
          if (!m || Date.now() - m.at > MIRROR_TTL_MS) {
            m = { at: Date.now(), byUuid: (await cc.store.mirror(threadId)).byUuid };
            mirrors.set(threadId, m);
            if (mirrors.size > 100) mirrors.delete(mirrors.keys().next().value as string);
          }
          return m.byUuid.get(uuid) ?? null;
        },
        importProgress: () => cc.service.importProgress(),
        excluded: async (cwd) => (cwd ? cc.service.folderExcluded(cwd) : false),
      },
    }),
  });
  cc?.service.setTypingProbe(() => activity.isTyping());
  return activity;
}
