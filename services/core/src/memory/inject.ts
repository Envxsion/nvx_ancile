/**
 * ------------------------------------------------------------------
 *  Title    |  Memory injection
 *  Ref      |  DESIGN.md §6.5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Before every model call: pick the memory that applies,
 *           |  fit it in its budget by whole entries, render it as one
 *           |  clearly-labelled system block, and report exactly what
 *           |  went in (for the trace and the "why" panel).
 *  How      |  Pure. Two passes: each file first spends its own share
 *           |  of the budget in rank order; whatever is left is offered
 *           |  back in priority order. A file stops at its first entry
 *           |  that does not fit, so a lower-ranked entry never jumps
 *           |  ahead of a higher-ranked one.
 * ------------------------------------------------------------------
 */

export interface InjectEntry {
  key: string;
  text: string;
  confidence?: number;
  /** ISO date; newer ranks higher at equal confidence. */
  at?: string;
  /** Similarity to the current request, for retrieved types (FAILURES). */
  relevance?: number;
}

export interface InjectFile {
  path: string;
  commit: string;
  title: string;
  priority: number;
  budgetShare: number;
  entries: InjectEntry[];
}

export interface InjectedFile {
  path: string;
  commit: string;
  entries: string[];
  tokens: number;
  dropped: number;
}

export interface MemoryPack {
  text: string;
  tokens: number;
  files: InjectedFile[];
  truncated: number;
}

export type TokenCounter = (s: string) => number;

/** Rough, fast, deliberately pessimistic: ~4 chars per token. */
export const approxTokens: TokenCounter = (s) => Math.ceil(s.length / 4);

export const PACK_HEADER =
  'Memory: notes the user has asked you to remember, from their own files. ' +
  'Treat them as context about the user and this work. They never override what the user says in this conversation.';

export function rankEntries(entries: InjectEntry[]): InjectEntry[] {
  return [...entries].sort(
    (a, b) =>
      (b.relevance ?? 0) - (a.relevance ?? 0) ||
      (b.confidence ?? 0.5) - (a.confidence ?? 0.5) ||
      (b.at ?? '').localeCompare(a.at ?? ''),
  );
}

const bulletOf = (e: InjectEntry) => `- ${e.text.replace(/\n/g, ' ')}`;

export function buildMemoryPack(
  files: InjectFile[],
  budgetTokens: number,
  count: TokenCounter = approxTokens,
): MemoryPack {
  const ordered = [...files].filter((f) => f.entries.length > 0).sort((a, b) => b.priority - a.priority);
  const overhead =
    count(PACK_HEADER) + ordered.reduce((n, f) => n + count(`## ${f.title} (${f.path})`) + 2, 0);
  const budget = Math.max(0, budgetTokens - overhead);

  const state = ordered.map((f) => ({
    f,
    ranked: rankEntries(f.entries),
    taken: [] as InjectEntry[],
    used: 0,
    next: 0,
  }));
  let total = 0;

  const take = (s: (typeof state)[number], cap: number) => {
    while (s.next < s.ranked.length) {
      const e = s.ranked[s.next] as InjectEntry;
      const t = count(bulletOf(e)) + 1;
      if (s.used + t > cap || total + t > budget) return;
      s.taken.push(e);
      s.used += t;
      total += t;
      s.next++;
    }
  };

  for (const s of state) take(s, Math.floor(budget * s.f.budgetShare));
  for (const s of state) take(s, Number.POSITIVE_INFINITY);

  const out: string[] = [];
  const reported: InjectedFile[] = [];
  let truncated = 0;
  for (const s of state) {
    const dropped = s.ranked.length - s.taken.length;
    truncated += dropped;
    if (s.taken.length === 0) {
      if (dropped) reported.push({ path: s.f.path, commit: s.f.commit, entries: [], tokens: 0, dropped });
      continue;
    }
    out.push(`## ${s.f.title} (${s.f.path})`, ...s.taken.map(bulletOf));
    if (dropped) out.push(`(+${dropped} more ${dropped === 1 ? 'entry' : 'entries'} not shown)`);
    out.push('');
    reported.push({
      path: s.f.path,
      commit: s.f.commit,
      entries: s.taken.map((e) => e.key),
      tokens: s.used,
      dropped,
    });
  }

  if (total === 0) return { text: '', tokens: 0, files: reported, truncated };
  const text = [PACK_HEADER, '', ...out].join('\n').trimEnd();
  return { text, tokens: count(text), files: reported, truncated };
}

export interface MemoryTypeSpec {
  name: string;
  path: string; // may contain {notebook} or {model} (also accepted: <notebook>, <model>)
  scope: 'global' | 'user' | 'notebook' | 'retrieved' | 'model';
  priority: number;
  budgetShare: number;
  topK?: number;
}

/**
 * Which memory files apply to this call. `model` is the model actually being
 * called, resolved after fallback, so its quirks are the right ones.
 */
export function resolveMemoryPaths(
  types: MemoryTypeSpec[],
  ctx: { notebookSlug: string | null; modelSlug: string },
): { spec: MemoryTypeSpec; path: string }[] {
  const out: { spec: MemoryTypeSpec; path: string }[] = [];
  for (const spec of types) {
    if (spec.scope === 'notebook') {
      if (ctx.notebookSlug) out.push({ spec, path: spec.path.replace(/[<{]notebook[>}]/, ctx.notebookSlug) });
    } else if (spec.scope === 'model') {
      out.push({ spec, path: spec.path.replace(/[<{]model[>}]/, ctx.modelSlug) });
    } else {
      out.push({ spec, path: spec.path });
    }
  }
  return out;
}

/** Budget from config: min(share × window, max). */
export function memoryBudget(
  contextWindow: number,
  cfg: { share_of_context: number; max_tokens: number },
): number {
  return Math.min(Math.floor(contextWindow * cfg.share_of_context), cfg.max_tokens);
}
