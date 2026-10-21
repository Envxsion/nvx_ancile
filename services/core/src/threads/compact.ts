/**
 * ------------------------------------------------------------------
 *  Title    |  Context budget and compaction
 *  Ref      |  DESIGN.md §8.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  How full a path is for the model that would answer it,
 *           |  and making it smaller without losing the thread: the
 *           |  older part of the path is replaced by a summary while the
 *           |  latest turns stay verbatim.
 *  How      |  A summary is keyed by the message it covers up to, so it
 *           |  is valid for every branch through that message (the
 *           |  shared prefix is compacted once). The cut always falls
 *           |  after an assistant reply, so the verbatim tail opens on
 *           |  a question. A newer compaction builds on the previous
 *           |  summary instead of re-reading everything. Tokens are the
 *           |  same pessimistic ~4 characters estimate used for memory.
 *           |  HO1: a cut is kept at three sizes (page, paragraph,
 *           |  line), tagged with the window class it was made for.
 *           |  Each model reads the finest that fits ITS window, or the
 *           |  full turns when they fit: a small model compacting never
 *           |  shrinks what a large one reads. The window is measured as
 *           |  a class (windowClass), so two models of one class choose
 *           |  alike and the request stays the same turn to turn.
 *  Note     |  The caller passes what else is in the request (system
 *           |  text, tools block, memory, sources), counted for real
 *           |  (conductor/overhead.ts).
 *           |  TODO(phase-5): a real tokenizer per model family, and
 *           |  model-written paragraph and line sizes (they are cut
 *           |  from the page by a fixed rule today).
 * ------------------------------------------------------------------
 */

import type {
  CompactionProvenance,
  CompactResult,
  ModelConfig,
  Part,
  PathBudget,
  SummaryLevel,
} from '@nvx/contracts';
import { AncileError } from '@nvx/contracts';
import { ulid } from 'ulid';
import { ALWAYS_ON, intSetting, type JobSwitches } from '../automations/settings';
import { citedForHistory } from '../conductor/citations';
import { servedWindow } from '../gateway/ollama-chat';
import { replayFor } from '../gateway/replay';
import { approxTokens } from '../memory/inject';
import type { BranchStore, SummaryRecord } from './branches';
import { ancestorPath, applyCompaction } from './path';
import { asTree, type MessageRecord, type TreeRecord } from './repo';
import { runUtility, type UtilityDeps } from './utility';

/** Messages always kept verbatim at the end of a path. */
export const KEEP_RECENT = 4;
export const WARN_RATIO = 0.8;
export const CRITICAL_RATIO = 0.95;

/**
 * "Watch the context window" (Admin → Automations): whether it warns and
 * compacts, and at what share of the window. Off: the meter still shows how
 * full the context is, but nothing warns and nothing is compacted for you.
 */
export interface ContextWatch {
  on: boolean;
  warnAt: number;
  compactAt: number;
}

export const DEFAULT_WATCH: ContextWatch = { on: true, warnAt: WARN_RATIO, compactAt: CRITICAL_RATIO };

export function contextWatch(s: JobSwitches = ALWAYS_ON): ContextWatch {
  const warn = intSetting(s, 'context_overflow_warn', 'warn_at_percent', 80, 50, 98);
  const compact = intSetting(s, 'context_overflow_warn', 'compact_at_percent', 95, 60, 99);
  // Settings that cross (saved before the check existed) fall back to the defaults.
  const [warnAt, compactAt] = warn < compact ? [warn / 100, compact / 100] : [WARN_RATIO, CRITICAL_RATIO];
  return { on: s.on('context_overflow_warn'), warnAt, compactAt };
}

