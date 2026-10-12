/**
 * Fakes for notebook merge tests: the knowledge service's merge endpoints
 * (the same rules as services/knowledge/ancile_knowledge/sources/merge.py)
 * and the memory module's read, save and revert.
 */
import type { KnMergePreview, KnMergeRecord } from '@nvx/contracts';
import type { MergeKnowledge, MergeMemory } from '../../src/notebooks/merge';

export interface FakeSource {
  id: string;
  title: string;
  kind: string;
  uri: string | null;
  hash: string;
  deleted?: boolean;
}

export class FakeKnowledge implements MergeKnowledge {
  readonly sources = new Map<string, FakeSource>();
  /** notebook id → source id → context level */
  readonly links = new Map<string, Map<string, string>>();
  readonly calls: string[] = [];
  failMerge = false;

  add(notebookId: string, s: FakeSource, level = 'full') {
    this.sources.set(s.id, s);
    this.link(notebookId, s.id, level);
  }

  link(notebookId: string, sourceId: string, level = 'full') {
    const m = this.links.get(notebookId) ?? new Map<string, string>();
    m.set(sourceId, level);
    this.links.set(notebookId, m);
  }

  ids(notebookId: string): string[] {
    return [...(this.links.get(notebookId)?.keys() ?? [])].filter((id) => !this.sources.get(id)?.deleted);
  }

  private plan(into: string, from: string) {
    const a = this.ids(into).map((id) => this.sources.get(id) as FakeSource);
    const b = this.ids(from).map((id) => this.sources.get(id) as FakeSource);
    const aIds = new Set(a.map((s) => s.id));
    const out = {
      move: [] as FakeSource[],
      already: [] as FakeSource[],
      duplicates: [] as [FakeSource, FakeSource][],
      versions: [] as [FakeSource, FakeSource][],
    };
    for (const s of b) {
      if (aIds.has(s.id)) out.already.push(s);
      else {
        const same = a.find((x) => x.hash === s.hash);
        if (same) out.duplicates.push([s, same]);
        else {
          out.move.push(s);
          const other = a.find(
            (x) => (x.uri && x.uri === s.uri) || x.title.toLowerCase() === s.title.toLowerCase(),
          );
          if (other) out.versions.push([s, other]);
        }
      }
    }
    return out;
  }

  async get<T>(path: string): Promise<T> {
    this.calls.push(`GET ${path}`);
    const preview = /^\/notebooks\/([^/]+)\/merge-preview\?from=([^&]+)/.exec(path);
    if (preview) {
      const p = this.plan(decodeURIComponent(preview[1] ?? ''), decodeURIComponent(preview[2] ?? ''));
      const ref = (s: FakeSource) => ({ id: s.id, title: s.title });
      return {
        move: p.move.map(ref),
        already: p.already.map(ref),
        duplicates: p.duplicates.map(([s, i]) => ({ ...ref(s), into_id: i.id, into_title: i.title })),
        versions: p.versions.map(([s, i]) => ({ ...ref(s), into_id: i.id })),
      } satisfies KnMergePreview as T;
    }
    const list = /^\/notebooks\/([^/?]+)\/sources/.exec(path);
    if (list) {
      const nb = decodeURIComponent(list[1] ?? '');
      return this.ids(nb).map((id) => ({ id, title: this.sources.get(id)?.title })) as T;
    }
    throw new Error(`unexpected GET ${path}`);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push(`POST ${path}`);
    const b = body as { from_id: string; record?: KnMergeRecord };
    const undo = /^\/notebooks\/([^/]+)\/merge\/undo$/.exec(path);
    if (undo) {
      const into = decodeURIComponent(undo[1] ?? '');
      const r = b.record as KnMergeRecord;
      for (const m of r.merged) {
        const s = this.sources.get(m.source_id);
        if (s && m.deleted) s.deleted = false;
        this.link(b.from_id, m.source_id, m.context_level);
      }
      for (const l of [...r.moved, ...r.already]) this.link(b.from_id, l.source_id, l.context_level);
      for (const l of r.moved) this.links.get(into)?.delete(l.source_id);
      return { restored: 1 } as T;
    }
    const merge = /^\/notebooks\/([^/]+)\/merge$/.exec(path);
    if (merge) {
      if (this.failMerge) throw new Error('knowledge down');
      const into = decodeURIComponent(merge[1] ?? '');
      const p = this.plan(into, b.from_id);
      const level = (id: string) => this.links.get(b.from_id)?.get(id) ?? 'full';
      const rec: KnMergeRecord = {
        moved: p.move.map((s) => ({ source_id: s.id, context_level: level(s.id) })),
        already: p.already.map((s) => ({ source_id: s.id, context_level: level(s.id) })),
        merged: p.duplicates.map(([s, i]) => {
          const elsewhere = [...this.links].some(([nb, m]) => nb !== b.from_id && m.has(s.id));
          return {
            source_id: s.id,
            into_id: i.id,
            title: s.title,
            kind: s.kind,
            context_level: level(s.id),
            deleted: !elsewhere,
          };
        }),
      };
      for (const s of p.move) this.link(into, s.id, level(s.id));
      for (const m of rec.merged) if (m.deleted) (this.sources.get(m.source_id) as FakeSource).deleted = true;
      this.links.set(b.from_id, new Map());
      return rec as T;
    }
    throw new Error(`unexpected POST ${path}`);
  }
}

export class FakeMemory implements MergeMemory {
  readonly files = new Map<string, { content: string; version: string }>();
  readonly history: { version: string; path: string; before: string | null }[] = [];
  private n = 0;

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async save(path: string, content: string, base: string | null) {
    const cur = this.files.get(path);
    if ((cur?.version ?? null) !== base) throw new Error('memory conflict');
    const version = `c${++this.n}`;
    this.history.push({ version, path, before: cur?.content ?? null });
    this.files.set(path, { content, version });
    return { version };
  }

  async revert(version: string) {
    const h = this.history.find((x) => x.version === version);
    if (!h) throw new Error('no such commit');
    if (h.before === null) this.files.delete(h.path);
    else this.files.set(h.path, { content: h.before, version: `c${++this.n}` });
  }
}
