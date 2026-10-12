/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: what context packs read from Core
 *  Ref      |  docs/notebooks.md (Context packs) · DESIGN.md §9
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Context packs are Pro. This is the public half of their
 *           |  seam: sources from the knowledge service, a thread's
 *           |  summary, a place's instructions, and the scope check
 *           |  that decides where a pack may be attached.
 *  How      |  ProPackHost (pro/types.ts), built from Core's own parts.
 *           |  checkAttach uses the same rule as a context link
 *           |  (scopes/combine.ts): the place a pack is attached to
 *           |  reads every place the pack's items came from.
 *  Note     |  No pack logic lives here: storing, signing, exporting
 *           |  and assembling packs is Pro's (pro/core/packs).
 * ------------------------------------------------------------------
 */

import type { packs } from '@nvx/contracts';
import type { EngineStore } from '../engines/store';
import type { KnowledgeClient } from '../knowledge/client';
import type { NotebookRepo } from '../notebooks/repo';
import { checkLinkRead, keepsLocal, type ScopeResolver } from '../scopes';
import type { ThreadRepo } from '../threads/repo';
import type { ProPackHost } from './types';

const enc = encodeURIComponent;

export function proPackHost(deps: {
  workspaceId: string;
  kn: Pick<KnowledgeClient, 'get' | 'post'>;
  scopes: ScopeResolver;
  threads: Pick<ThreadRepo, 'getThread'>;
  notebooks: Pick<NotebookRepo, 'get'>;
  engines: Pick<EngineStore, 'notebookInstructions'>;
  summaryOf(threadId: string): Promise<string | null>;
}): ProPackHost {
  const ws = deps.workspaceId;
  const scopeOf = (p: packs.PackOrigin) =>
    deps.scopes.effective(p.kind === 'thread' ? { threadId: p.id } : { notebookId: p.id });
  const place: ProPackHost['place'] = async (p) => {
    if (p.kind === 'thread') {
      const t = await deps.threads.getThread(p.id);
      return t && t.workspace_id === ws ? { title: t.title, notebookId: t.notebook_id } : null;
    }
    const n = await deps.notebooks.get(p.id);
    return n && n.workspace_id === ws ? { title: n.title, notebookId: n.id } : null;
  };
  return {
    async sourceText(id) {
      const s = await deps.kn
        .get<{ id: string; title: string; kind: string }>(`/sources/${enc(id)}?workspace_id=${enc(ws)}`)
        .catch(() => null);
      if (!s) return null;
      const c = await deps.kn
        .get<{ markdown: string; content_hash?: string | null }>(
          `/sources/${enc(id)}/content?workspace_id=${enc(ws)}`,
        )
        .catch(() => null);
      return {
        id: s.id,
        title: s.title,
        kind: s.kind,
        content_hash: c?.content_hash ?? null,
        text: c?.markdown ?? '',
      };
    },
    async notebookSources(notebookId) {
      const r = await deps.kn.get<
        { id: string; title: string }[] | { items: { id: string; title: string }[] }
      >(`/notebooks/${enc(notebookId)}/sources?workspace_id=${enc(ws)}`);
      return (Array.isArray(r) ? r : r.items).map((s) => ({ id: s.id, title: s.title }));
    },
    async addTextSource({ title, text, notebookId }) {
      const s = await deps.kn.post<{ id: string }>('/sources', {
        workspace_id: ws,
        kind: 'text',
        title,
        text,
        notebook_ids: notebookId ? [notebookId] : [],
      });
      return { id: s.id };
    },
    summaryOf: deps.summaryOf,
    async instructionsOf(p) {
      if (p.kind === 'thread') {
        const t = await deps.threads.getThread(p.id);
        const a = t?.workspace_id === ws ? t.settings.ancile : undefined;
        return { instructions: a?.instructions ?? '', persona: a?.persona ?? '' };
      }
      const a =
        (await deps.notebooks.get(p.id))?.workspace_id === ws
          ? await deps.engines.notebookInstructions(p.id)
          : null;
      return { instructions: a?.instructions ?? '', persona: a?.persona ?? '' };
    },
    place,
    keepsLocal: async (p) => keepsLocal(await scopeOf(p)),
    async checkAttach(target, pack) {
      if (!(await place(target)))
        return { ok: false, code: 'request.not_found', reason: 'That place is not here' };
      const reader = await scopeOf(target);
      const name = `The context pack "${pack.name}"`;
      if (pack.local_only && reader.scope.data_leaves_machine)
        return {
          ok: false,
          code: 'scope.data_stays_local',
          reason: `${name} was made from something that stays on this machine, so it can only be attached where nothing leaves it either`,
        };
      for (const o of pack.origins) {
        if (!(await place(o))) continue;
        const r = checkLinkRead(reader, await scopeOf(o), name);
        if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
      }
      return { ok: true };
    },
  };
}