/** Everything a model would read of these parts (text, tool calls and results). */
export function partsText(parts: Part[], opts: { reasoning?: boolean } = {}): string {
  // HO1: an earlier turn's [n] markers are named by their sources, so a summary never carries a bare number.
  return citedForHistory(parts)
    .map((p) => {
      if (p.type === 'text') return p.text;
      // CA1: reasoning a provider needs back (DeepSeek's reasoning_content) is part of what it reads.
      if (p.type === 'reasoning') return opts.reasoning ? p.text : '';
      if (p.type === 'tool_call') return `[tool ${p.tool} ${JSON.stringify(p.args ?? {})}]`;
      if (p.type === 'tool_result')
        return `[result ${typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? null)}]`;
      if (p.type === 'image') return p.caption ? `[image: ${p.caption}]` : '[image]';
      // CH6: an attached file's text counts toward the context, and is summarised with the rest.
      if (p.type === 'file')
        return p.text
          ? `[file ${p.name}]
${p.text}`
          : `[file ${p.name}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export const messageTokens = (m: Pick<MessageRecord, 'parts'>, opts: { reasoning?: boolean } = {}) =>
  approxTokens(partsText(m.parts, opts)) + 4;

/**
 * Claude Code's own compaction rows (the divider and its summary), brought
 * in from its transcript. They are a record of what Claude Code did in its
 * session, never sent to a model by NVX Ancile: NVX Ancile's summary is the
 * record of a mixed thread (docs/engines.md), so they do not count here.
 */
export function isClaudeCodeCompaction(m: Pick<MessageRecord, 'provenance'>): boolean {
  const kind = (
    (m.provenance as Record<string, unknown> | undefined)?.claude_code as { kind?: unknown } | undefined
  )?.kind;
  return kind === 'compact_boundary' || kind === 'compact_summary';
}

/** Where a compaction of this path would cut: the last reply before the verbatim tail. */
export function cutPoint(path: Pick<MessageRecord, 'id' | 'role'>[], keepRecent = KEEP_RECENT): number {
  for (let i = path.length - keepRecent - 1; i >= 0; i--) if (path[i]?.role === 'assistant') return i;
  return -1;
}

export const SUMMARY_HEADER =
  'Summary of the earlier part of this conversation (compacted to save space; the latest turns follow verbatim):';

/** The path as the model will see it, with the best summary substituted. */
export function compactedPath(
  path: TreeRecord[],
  summaries: SummaryRecord[],
  keepRecent = KEEP_RECENT,
): { summary: SummaryRecord | null; messages: TreeRecord[]; replaced: number } {
  const compactions = summaries
    .filter((s) => s.kind === 'compaction')
    .map((s) => ({ ...s, uptoMessageId: s.upto_message_id }));
  const { summary, messages } = applyCompaction(path, compactions, { keepRecent });
  return { summary: summary ?? null, messages, replaced: path.length - messages.length };
}

/* ---- HO1: sizes of a summary, and the one a window reads -------------------- */

/** Finest first. */
export const LEVELS: readonly SummaryLevel[] = ['page', 'paragraph', 'line'];
/** About how many tokens each size aims for. */
export const LEVEL_TOKENS: Record<SummaryLevel, number> = { page: 1_500, paragraph: 400, line: 80 };
/** Windows are compared by class, so a 131k and a 128k model choose alike. */
export const WINDOW_CLASSES = [
  8_000, 16_000, 32_000, 64_000, 128_000, 200_000, 400_000, 1_000_000, 2_000_000,
];

/** The largest class a window reaches (a window below the smallest class is its own; 0 for no window). */
export function windowClass(window: number): number {
  if (!(window > 0)) return 0;
  let out = Math.min(window, WINDOW_CLASSES[0] as number);
  for (const w of WINDOW_CLASSES) if (window >= w) out = w;
  return out;
}

/**
 * A summary cut down to about `tokens` by a fixed rule: the first line of every section, then
 * the rest in order while they fit. Same text in, same text out, so the request stays the same.
 */
export function shrinkSummary(content: string, tokens: number): string {
  if (approxTokens(content) <= tokens) return content;
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const isHeading = (l: string) => /^#{1,6}\s/.test(l);
  const sectionOf: number[] = [];
  let section = -1;
  lines.forEach((l, i) => {
    if (isHeading(l) || section < 0) section += 1;
    sectionOf[i] = section;
  });
  const chosen = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    const cost = approxTokens(lines[i] as string) + 1;
    if (chosen.has(i) || used + cost > tokens) return;
    chosen.add(i);
    used += cost;
  };
  const opened = new Set<number>();
  lines.forEach((l, i) => {
    const sec = sectionOf[i] as number;
    if (isHeading(l) || opened.has(sec)) return;
    opened.add(sec);
    take(i);
  });
  lines.forEach((l, i) => {
    if (!isHeading(l)) take(i);
  });
  // A heading stays only with something under it.
  const kept = lines.filter((l, i) =>
    isHeading(l)
      ? lines.some((x, j) => chosen.has(j) && sectionOf[j] === sectionOf[i] && !isHeading(x))
      : chosen.has(i),
  );
  const out = kept.join('\n');
  return approxTokens(out) <= tokens ? out : `${out.slice(0, Math.max(40, tokens * 4 - 1)).trimEnd()}…`;
}

/** What a model reads of the thread: every turn, or a summary of the earlier ones and the rest verbatim. */
export interface Choice {
  summary: SummaryRecord | null;
  level: 'full' | SummaryLevel;
  messages: TreeRecord[];
  replaced: number;
  /** Tokens of the history as chosen (messages and summary). */
  tokens: number;
}

const historyTokens = (msgs: TreeRecord[], reasoning: boolean) =>
  msgs.reduce((n, m) => n + (isClaudeCodeCompaction(m) ? 0 : messageTokens(m, { reasoning })), 0);

/** The room a history has: the window, and the rest of the request that is not history. */
export interface HistoryRoom {
  window: number;
  /** System, memory, tools, sources and the room kept for the answer. */
  fixed: number;
  watch: ContextWatch;
  reasoning: boolean;
}

/**
 * The finest reading of the path that fits this window. Every turn when they stay under the
 * warning line; else the finest summary (a size of a cut) that fits under the compaction line;
 * else every turn if they still fit; else the smallest summary there is. With the watch off, or
 * no window, nothing is chosen for the model: the newest summary applies, as it always did.
 */
export function chooseCompaction(
  path: TreeRecord[],
  summaries: SummaryRecord[],
  room: HistoryRoom | null,
  keepRecent = KEEP_RECENT,
): Choice {
  const reasoning = room?.reasoning ?? false;
  const whole: Choice = {
    summary: null,
    level: 'full',
    messages: path,
    replaced: 0,
    tokens: historyTokens(path, reasoning),
  };
  const index = new Map(path.map((m, i) => [m.id, i] as const));
  const usable = summaries.filter((s) => {
    const i = index.get(s.upto_message_id);
    return s.kind === 'compaction' && i !== undefined && i < path.length - keepRecent;
  });
  const using = (s: SummaryRecord): Choice => {
    const i = index.get(s.upto_message_id) as number;
    const messages = path.slice(i + 1);
    return {
      summary: s,
      level: s.level ?? 'page',
      messages,
      replaced: i + 1,
      tokens: historyTokens(messages, reasoning) + s.tokens + approxTokens(SUMMARY_HEADER),
    };
  };
  if (!room?.watch.on || room.window <= 0) {
    // As before: the newest cut, at its finest size (the rows of one cut are stored finest first).
    let best: { s: SummaryRecord; i: number } | null = null;
    for (const s of usable) {
      const i = index.get(s.upto_message_id) as number;
      if (!best || i > best.i) best = { s, i };
    }
    return best ? using(best.s) : whole;
  }
  const w = windowClass(room.window) || room.window;
  const warnLine = Math.floor(w * room.watch.warnAt) - room.fixed;
  const compactLine = Math.floor(w * room.watch.compactAt) - room.fixed;
  // Every turn is what a window reads while it has room, unless a summary was made for a window like
  // this one or larger (or before windows were recorded): that is the person's, or this model's, doing.
  const madeForThis = usable.some((s) => !s.for_window || windowClass(s.for_window) >= w);
  if (whole.tokens <= warnLine && !madeForThis) return whole;
  const options = usable
    .map(using)
    .sort(
      (a, b) =>
        b.tokens - a.tokens ||
        LEVELS.indexOf(a.level as SummaryLevel) - LEVELS.indexOf(b.level as SummaryLevel),
    );
  const fits = options.find((o) => o.tokens <= compactLine);
  if (fits) return fits;
  if (whole.tokens <= compactLine) return whole;
  return options.at(-1) ?? whole;
}

/** Does the model's provider want reasoning sent back (CA1)? Then long reasoning grows the context. */
export const wantsReasoning = (model: ModelConfig | undefined): boolean =>
  model ? replayFor(model, { tools: model.capabilities?.includes('tools') ?? false }).mode !== 'none' : false;

/** The tokens of a request that are not the history: what the model reads whatever the thread says. */
export interface Fixed {
  system?: number;
  memory?: number;
  retrieval?: number;
  /** HO1: the tools block. */
  tools?: number;
}

/** The room kept for the answer. */
export const reserveFor = (model: ModelConfig): number =>
  Math.min(model.max_output, Math.floor(servedWindow(model) / 4));

export function pathBudget(
  opts: Fixed & {
    headId: string | null;
    path: TreeRecord[];
    summaries: SummaryRecord[];
    model: ModelConfig | undefined;
    watch?: ContextWatch;
  },
): PathBudget {
  const watch = opts.watch ?? DEFAULT_WATCH;
  // CA1: long reasoning grows the context when the model's provider wants it back.
  const reasoning = wantsReasoning(opts.model);
  const window = opts.model ? servedWindow(opts.model) : 0;
  const reserve = opts.model ? reserveFor(opts.model) : 0;
  const used = {
    system: opts.system ?? 0,
    memory: opts.memory ?? 0,
    retrieval: opts.retrieval ?? 0,
    tools: opts.tools ?? 0,
    history: 0,
    reserve_output: reserve,
  };
  const fixed = used.system + used.memory + used.retrieval + used.tools + reserve;
  // HO1: what THIS model would read: the summary size that fits its window, or every turn.
  const room = window > 0 ? { window, fixed, watch, reasoning } : null;
  const chosen = chooseCompaction(opts.path, opts.summaries, room);
  const { summary, messages, replaced } = chosen;
  used.history = chosen.tokens;
  const total = fixed + used.history;
  const ratio = window > 0 ? total / window : 0;
  const cut = cutPoint(messages);
  // Asked before switching to this model: would the whole thread, as it is, fit?
  const now = fixed + historyTokens(opts.path, reasoning);
  const limit = window * (watch.on ? watch.compactAt : 1);
  const needs = window > 0 && now > limit;
  const fit =
    window > 0 ? fitFor({ ...opts, window, fixed, watch, reasoning, now, needs, chosen, limit }) : undefined;
  return {
    head_id: opts.headId,
    model_id: opts.model?.id ?? null,
    window,
    used,
    total,
    ratio: Math.round(ratio * 10_000) / 10_000,
    level: !watch.on ? 'ok' : ratio >= watch.compactAt ? 'critical' : ratio >= watch.warnAt ? 'warn' : 'ok',
    compaction: summary
      ? {
          summary_id: summary.id,
          upto_message_id: summary.upto_message_id,
          replaced_messages: replaced,
          tokens: summary.tokens,
          level: chosen.level === 'full' ? 'page' : chosen.level,
        }
      : null,
    compactable: cut >= 0 ? cut + 1 : 0,
    warn_at: watch.warnAt,
    compacts_at: watch.compactAt,
    ...(fit && { fit }),
  };
}

/** HO1: the fit warning: what the request is now, and what summarising would make it. */
function fitFor(o: {
  path: TreeRecord[];
  summaries: SummaryRecord[];
  window: number;
  fixed: number;
  watch: ContextWatch;
  reasoning: boolean;
  now: number;
  needs: boolean;
  chosen: Choice;
  limit: number;
}): NonNullable<PathBudget['fit']> {
  if (!o.needs)
    return {
      needs_summary: false,
      tokens_now: o.now,
      tokens_after: null,
      level: 'full',
      summary_ready: false,
    };
  const line = Math.floor(o.window * (o.watch.on ? o.watch.compactAt : 1));
  const ready = o.chosen.summary !== null && o.chosen.tokens + o.fixed <= line;
  if (ready)
    return {
      needs_summary: true,
      tokens_now: o.now,
      tokens_after: o.chosen.tokens + o.fixed,
      level: o.chosen.level,
      summary_ready: true,
    };
  // No summary fits yet: what compacting at the cut would give, at the finest size that fits.
  const cut = cutPoint(o.path);
  if (cut < 0)
    return {
      needs_summary: true,
      tokens_now: o.now,
      tokens_after: null,
      level: 'page',
      summary_ready: false,
    };
  const tail = historyTokens(o.path.slice(cut + 1), o.reasoning);
  const header = approxTokens(SUMMARY_HEADER);
  for (const level of LEVELS) {
    const after = o.fixed + tail + header + LEVEL_TOKENS[level];
    if (after <= line)
      return { needs_summary: true, tokens_now: o.now, tokens_after: after, level, summary_ready: false };
  }
  return { needs_summary: true, tokens_now: o.now, tokens_after: null, level: 'line', summary_ready: false };
}

/** One message per line block, as the compaction prompt reads it. */
export function transcript(msgs: Pick<MessageRecord, 'role' | 'parts'>[]): string {
  return msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${partsText(m.parts).trim()}`)
    .join('\n\n');
}

/** Without any model: the questions and the first line of each reply, so nothing silently vanishes. */
export function extractiveSummary(msgs: Pick<MessageRecord, 'role' | 'parts'>[]): string {
  const lines = msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const first = partsText(m.parts).replace(/\s+/g, ' ').trim().slice(0, 200);
      return `- ${m.role === 'user' ? 'The user asked' : 'The assistant answered'}: ${first}`;
    });
  return lines.join('\n');
}

