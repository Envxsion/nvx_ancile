/**
 * ------------------------------------------------------------------
 *  Title    |  Fitting a request to the model it is about to go to
 *  Ref      |  ROADMAP.md HO1 · docs/prompt-caching.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A turn is built once, for the first model of the chain.
 *           |  When that model fails and the next has a smaller window,
 *           |  sending the same request only fails again (a context
 *           |  overflow is not a reason to try the next model). This
 *           |  rebuilds the history for the model that is really going
 *           |  to be asked: the size of summary its window reads, a
 *           |  new one if none fits. If nothing fits, the model is
 *           |  skipped with a plain reason.
 *  How      |  requestTokens counts the whole request (system text,
 *           |  tools JSON, every message as it would go out). refitFor
 *           |  keeps the epoch's frozen system text and tools as they
 *           |  are (they are the cached start) and swaps only the
 *           |  summary note and the turns it replaces. A stored sent
 *           |  form that carries the old note is rebuilt from parts, so
 *           |  the note is never told twice.
 *  Note     |  A different model is a different cache anyway. Nothing
 *           |  here runs when the first model holds the request.
 * ------------------------------------------------------------------
 */

import type { ModelConfig, SummaryLevel } from '@nvx/contracts';
import { toSdkMessages } from '../gateway/convert';
import { servedWindow } from '../gateway/ollama-chat';
import type { ModelMessage, ModelRequest } from '../gateway/types';
import { approxTokens } from '../memory/inject';
import type { BranchStore } from '../threads/branches';
import {
  type ContextWatch,
  chooseCompaction,
  compactPath,
  reserveFor,
  SUMMARY_HEADER,
  wantsReasoning,
} from '../threads/compact';
import { ancestorPath } from '../threads/path';
import { asTree, type MessageRecord } from '../threads/repo';
import type { UtilityDeps } from '../threads/utility';
import { historyFor, withTurnContext } from './context';

/** The words of one provider message: what a model reads of it, without the JSON around it. */
function sdkText(m: ReturnType<typeof toSdkMessages>[number]): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as { type: string; [k: string]: unknown }[])
    .map((c) => {
      if (c.type === 'text' || c.type === 'reasoning') return String(c.text ?? '');
      if (c.type === 'tool-call') return `${String(c.toolName ?? '')} ${JSON.stringify(c.input ?? {})}`;
      if (c.type === 'tool-result')
        return JSON.stringify((c.output as { value?: unknown } | undefined)?.value ?? '');
      return '';
    })
    .join('\n');
}

/**
 * What the whole request costs the model that reads it: the system text, the tools block and every
 * message as it would go out, counted the same way the budget counts a history (4 characters a token,
 * a few tokens a message), so a request the budget says fits is not found too big here.
 */
export function requestTokens(model: Pick<ModelConfig, 'capabilities'>, req: ModelRequest): number {
  const tools = model.capabilities.includes('tools');
  return (
    approxTokens(req.system ?? '') +
    (tools && req.tools?.length ? approxTokens(JSON.stringify(req.tools)) : 0) +
    toSdkMessages(req.messages, { tools }).reduce((n, m) => n + approxTokens(sdkText(m)) + 4, 0)
  );
}

/** A note swapped for another; one that was told in an earlier question is added where it is read. */
function swap(text: string, oldNote: string, newNote: string): string {
  if (oldNote && text.includes(oldNote)) return text.replace(oldNote, newNote).replace(/\n{3,}/g, '\n\n');
  return newNote ? `${text}\n\n${newNote}` : text;
}

export interface Refit {
  req: ModelRequest;
  level: 'full' | SummaryLevel;
  tokens_before: number;
  tokens_after: number;
}

export async function refitFor(i: {
  model: ModelConfig;
  req: ModelRequest;
  all: MessageRecord[];
  threadId: string;
  userMessageId: string;
  sentMap: ReadonlyMap<string, { sent: string | null; epoch_id?: string | null }>;
  /** This turn's own work after the question (tool rounds, notes). */
  tail: ModelMessage[];
  /** The frame's context block (what rides with the question). */
  block: string;
  /** The summary note the request was built with; '' when it used none. */
  oldNote: string;
  endContext: boolean;
  watch: ContextWatch;
  deps: UtilityDeps & { branches: BranchStore };
  signal?: AbortSignal;
}): Promise<Refit | null> {
  const window = servedWindow(i.model);
  const reserve = reserveFor(i.model);
  const before = requestTokens(i.model, i.req);
  const tools = i.model.capabilities.includes('tools');
  // Everything that is not the history: the frozen start of the request, the question's block, this turn's work.
  const fixed =
    approxTokens(i.req.system ?? '') +
    (tools && i.req.tools?.length ? approxTokens(JSON.stringify(i.req.tools)) : 0) +
    approxTokens(i.block) +
    toSdkMessages(i.tail, { tools }).reduce((n, m) => n + approxTokens(sdkText(m)) + 4, 0) +
    reserve;
  const byId = new Map(asTree(i.all).map((m) => [m.id, m] as const));
  const path = ancestorPath(byId, i.userMessageId);
  const room = { window, fixed, watch: i.watch, reasoning: wantsReasoning(i.model) };
  let summaries = await i.deps.branches.summaries(i.threadId, 'compaction');
  let chosen = chooseCompaction(path, summaries, room);
  if (chosen.tokens + fixed > window * i.watch.compactAt) {
    try {
      await compactPath(i.deps, {
        threadId: i.threadId,
        messages: i.all,
        headId: i.userMessageId,
        window,
        ...(i.signal && { signal: i.signal }),
      });
      summaries = await i.deps.branches.summaries(i.threadId, 'compaction');
      chosen = chooseCompaction(path, summaries, room);
    } catch {
      /* Nothing older to summarise, or no model to do it: what there is decides below. */
    }
  }
  if (chosen.tokens + fixed > window) return null;

  const note = chosen.summary ? `${SUMMARY_HEADER}\n\n${chosen.summary.content}` : '';
  // A stored form that carries the old note is rebuilt from its parts: the note is told once.
  const sent = new Map(
    [...i.sentMap].map(([id, f]) => [
      id,
      i.oldNote && f.sent?.includes(i.oldNote) ? { ...f, sent: null } : f,
    ]),
  );
  const history = historyFor(i.all, i.userMessageId, chosen.summary?.upto_message_id ?? null, sent);
  const block = i.endContext ? swap(i.block, i.oldNote, note) : i.block;
  const system = i.endContext ? i.req.system : swap(i.req.system ?? '', i.oldNote, note);
  const req: ModelRequest = {
    ...i.req,
    ...(system !== undefined && { system }),
    messages: [...withTurnContext(history, block), ...i.tail],
  };
  return { req, level: chosen.level, tokens_before: before, tokens_after: requestTokens(i.model, req) };
}
