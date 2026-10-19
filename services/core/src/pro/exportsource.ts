/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: what an export reads
 *  Ref      |  ROADMAP.md EX3 (Pro half) · DESIGN.md §9
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Lend Pro's Word and PDF export (and the branch
 *           |  comparison) one branch of a thread with its parts,
 *           |  the tree to choose a second branch from, whether the
 *           |  sources an answer cited are still there, a stored
 *           |  image's bytes, and whether the thread keeps its data
 *           |  on this computer.
 *  How      |  A thin read-only adapter over the thread repository,
 *           |  the image store and the knowledge service. Nothing is
 *           |  written, and no file is made here: the document is
 *           |  built in Pro and goes back to the person who asked.
 *  Note     |  A thread in another workspace answers null. An
 *           |  unreadable source list answers null ("cannot tell"),
 *           |  which is not the same as "removed".
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';
import type { KnowledgeClient } from '../knowledge/client';
import { keepsLocal, type ScopeResolver } from '../scopes';
import type { MessageRecord, ThreadRepo } from '../threads/repo';

/** A message as an export sees it: its parts, not just its words. */
export interface ExportMessage {
  id: string;
  parent_id: string | null;
  role: 'user' | 'assistant';
  parts: Part[];
  status: string;
  model_id: string | null;
  model_name: string | null;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number; ms: number | null } | null;
  created_at: string;
}

/** One message in the tree, light enough to list every branch end. */
export interface ExportNode {
  id: string;
  parent_id: string | null;
  role: 'user' | 'assistant';
  model_name: string | null;
  created_at: string;
  /** The first words of it, for a branch's label. */
  preview: string;
}

export interface ProExportSource {
  thread(id: string): Promise<{
    id: string;
    title: string;
    notebook_id: string | null;
    active_head_id: string | null;
  } | null>;
  /** The messages from the root to `headId`, in order; null when the head is not in this thread. */
  branch(threadId: string, headId: string): Promise<ExportMessage[] | null>;
  /** Every message of the thread that was not deleted. */
  tree(threadId: string): Promise<ExportNode[]>;
  /** Which of these sources are still here; null when that cannot be told. */
  sourcesPresent(ids: string[]): Promise<Set<string> | null>;
  /** A stored image's bytes, or null when it is gone. */
  image(imageId: string, threadId: string): Promise<{ mime: string; bytes: Uint8Array } | null>;
  /** The thread's scope keeps its data on this computer (a private notebook, or data leaving is off). */
  keepsLocal(threadId: string): Promise<boolean>;
}

const textOfParts = (parts: Part[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');

const asView = (m: MessageRecord): ExportMessage => ({
  id: m.id,
  parent_id: m.parent_id,
  role: m.role === 'assistant' ? 'assistant' : 'user',
  parts: m.parts,
  status: m.status,
  model_id: m.model_id,
  model_name: typeof m.provenance?.model_name === 'string' ? m.provenance.model_name : null,
  usage: m.usage
    ? {
        input_tokens: m.usage.input_tokens,
        output_tokens: m.usage.output_tokens,
        cost_usd: m.usage.billed_usd ?? m.usage.cost_usd,
        ms: m.usage.ms ?? null,
      }
    : null,
  created_at: typeof m.created_at === 'string' ? m.created_at : new Date(m.created_at).toISOString(),
});

export function proExportSource(deps: {
  workspaceId: string;
  repo: Pick<ThreadRepo, 'getThread' | 'messages'>;
  scopes: ScopeResolver;
  images: { bytes(id: string): Promise<{ mime: string; data: string } | null> };
  imageThread: (imageId: string) => Promise<string | null>;
  kn: Pick<KnowledgeClient, 'get'>;
}): ProExportSource {
  const own = async (id: string) => {
    const t = await deps.repo.getThread(id);
    return t && t.workspace_id === deps.workspaceId ? t : null;
  };
  return {
    async thread(id) {
      const t = await own(id);
      return t
        ? { id: t.id, title: t.title, notebook_id: t.notebook_id, active_head_id: t.active_head_id }
        : null;
    },
    async branch(threadId, headId) {
      if (!(await own(threadId))) return null;
      const byId = new Map((await deps.repo.messages(threadId)).map((m) => [m.id, m]));
      const out: ExportMessage[] = [];
      const seen = new Set<string>();
      for (
        let cur = byId.get(headId);
        cur && !seen.has(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
      ) {
        seen.add(cur.id);
        if (!cur.deleted_at && (cur.role === 'user' || cur.role === 'assistant')) out.unshift(asView(cur));
      }
      return out.length ? out : null;
    },
    async tree(threadId) {
      if (!(await own(threadId))) return [];
      return (await deps.repo.messages(threadId))
        .filter((m) => !m.deleted_at && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({
          id: m.id,
          parent_id: m.parent_id,
          role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          model_name: typeof m.provenance?.model_name === 'string' ? m.provenance.model_name : null,
          created_at: typeof m.created_at === 'string' ? m.created_at : new Date(m.created_at).toISOString(),
          preview: textOfParts(m.parts).replace(/\s+/g, ' ').trim().slice(0, 80),
        }));
    },
    async sourcesPresent(ids) {
      if (!ids.length) return new Set();
      try {
        const all = await deps.kn.get<{ id: string }[]>(`/sources?workspace_id=${deps.workspaceId}`);
        return new Set(all.map((s) => s.id));
      } catch {
        return null;
      }
    },
    async image(imageId, threadId) {
      // Only an image that belongs to this thread: an id in a message is not enough to read another's.
      if ((await deps.imageThread(imageId).catch(() => null)) !== threadId) return null;
      const got = await deps.images.bytes(imageId).catch(() => null);
      return got ? { mime: got.mime, bytes: new Uint8Array(Buffer.from(got.data, 'base64')) } : null;
    },
    async keepsLocal(threadId) {
      const t = await own(threadId);
      if (!t) return true;
      return keepsLocal(await deps.scopes.effective({ threadId, notebookId: t.notebook_id }));
    },
  };
}