const COMPACT_FALLBACK =
  'Compress the earlier part of this conversation into short bullet points, keeping goals, decisions, exact facts and corrections.\n\n{{turns}}';

export function nothingToCompact(): AncileError {
  return new AncileError({
    code: 'thread.nothing_to_compact',
    title: 'This path is already short',
    hint: `Compaction keeps the latest ${KEEP_RECENT} messages as they are; there is nothing older to summarise yet.`,
    status: 409,
    errorClass: 'permanent',
  });
}

/**
 * Save the smaller sizes of a page, if the cut does not have them yet. They are cut from the page
 * by a fixed rule (shrinkSummary), so they cost no model call and read the same every time.
 */
async function ensureSizes(
  deps: { branches: BranchStore },
  threadId: string,
  upto: string,
  page: SummaryRecord,
  have: SummaryRecord[],
  window: number,
): Promise<SummaryRecord[]> {
  const out: SummaryRecord[] = [];
  for (const level of LEVELS.slice(1)) {
    if (have.some((s) => s.level === level)) continue;
    const content = shrinkSummary(page.content, LEVEL_TOKENS[level]);
    out.push(
      await deps.branches.addSummary({
        id: `sum_${ulid()}`,
        thread_id: threadId,
        upto_message_id: upto,
        kind: 'compaction',
        content,
        tokens: approxTokens(content),
        model_id: page.model_id,
        level,
        for_window: window,
      }),
    );
  }
  return out;
}

