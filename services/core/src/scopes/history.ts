/**
 * ------------------------------------------------------------------
 *  Title    |  What had already left this machine
 *  Ref      |  docs/scopes.md (Private after shared)
 *           |  · packages/contracts/src/scopes.ts (SharedBeforeLocal)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A notebook made private, or a notebook or thread made
 *           |  local only, keeps everything on this machine from then
 *           |  on. What went to cloud models before cannot be called
 *           |  back, so say plainly what it was: which engines and
 *           |  providers, how many answers, and over which dates.
 *  How      |  At the moment of the change, every assistant answer in
 *           |  the notebook or thread is grouped by its model and
 *           |  engine (core.messages.model_id, and provenance for
 *           |  Claude Code), deleted ones included: they were sent all
 *           |  the same. Each group is classified into a closed set
 *           |  of destinations (local models are left out) and the
 *           |  summary is kept in core.scope_shared_history.
 *  Note     |  Counts, providers and dates only. No content, no model
 *           |  ids, no titles are stored or shown.
 * ------------------------------------------------------------------
 */

import type { SharedBeforeLocal, SharedDestination } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { monotonicFactory } from 'ulid';

// Ids made in the same millisecond still sort in the order they were made.
const ulid = monotonicFactory();

export type HistoryLevel = SharedBeforeLocal['level'];

/** Answers grouped by model and engine. */
export interface AnswerGroup {
  model_id: string | null;
  /** Made by Claude Code (its provenance on the message). */
  claude_code: boolean;
  turns: number;
  first_at: string;
  last_at: string;
}

export interface SharedHistoryStore {
  /** Every assistant answer in a notebook (all its threads) or one thread, grouped. */
  answers(level: HistoryLevel, refId: string): Promise<AnswerGroup[]>;
  add(rec: SharedBeforeLocal): Promise<void>;
  /** Records for any of these levels, newest first. */
  list(refs: { level: HistoryLevel; refId: string }[]): Promise<SharedBeforeLocal[]>;
}

/** Where an answer was made: a destination off this machine, or null when it was made here. */
export type Classify = (modelId: string | null, claudeCode: boolean) => SharedDestination | null;

const LOCAL_PROVIDERS = new Set(['ollama', 'local', 'fake', 'node', 'controller']);
const PROVIDERS: Record<string, SharedDestination> = {
  anthropic: 'anthropic',
  openai: 'openai',
  azure: 'openai',
  google: 'google',
  gemini: 'google',
  vertex: 'google',
  openrouter: 'openrouter',
  mistral: 'mistral',
  groq: 'groq',
  deepseek: 'deepseek',
  xai: 'xai',
  grok: 'xai',
};

/**
 * Classify by provider. `lookup` gives what the model registry knows (its
 * provider, and whether it runs here); a model no longer configured is read
 * from its id's prefix ("anthropic/…").
 */
export function classifier(
  lookup: (modelId: string) => { provider: string; local: boolean } | undefined,
): Classify {
  return (modelId, claudeCode) => {
    if (claudeCode || modelId?.startsWith('claude-code/')) return 'claude_code';
    if (!modelId) return null;
    const known = lookup(modelId);
    if (known?.local) return null;
    const provider = (known?.provider ?? modelId.split('/')[0] ?? '').toLowerCase();
    if (LOCAL_PROVIDERS.has(provider)) return null;
    return PROVIDERS[provider] ?? 'other_cloud';
  };
}

/** The summary kept for one change. */
export function summarise(
  groups: AnswerGroup[],
  classify: Classify,
  rec: { level: HistoryLevel; refId: string; change: SharedBeforeLocal['change']; at: string },
): SharedBeforeLocal {
  const by = new Map<SharedDestination, number>();
  let turns = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const g of groups) {
    const d = classify(g.model_id, g.claude_code);
    if (!d) continue;
    by.set(d, (by.get(d) ?? 0) + g.turns);
    turns += g.turns;
    if (!first || g.first_at < first) first = g.first_at;
    if (!last || g.last_at > last) last = g.last_at;
  }
  return {
    id: `ssh_${ulid()}`,
    level: rec.level,
    ref_id: rec.refId,
    change: rec.change,
    changed_at: rec.at,
    turns,
    first_at: first,
    last_at: last,
    destinations: [...by.entries()]
      .map(([destination, n]) => ({ destination, turns: n }))
      .sort((a, b) => b.turns - a.turns || a.destination.localeCompare(b.destination)),
  };
}

export class SharedHistory {
  constructor(private readonly deps: { store: SharedHistoryStore; classify: Classify; now?: () => Date }) {}

