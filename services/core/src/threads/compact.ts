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
 *  Note     |  Memory and retrieval tokens are passed in by the caller;
 *           |  the budget route counts what it can see.
 *           |  TODO(phase-5): a real tokenizer per model family.
 * ------------------------------------------------------------------
 */

import type { CompactionProvenance, CompactResult, ModelConfig, Part, PathBudget } from '@nvx/contracts';
import { AncileError } from '@nvx/contracts';
import { ulid } from 'ulid';
import { approxTokens } from '../memory/inject';
import type { BranchStore, SummaryRecord } from './branches';
import { ancestorPath, applyCompaction } from './path';
import { asTree, type MessageRecord, type TreeRecord } from './repo';
import { runUtility, type UtilityDeps } from './utility';

/** Messages always kept verbatim at the end of a path. */
export const KEEP_RECENT = 4;
export const WARN_RATIO = 0.8;
export const CRITICAL_RATIO = 0.95;

/** Everything a model would read of these parts (text, tool calls and results). */
export function partsText(parts: Part[]): string {
  return parts
    .map((p) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'tool_call') return `[tool ${p.tool} ${JSON.stringify(p.args ?? {})}]`;
      if (p.type === 'tool_result')
        return `[result ${typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? null)}]`;
      if (p.type === 'image') return p.caption ? `[image: ${p.caption}]` : '[image]';
      if (p.type === 'file') return `[file ${p.name}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export const messageTokens = (m: Pick<MessageRecord, 'parts'>) => approxTokens(partsText(m.parts)) + 4;

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

export function pathBudget(opts: {
  headId: string | null;
  path: TreeRecord[];
  summaries: SummaryRecord[];
  model: ModelConfig | undefined;
  system?: number;
  memory?: number;
  retrieval?: number;
}): PathBudget {
  const { summary, messages, replaced } = compactedPath(opts.path, opts.summaries);
  const history =
    messages.reduce((n, m) => n + messageTokens(m), 0) +
    (summary ? summary.tokens + approxTokens(SUMMARY_HEADER) : 0);
  const window = opts.model?.context_window ?? 0;
  const reserve = opts.model ? Math.min(opts.model.max_output, Math.floor(window / 4)) : 0;
  const used = {
    system: opts.system ?? 0,
    memory: opts.memory ?? 0,
    retrieval: opts.retrieval ?? 0,
    history,
    reserve_output: reserve,
  };
  const total = used.system + used.memory + used.retrieval + used.history + used.reserve_output;
  const ratio = window > 0 ? total / window : 0;
  const cut = cutPoint(messages);
  return {
    head_id: opts.headId,
    model_id: opts.model?.id ?? null,
    window,
    used,
    total,
    ratio: Math.round(ratio * 10_000) / 10_000,
    level: ratio >= CRITICAL_RATIO ? 'critical' : ratio >= WARN_RATIO ? 'warn' : 'ok',
    compaction: summary
      ? {
          summary_id: summary.id,
          upto_message_id: summary.upto_message_id,
          replaced_messages: replaced,
          tokens: summary.tokens,
        }
      : null,
    compactable: cut >= 0 ? cut + 1 : 0,
  };
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
 * Summarise the path to `head` up to its cut point. Reuses a summary that
 * already covers exactly that prefix; builds on an earlier one if it exists.
 */
export async function compactPath(
  deps: UtilityDeps & { branches: BranchStore },
  opts: { threadId: string; messages: MessageRecord[]; headId: string; signal?: AbortSignal },
): Promise<CompactResult> {
  const byId = new Map(asTree(opts.messages).map((m) => [m.id, m] as const));
  const path = ancestorPath(byId, opts.headId);
  const cut = cutPoint(path);
  if (cut < 0) throw nothingToCompact();
  const upto = path[cut] as TreeRecord;
  const summaries = await deps.branches.summaries(opts.threadId, 'compaction');
  const before = path.reduce((n, m) => n + messageTokens(m), 0);

  const existing = summaries.find((s) => s.upto_message_id === upto.id);
  if (existing) {
    return {
      summary_id: existing.id,
      upto_message_id: upto.id,
      replaced_messages: cut + 1,
      tokens_before: before,
      tokens_after: before - prefixTokens(path, cut) + existing.tokens,
      model_id: existing.model_id,
      reused: true,
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
  });
  return {
    summary_id: saved.id,
    upto_message_id: upto.id,
    replaced_messages: cut + 1,
    tokens_before: before,
    tokens_after: before - prefixTokens(path, cut) + tokens,
    model_id: res?.modelId ?? null,
    reused: false,
  };
}

function prefixTokens(path: TreeRecord[], cut: number): number {
  return path.slice(0, cut + 1).reduce((n, m) => n + messageTokens(m), 0);
}

/**
 * The conductor's view of a turn: which prefix the summary replaces, the
 * note for the system prompt, and what to record on the reply. The path is
 * the one being answered (root → the user message).
 */
export function substitute(
  path: TreeRecord[],
  summaries: SummaryRecord[],
): { skipThrough: string | null; note: string; provenance: CompactionProvenance | null } {
  const { summary, messages, replaced } = compactedPath(path, summaries);
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
 * Before a turn's first model call: compact automatically when the path is
 * past the critical line, then substitute whatever summary applies.
 */
export async function prepareTurnContext(
  deps: UtilityDeps & { branches: BranchStore },
  opts: {
    threadId: string;
    messages: MessageRecord[];
    userMessageId: string;
    model: ModelConfig | undefined;
    system: number;
    retrieval: number;
    signal?: AbortSignal;
  },
): Promise<{ skipThrough: string | null; note: string; provenance: CompactionProvenance | null }> {
  const byId = new Map(asTree(opts.messages).map((m) => [m.id, m] as const));
  const path = ancestorPath(byId, opts.userMessageId);
  let summaries = await deps.branches.summaries(opts.threadId, 'compaction');
  const budget = pathBudget({
    headId: opts.userMessageId,
    path,
    summaries,
    model: opts.model,
    system: opts.system,
    retrieval: opts.retrieval,
  });
  let auto = false;
  if (budget.level === 'critical' && budget.compactable > 0) {
    try {
      await compactPath(deps, {
        threadId: opts.threadId,
        messages: opts.messages,
        headId: opts.userMessageId,
        ...(opts.signal && { signal: opts.signal }),
      });
      summaries = await deps.branches.summaries(opts.threadId, 'compaction');
      auto = true;
    } catch {
      /* Nothing to compact, or no model: send as is and let the gateway report an overflow. */
    }
  }
  const sub = substitute(path, summaries);
  return sub.provenance && auto ? { ...sub, provenance: { ...sub.provenance, auto } } : sub;
}