/**
 * Summarise the path to `head` up to its cut point. Reuses a summary that
 * already covers exactly that prefix; builds on an earlier one if it exists.
 * HO1: the cut is kept at every size (page, paragraph, line), tagged with the
 * window class of the model it was made for, so any model can read the finest
 * one its own window holds.
 */
export async function compactPath(
  deps: UtilityDeps & { branches: BranchStore },
  opts: {
    threadId: string;
    messages: MessageRecord[];
    headId: string;
    signal?: AbortSignal;
    /** The window of the model this is for (tokens); recorded as its class. */
    window?: number;
  },
): Promise<CompactResult> {
  const byId = new Map(asTree(opts.messages).map((m) => [m.id, m] as const));
  const path = ancestorPath(byId, opts.headId);
  const cut = cutPoint(path);
  if (cut < 0) throw nothingToCompact();
  const upto = path[cut] as TreeRecord;
  const summaries = await deps.branches.summaries(opts.threadId, 'compaction');
  const before = path.reduce((n, m) => n + messageTokens(m), 0);
  const forWindow = windowClass(opts.window ?? 0);

  const sameCut = summaries.filter((s) => s.upto_message_id === upto.id);
  const existing = sameCut.find((s) => s.level === 'page') ?? sameCut[0];
  if (existing) {
    // A summary made before sizes existed gets its smaller ones now.
    const added =
      existing.level === 'page'
        ? await ensureSizes(deps, opts.threadId, upto.id, existing, sameCut, existing.for_window)
        : [];
    return {
      summary_id: existing.id,
      upto_message_id: upto.id,
      replaced_messages: cut + 1,
      tokens_before: before,
      tokens_after: before - prefixTokens(path, cut) + existing.tokens,
      model_id: existing.model_id,
      reused: true,
      levels: [...new Set([...sameCut, ...added].map((s) => s.level))],
    };
  }

  // Build on the newest summary inside this prefix, if any.
  const prefix = path.slice(0, cut + 1);
  const prior = compactedPath(prefix, summaries, 0);
  const turns = [
    ...(prior.summary ? [`Earlier summary:\n${prior.summary.content}`] : []),
    transcript(prior.messages),
  ].join('\n\n');

  const res = await runUtility(deps, {
    promptId: 'threads.compact',
    fallback: COMPACT_FALLBACK,
    vars: { turns, keep_verbatim_after: upto.id },
    ...(opts.signal && { signal: opts.signal }),
    maxOutputTokens: 1_500,
  }).catch(() => null);
  const content = res?.text || extractiveSummary(prefix);
  const tokens = approxTokens(content);
  const saved = await deps.branches.addSummary({
    id: `sum_${ulid()}`,
    thread_id: opts.threadId,
    upto_message_id: upto.id,
    kind: 'compaction',
    content,
    tokens,
    model_id: res?.modelId ?? 'extractive',
    level: 'page',
    for_window: forWindow,
  });
  const smaller = await ensureSizes(deps, opts.threadId, upto.id, saved, [saved], forWindow);
  return {
    summary_id: saved.id,
    upto_message_id: upto.id,
    replaced_messages: cut + 1,
    tokens_before: before,
    tokens_after: before - prefixTokens(path, cut) + tokens,
    model_id: res?.modelId ?? null,
    reused: false,
    levels: [saved, ...smaller].map((s) => s.level),
  };
}

