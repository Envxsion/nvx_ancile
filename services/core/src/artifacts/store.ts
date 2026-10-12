/**
 * ------------------------------------------------------------------
 *  Title    |  Artifacts: what a thread made, and what was decided
 *  Ref      |  docs/artifacts.md · packages/contracts/src/artifacts.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  List every artifact a thread's answers wrote, each with
 *           |  its versions (every answer that wrote the same key, on
 *           |  any branch, regenerations included), and keep the one
 *           |  decision a person makes about an artifact: whether it
 *           |  may reach the network.
 *  How      |  Artifacts are not stored twice: they are parsed from
 *           |  the answers (parseArtifacts in contracts, the same code
 *           |  the Cockpit uses). Only answers whose parts mention
 *           |  "artifact" are read, so a 20,000-message thread costs a
 *           |  trigram-indexed filter, not every part.
 *  Note     |  Network is off unless core.artifact_settings says
 *           |  otherwise for that thread and key.
 * ------------------------------------------------------------------
 */

import { type ArtifactVersion, findArtifacts, type Part, type ThreadArtifact } from '@nvx/contracts';
import type { Sql } from 'postgres';

export interface AnswerRow {
  id: string;
  parent_id: string | null;
  created_at: string;
  parts: Part[];
}

export interface ArtifactSetting {
  key: string;
  allow_network: boolean;
  changed_at: string;
}

export interface ArtifactStore {
  /** Finished answers in a thread that may hold an artifact, oldest first. */
  answers(threadId: string): Promise<AnswerRow[]>;
  settings(threadId: string): Promise<ArtifactSetting[]>;
  setNetwork(threadId: string, key: string, allow: boolean): Promise<ArtifactSetting>;
}

/** Most answers read per thread for the list (the newest are kept). */
export const MAX_ANSWERS = 2_000;

export class PgArtifactStore implements ArtifactStore {
  constructor(private readonly sql: Sql) {}

  async answers(threadId: string): Promise<AnswerRow[]> {
    const rows = await this.sql<{ id: string; parent_id: string | null; created_at: Date; parts: Part[] }[]>`
      select id, parent_id, created_at, parts from (
        select id, parent_id, created_at, parts from core.messages
        where thread_id = ${threadId} and deleted_at is null and role = 'assistant'
          and status in ('complete', 'stopped')
          and parts::text ilike '%artifact%'
        order by created_at desc, id desc
        limit ${MAX_ANSWERS}
      ) m order by created_at, id`;
    return rows.map((r) => ({
      id: r.id,
      parent_id: r.parent_id,
      created_at: r.created_at.toISOString(),
      parts: r.parts,
    }));
  }

  async settings(threadId: string): Promise<ArtifactSetting[]> {
    const rows = await this.sql<{ artifact_key: string; allow_network: boolean; changed_at: Date }[]>`
      select artifact_key, allow_network, changed_at from core.artifact_settings where thread_id = ${threadId}`;
    return rows.map((r) => ({
      key: r.artifact_key,
      allow_network: r.allow_network,
      changed_at: r.changed_at.toISOString(),
    }));
  }

  async setNetwork(threadId: string, key: string, allow: boolean): Promise<ArtifactSetting> {
    const rows = await this.sql<{ artifact_key: string; allow_network: boolean; changed_at: Date }[]>`
      insert into core.artifact_settings (thread_id, artifact_key, allow_network, changed_at)
      values (${threadId}, ${key}, ${allow}, now())
      on conflict (thread_id, artifact_key)
      do update set allow_network = excluded.allow_network, changed_at = now()
      returning artifact_key, allow_network, changed_at`;
    const r = rows[0] as { artifact_key: string; allow_network: boolean; changed_at: Date };
    return { key: r.artifact_key, allow_network: r.allow_network, changed_at: r.changed_at.toISOString() };
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly rows = new Map<string, AnswerRow[]>();
  private readonly decided = new Map<string, ArtifactSetting>();

  async answers(threadId: string) {
    return [...(this.rows.get(threadId) ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async settings(threadId: string) {
    return [...this.decided.entries()].filter(([k]) => k.startsWith(`${threadId}\0`)).map(([, v]) => v);
  }

  async setNetwork(threadId: string, key: string, allow: boolean) {
    const s = { key, allow_network: allow, changed_at: new Date().toISOString() };
    this.decided.set(`${threadId}\0${key}`, s);
    return s;
  }
}

/** Plain text of an answer: its text parts joined, as the Cockpit renders them. */
function textOf(parts: Part[]): string {
  return parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
}

/**
 * The thread's artifacts, newest change first, each with its versions
 * oldest first. `onPath` is the set of message ids on the branch shown.
 */
export function listArtifacts(
  answers: AnswerRow[],
  settings: ArtifactSetting[],
  onPath: ReadonlySet<string> | null,
): ThreadArtifact[] {
  const byKey = new Map<string, ArtifactVersion[]>();
  for (const a of answers) {
    for (const found of findArtifacts(textOf(a.parts))) {
      if (!found.complete) continue;
      const list = byKey.get(found.key) ?? [];
      const prev = list[list.length - 1];
      // The same content again (an answer quoting it back) is not a new version.
      if (prev && prev.content === found.content && prev.type === found.type) continue;
      list.push({
        version: list.length + 1,
        message_id: a.id,
        created_at: a.created_at,
        type: found.type,
        title: found.title,
        language: found.language,
        content: found.content,
        ...(onPath && { on_path: onPath.has(a.id) }),
      });
      byKey.set(found.key, list);
    }
  }
  const decided = new Map(settings.map((s) => [s.key, s]));
  return [...byKey.entries()]
    .map(([key, versions]) => {
      const last = versions[versions.length - 1] as ArtifactVersion;
      const s = decided.get(key);
      return {
        key,
        type: last.type,
        title: last.title,
        allow_network: s?.allow_network ?? false,
        network_changed_at: s?.changed_at ?? null,
        versions,
      };
    })
    .sort((a, b) => (b.versions.at(-1)?.created_at ?? '').localeCompare(a.versions.at(-1)?.created_at ?? ''));
}

/** Message ids from the head back to the root. */
export function pathFrom(head: string | null, parents: Map<string, string | null>): Set<string> {
  const out = new Set<string>();
  let at = head;
  while (at && !out.has(at)) {
    out.add(at);
    at = parents.get(at) ?? null;
  }
  return out;
}
