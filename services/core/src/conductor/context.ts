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

import { type ModelConfig, type Part, SteeredNote } from '@nvx/contracts';
import type { ModelMessage } from '../gateway/types';
import { ancestorPath, childrenIndex } from '../threads/path';
import { asTree, type MessageRecord, textOf } from '../threads/repo';
import { citedForHistory } from './citations';
import { BUILTIN_SYSTEM, loadPrompt, render, TOOLS_NOTE } from './prompt';
import { noteMessage } from './steer';

/** The messages from the root to the one being answered (nothing from sibling branches). */
export function pathFor(messages: MessageRecord[], userMessageId: string): MessageRecord[] {
  const byId = new Map(asTree(messages).map((m) => [m.id, m] as const));
  return ancestorPath(byId, userMessageId);
}

/**
 * CA5: an id for the branch a question is on, the same on every turn of it. The
 * first message after the nearest fork on the path (a regenerated answer, an
 * edited question); with no fork, the first message of the thread. Different
 * branches get different ids, so each keeps its own provider cache key.
 */
export function branchKeyFor(messages: MessageRecord[], userMessageId: string): string {
  const tree = asTree(messages);
  const path = pathFor(messages, userMessageId);
  const kids = childrenIndex(tree);
  for (let i = path.length - 1; i >= 0; i--) {
    const m = path[i] as MessageRecord;
    if ((kids.get(path[i - 1]?.id ?? null)?.length ?? 0) > 1) return m.id;
  }
  return path[0]?.id ?? userMessageId;
}

/** History for the model: root → the user message being answered. */
export function historyFor(
  messages: MessageRecord[],
  userMessageId: string,
  /** A compaction summary covers the path up to and including this message. */
  skipThrough?: string | null,
  /** CA4: what each message was sent as (text), by id; a message without one is rebuilt from its parts. */
  sentOf?: ReadonlyMap<string, { sent: string | null; epoch_id?: string | null }>,
): ModelMessage[] {
  const path = pathFor(messages, userMessageId);
  const from = skipThrough ? path.findIndex((m) => m.id === skipThrough) + 1 : 0;
  return path
    .slice(from)
    .filter((m) => m.role !== 'system')
    .flatMap((m): ModelMessage[] => {
      // The question being answered is sent fresh; every earlier message as it was sent.
      const form = m.id === userMessageId ? undefined : sentOf?.get(m.id);
      const sent = form?.sent;
      const epoch = form?.epoch_id ? { epochId: form.epoch_id } : {};
      // HO1: an earlier answer's [n] markers are named by their sources (the numbers restart each turn).
      const parts = m.role === 'assistant' ? citedForHistory(m.parts) : m.parts;
      const whole: ModelMessage = {
        role: m.role,
        content: textOf(parts),
        parts,
        ...(sent && { sent }),
        ...epoch,
      };
      const kept =
        m.role !== 'assistant' ||
        m.parts.some((p) => (p.type === 'text' && p.text.trim()) || p.type === 'tool_call');
      if (!kept) return [];
      // CH7: an answer that took notes. Its stored sent form already has them in place (CA4); one
      // without (it could not be stored) is rebuilt from its parts with the notes spliced back in.
      const steered = m.role === 'assistant' && !sent ? steeredOf(m.provenance) : [];
      if (!steered.length) return [whole];
      return spliceNotes(m.parts, steered).map((x) => (x.role === 'assistant' ? { ...x, ...epoch } : x));
    });
}

/** provenance.steered, read defensively: a malformed entry is dropped, never thrown on. */
export function steeredOf(provenance: Record<string, unknown> | undefined): SteeredNote[] {
  const raw = provenance?.steered;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((n) => {
    const r = SteeredNote.safeParse(n);
    return r.success ? [r.data] : [];
  });
}

/**
 * CH7: the answer's parts with the notes put back where they were taken. A note records how many
 * parts came before it (`part`), taken at a step boundary where the parts end with every tool call
 * answered. So the turn reads in the order it happened: the work up to the note, the note, the work
 * after it. An empty slice is skipped; a note taken before any work sits right after the question.
 * The same function builds each round's request and a later turn's history, so the bytes agree.
 */
export function spliceNotes(parts: Part[], steered: readonly SteeredNote[] | undefined): ModelMessage[] {
  const notes = (steered ?? [])
    .map((n, i) => ({ n, i, at: Math.min(Math.max(n.part ?? parts.length, 0), parts.length) }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  const out: ModelMessage[] = [];
  let from = 0;
  const slice = (to: number) => {
    const part = parts.slice(from, to);
    from = to;
    if (part.length) out.push({ role: 'assistant', content: textOf(part), parts: part });
  };
  for (const { n, at } of notes) {
    slice(at);
    out.push({ role: 'user', content: noteMessage(n.text) });
  }
  slice(parts.length);
  return out;
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
