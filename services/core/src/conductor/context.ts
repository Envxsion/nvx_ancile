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
  const now = (opts.now ?? new Date()).toISOString().replace('T', ' ').slice(0, 16);
  const base = render(template, {
    user_name: 'the user',
    now: `${now} UTC`,
    model_name: opts.model?.display_name ?? 'a language model',
    notebook_title: opts.notebookTitle ?? null,
  });
  return opts.tools ? `${base}\n\n${TOOLS_NOTE}` : base;
}