function prefixTokens(path: TreeRecord[], cut: number): number {
  return path.slice(0, cut + 1).reduce((n, m) => n + messageTokens(m), 0);
}

export interface TurnSubstitution {
  skipThrough: string | null;
  note: string;
  provenance: CompactionProvenance | null;
}

/** The turn's view of a choice: which prefix the summary replaces, its note, and what to record. */
export function substituteChoice(path: TreeRecord[], c: Choice): TurnSubstitution {
  const { summary, messages, replaced } = c;
  if (!summary || replaced <= 0) return { skipThrough: null, note: '', provenance: null };
  const before = path.reduce((n, m) => n + messageTokens(m), 0);
  const after = messages.reduce((n, m) => n + messageTokens(m), 0) + summary.tokens;
  return {
    skipThrough: summary.upto_message_id,
    note: `${SUMMARY_HEADER}\n\n${summary.content}`,
    provenance: {
      summary_id: summary.id,
      upto_message_id: summary.upto_message_id,
      tokens_before: before,
      tokens_after: after,
    },
  };
}

/**
 * The conductor's view of a turn: which prefix the summary replaces, the
 * note for the system prompt, and what to record on the reply. The path is
 * the one being answered (root → the user message). Without a room, the
 * newest summary applies; with one, the size this window reads (HO1).
 */