  /** Keep what had left the machine before this level stopped letting it. */
  async record(level: HistoryLevel, refId: string, change: SharedBeforeLocal['change']) {
    const groups = await this.deps.store.answers(level, refId);
    const rec = summarise(groups, this.deps.classify, {
      level,
      refId,
      change,
      at: (this.deps.now?.() ?? new Date()).toISOString(),
    });
    await this.deps.store.add(rec);
    return rec;
  }

  list(refs: { level: HistoryLevel; refId: string }[]) {
    return this.deps.store.list(refs);
  }
}

/* ---- stores ------------------------------------------------------------------- */

export interface MemoryAnswer {
  thread_id: string;
  notebook_id: string | null;
  model_id: string | null;
  claude_code: boolean;
  created_at: string;
}

export class MemorySharedHistoryStore implements SharedHistoryStore {
  readonly answersList: MemoryAnswer[] = [];
  readonly records: SharedBeforeLocal[] = [];

  async answers(level: HistoryLevel, refId: string) {
    const groups = new Map<string, AnswerGroup>();
    for (const a of this.answersList) {
      if (level === 'notebook' ? a.notebook_id !== refId : a.thread_id !== refId) continue;
      const k = `${a.model_id}|${a.claude_code}`;
      const g = groups.get(k) ?? {
        model_id: a.model_id,
        claude_code: a.claude_code,
        turns: 0,
        first_at: a.created_at,
        last_at: a.created_at,
      };
      g.turns++;
      if (a.created_at < g.first_at) g.first_at = a.created_at;
      if (a.created_at > g.last_at) g.last_at = a.created_at;
      groups.set(k, g);
    }
    return [...groups.values()];
  }

  async add(rec: SharedBeforeLocal) {
    this.records.push(structuredClone(rec));
  }

  async list(refs: { level: HistoryLevel; refId: string }[]) {
    return this.records
      .filter((r) => refs.some((x) => x.level === r.level && x.refId === r.ref_id))
      .sort((a, b) => b.changed_at.localeCompare(a.changed_at) || b.id.localeCompare(a.id))
      .map((r) => structuredClone(r));
  }
}

interface GroupRow {
  model_id: string | null;
  claude_code: boolean;
  turns: number;
  first_at: Date;
  last_at: Date;
}

interface HistoryRow {
  id: string;
  level: HistoryLevel;
  ref_id: string;
  change: SharedBeforeLocal['change'];
  turns: number;
  first_at: Date | null;
  last_at: Date | null;
  destinations: SharedBeforeLocal['destinations'];
  changed_at: Date;
}

export class PgSharedHistoryStore implements SharedHistoryStore {
  constructor(private readonly sql: Sql) {}

  async answers(level: HistoryLevel, refId: string) {
    // Deleted answers count: they were sent all the same.
    const rows = await this.sql<GroupRow[]>`
      select m.model_id, (m.provenance ? 'claude_code') as claude_code, count(*)::int as turns,
             min(m.created_at) as first_at, max(m.created_at) as last_at
      from core.messages m join core.threads t on t.id = m.thread_id
      where m.role = 'assistant'
        and ${level === 'notebook' ? this.sql`t.notebook_id = ${refId}` : this.sql`m.thread_id = ${refId}`}
      group by 1, 2`;
    return rows.map((r) => ({
      model_id: r.model_id,
      claude_code: r.claude_code,
      turns: r.turns,
      first_at: r.first_at.toISOString(),
      last_at: r.last_at.toISOString(),
    }));
  }

  async add(r: SharedBeforeLocal) {
    await this.sql`
      insert into core.scope_shared_history
        (id, level, ref_id, change, turns, first_at, last_at, destinations, changed_at)
      values (${r.id}, ${r.level}, ${r.ref_id}, ${r.change}, ${r.turns}, ${r.first_at}, ${r.last_at},
              ${this.sql.json(r.destinations as never)}, ${r.changed_at})`;
  }

  async list(refs: { level: HistoryLevel; refId: string }[]) {
    if (!refs.length) return [];
    const levels = refs.map((r) => r.level);
    const ids = refs.map((r) => r.refId);
    const rows = await this.sql<HistoryRow[]>`
      select h.* from core.scope_shared_history h
      join unnest(${levels}::text[], ${ids}::text[]) as x(level, ref_id)
        on x.level = h.level and x.ref_id = h.ref_id
      order by h.changed_at desc, h.id desc limit 50`;
    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      ref_id: r.ref_id,
      change: r.change,
      changed_at: r.changed_at.toISOString(),
      turns: r.turns,
      first_at: r.first_at ? r.first_at.toISOString() : null,
      last_at: r.last_at ? r.last_at.toISOString() : null,
      destinations: r.destinations,
    }));
  }
}
