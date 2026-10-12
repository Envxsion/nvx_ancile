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

/** History for the model: root → the user message being answered. */
export function historyFor(
  messages: MessageRecord[],
  userMessageId: string,
  /** A compaction summary covers the path up to and including this message. */
  skipThrough?: string | null,
): ModelMessage[] {
  const byId = new Map(asTree(messages).map((m) => [m.id, m] as const));
  const path = ancestorPath(byId, userMessageId);
  const from = skipThrough ? path.findIndex((m) => m.id === skipThrough) + 1 : 0;
  return path
    .slice(from)
    .filter((m) => m.role !== 'system')
    .map((m): ModelMessage => ({ role: m.role, content: textOf(m.parts), parts: m.parts }))
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
 */
export function withTurnContext(history: ModelMessage[], block: string): ModelMessage[] {
  if (!block) return history;
  const i = history.findLastIndex((m) => m.role === 'user');
  const q = history[i];
  if (!q) return history;
  const lead = `${block}\n\n---\n\n`;
  const next: ModelMessage = {
    ...q,
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
}): Promise<string> {
  const template = await loadPrompt(opts.promptsDir, 'system.base', BUILTIN_SYSTEM);
  // The date only: a clock to the minute at the top of the system prompt made
  // every turn's prompt new to the provider, so no prompt cache ever held.
  const now = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const base = render(template, {
    user_name: 'the user',
    now: `${now} (UTC)`,
    model_name: opts.model?.display_name ?? 'a language model',
    notebook_title: opts.notebookTitle ?? null,
  });
  return opts.tools ? `${base}\n\n${TOOLS_NOTE}` : base;
}
