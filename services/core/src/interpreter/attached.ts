/**
 * ------------------------------------------------------------------
 *  Title    |  Files python_run may open
 *  Ref      |  docs/interpreter.md (Files)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The thread's attachments: files added to its notebook
 *           |  (the composer's paperclip adds them there), narrowed by
 *           |  the thread's scope. Nothing else on this machine.
 *  How      |  Lists the notebook's sources from Knowledge, keeps the
 *           |  uploaded files the effective scope allows, and names
 *           |  each by its original file name. The Cockpit fetches
 *           |  only the ids Core put in the request.
 * ------------------------------------------------------------------
 */

import type { Source } from '@nvx/contracts';
import type { KnowledgeClient } from '../knowledge/client';
import { allowedSources, type ScopeResolver } from '../scopes';
import type { ThreadRepo } from '../threads/repo';
import type { AttachedFiles } from './tool';

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p;

export function attachedFiles(deps: {
  threads: Pick<ThreadRepo, 'getThread'>;
  kn: Pick<KnowledgeClient, 'get'>;
  scopes?: ScopeResolver;
}): AttachedFiles {
  return {
    async list(threadId) {
      if (!threadId) return [];
      const t = await deps.threads.getThread(threadId);
      if (!t?.notebook_id) return [];
      const r = await deps.kn.get<Source[] | { items: Source[] }>(
        `/notebooks/${encodeURIComponent(t.notebook_id)}/sources`,
      );
      const files = (Array.isArray(r) ? r : r.items).filter((s) => s.kind === 'file');
      const scope = await deps.scopes?.effective({ notebookId: t.notebook_id, threadId });
      const ids = scope
        ? new Set(
            allowedSources(
              scope,
              files.map((s) => s.id),
            ) ?? [],
          )
        : null;
      return files
        .filter((s) => !ids || ids.has(s.id))
        .map((s) => ({ source_id: s.id, name: baseName(s.uri ?? s.title), bytes: s.bytes ?? 0 }));
    },
  };
}