export function substitute(
  path: TreeRecord[],
  summaries: SummaryRecord[],
  room: HistoryRoom | null = null,
): TurnSubstitution {
  return substituteChoice(path, chooseCompaction(path, summaries, room));
}

/**
 * Before a turn's first model call: compact automatically when the path is
 * past the critical line for THIS model, then substitute the size of summary
 * its window reads (or none, when every turn fits).
 */
export async function prepareTurnContext(
  deps: UtilityDeps & { branches: BranchStore },
  opts: Fixed & {
    threadId: string;
    messages: MessageRecord[];
    userMessageId: string;
    model: ModelConfig | undefined;
    signal?: AbortSignal;
    /** Off: never compacts by itself (a summary you made still applies). */
    watch?: ContextWatch;
  },
): Promise<TurnSubstitution> {
  const byId = new Map(asTree(opts.messages).map((m) => [m.id, m] as const));
  const path = ancestorPath(byId, opts.userMessageId);
  let summaries = await deps.branches.summaries(opts.threadId, 'compaction');
  const fixedOf = {
    ...(opts.system !== undefined && { system: opts.system }),
    ...(opts.memory !== undefined && { memory: opts.memory }),
    ...(opts.retrieval !== undefined && { retrieval: opts.retrieval }),
    ...(opts.tools !== undefined && { tools: opts.tools }),
  };
  const budgetOf = () =>
    pathBudget({
      headId: opts.userMessageId,
      path,
      summaries,
      model: opts.model,
      ...fixedOf,
      ...(opts.watch && { watch: opts.watch }),
    });
  const window = opts.model ? servedWindow(opts.model) : 0;
  const budget = budgetOf();
  let auto = false;
  if (budget.level === 'critical' && budget.compactable > 0) {
    try {
      await compactPath(deps, {
        threadId: opts.threadId,
        messages: opts.messages,
        headId: opts.userMessageId,
        window,
        ...(opts.signal && { signal: opts.signal }),
      });
      summaries = await deps.branches.summaries(opts.threadId, 'compaction');
      auto = true;
    } catch {
      /* Nothing to compact, or no model: send as is and let the gateway report an overflow. */
    }
  }
  const room = roomFor(opts.model, opts.watch ?? DEFAULT_WATCH, fixedOf);
  const sub = substitute(path, summaries, room);
  return sub.provenance && auto ? { ...sub, provenance: { ...sub.provenance, auto } } : sub;
}

/** The room a model's window gives a history, with the rest of its request already counted. */
export function roomFor(
  model: ModelConfig | undefined,
  watch: ContextWatch,
  fixed: Fixed,
): HistoryRoom | null {
  if (!model) return null;
  const window = servedWindow(model);
  if (!(window > 0)) return null;
  return {
    window,
    fixed:
      (fixed.system ?? 0) +
      (fixed.memory ?? 0) +
      (fixed.retrieval ?? 0) +
      (fixed.tools ?? 0) +
      reserveFor(model),
    watch,
    reasoning: wantsReasoning(model),
  };
}
