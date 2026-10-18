/**
 * ------------------------------------------------------------------
 *  Title    |  Turn context
 *  Ref      |  DESIGN.md §1.3 (stage: context), §8
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What the model sees for a turn: the system prompt and
 *           |  exactly the ancestor path of the message being answered,
 *           |  plus whatever this turn has produced so far (text and
 *           |  tool results from earlier rounds).
 *  How      |  Messages are loaded once per round and walked with
 *           |  ancestorPath(); nothing from sibling branches can leak
 *           |  in, because only parents are followed.
 *  Note     |  Compaction substitution: a summary replaces the path up
 *           |  to its message (threads/compact.ts decides which).
 * ------------------------------------------------------------------
 */

import type { ModelConfig, Part } from '@nvx/contracts';
import type { ModelMessage } from '../gateway/types';
import { ancestorPath } from '../threads/path';
import { asTree, type MessageRecord, textOf } from '../threads/repo';
import { BUILTIN_SYSTEM, loadPrompt, render, TOOLS_NOTE } from './prompt';

/** The messages from the root to the one being answered (nothing from sibling branches). */
export function pathFor(messages: MessageRecord[], userMessageId: string): MessageRecord[] {
  const byId = new Map(asTree(messages).map((m) => [m.id, m] as const));
  return ancestorPath(byId, userMessageId);
}

/** History for the model: root → the user message being answered. */
export function historyFor(
  messages: MessageRecord[],
  userMessageId: string,
  /** A compaction summary covers the path up to and including this message. */
  skipThrough?: string | null,
  /** CA4: what each message was sent as (text), by id; a message without one is rebuilt from its parts. */
  sentOf?: ReadonlyMap<string, { sent: string | null }>,
): ModelMessage[] {
  const path = pathFor(messages, userMessageId);
  const from = skipThrough ? path.findIndex((m) => m.id === skipThrough) + 1 : 0;
  return path
    .slice(from)
    .filter((m) => m.role !== 'system')
    .map((m): ModelMessage => {
      // The question being answered is sent fresh; every earlier message as it was sent.
      const sent = m.id === userMessageId ? null : sentOf?.get(m.id)?.sent;
      return { role: m.role, content: textOf(m.parts), parts: m.parts, ...(sent && { sent }) };
    })
    .filter(
      (m) =>
        m.role !== 'assistant' ||
        (m.parts ?? []).some((p) => (p.type === 'text' && p.text.trim()) || p.type === 'tool_call'),
    );
}

/**
 * This turn's context (retrieved passages, linked summaries) on the question
 * being answered, ahead of its words. Kept out of the system prompt so the
 * prompt's start (system prompt, then earlier turns) is the same from turn to
 * turn and providers' prompt caches hold; the passages change every turn.
 *
 * Eval note: with passages placed after the history, a 7B model once
 * re-answered the previous question. The block is therefore labelled as
 * reference material for the latest question, and the question itself is
 * always the last thing the model reads (test/conductor/cache-prefix.test.ts).
 */
export const REFERENCE_HEADER =
  'Context for the latest question only. NVX Ancile added it; the user did not write it, and it is not a question to answer:';
export const LATEST_QUESTION = 'The latest question, to answer now:';

export function withTurnContext(history: ModelMessage[], block: string): ModelMessage[] {
  if (!block) return history;
  const i = history.findLastIndex((m) => m.role === 'user');
  const q = history[i];
  if (!q) return history;
  const lead = `${REFERENCE_HEADER}\n\n${block}\n\n---\n\n${LATEST_QUESTION}\n\n`;
  // A stored sent form belongs to the question as it was last answered; this is a new send.
  const { sent: _old, ...fresh } = q;
  const next: ModelMessage = {
    ...fresh,
    content: `${lead}${q.content}`,
    ...(q.parts && { parts: [{ type: 'text', text: lead }, ...q.parts] }),
  };
  return [...history.slice(0, i), next, ...history.slice(i + 1)];
}

export function withPartial(history: ModelMessage[], parts: Part[]): ModelMessage[] {
  return parts.length ? [...history, { role: 'assistant', content: textOf(parts), parts }] : history;
}

export async function systemPrompt(opts: {
  promptsDir: string;
  model: ModelConfig | undefined;
  notebookTitle?: string | null;
  tools: boolean;
  now?: Date;
  /**
   * With the date in it (default). CA2: a prompt kept for a whole epoch has
   * none; the date rides in the context block at the end of the request.
   */
  dated?: boolean;
}): Promise<string> {
  const template = await loadPrompt(opts.promptsDir, 'system.base', BUILTIN_SYSTEM);
  // The date only: a clock to the minute at the top of the system prompt made
  // every turn's prompt new to the provider, so no prompt cache ever held.
  const now = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const base = render(template, {
    user_name: 'the user',
    now: opts.dated === false ? '' : `${now} (UTC)`,
    model_name: opts.model?.display_name ?? 'a language model',
    notebook_title: opts.notebookTitle ?? null,
  });
  return opts.tools ? `${base}\n\n${TOOLS_NOTE}` : base;
}
