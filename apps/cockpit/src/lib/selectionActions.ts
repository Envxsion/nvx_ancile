/**
 * ------------------------------------------------------------------
 *  Title    |  Acting on part of an answer
 *  Ref      |  roadmap AN2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the bar beside a highlight does besides
 *           |  Fact-check: quote the words in your reply, ask about
 *           |  them, save them to a note with a link back, or branch
 *           |  the thread from the message they are in.
 *  How      |  Quote and Ask write into the composer through the same
 *           |  insert event the fact-check card uses; they join what
 *           |  is already written and are never sent for you. Save to
 *           |  note keeps the words and a link that opens the thread
 *           |  at that message. Loaded when the bar is first used.
 *  Note     |  Highlighted text is data: it is quoted as text, never
 *           |  run, and a note holds it as a block quote.
 *           |  "Ask another model about this" is Pro's (pro/SideAsk.tsx
 *           |  opens its card; the bar button is public, gated there).
 * ------------------------------------------------------------------
 */

import { threadLink } from '../desktop/api';
import { notify } from '../state/notify';
import { branchHere } from './branching';
import { keys } from './data';
import { createNote } from './notebooks';
import { queryClient } from './query';
import type { ThreadView } from './types';

/** Longest quote put into a reply or a note; the rest is cut with a mark saying so. */
export const QUOTE_MAX = 1_500;

/** The words as a Markdown block quote, every line marked, long text cut at a word. */
export function quoteBlock(text: string, max = QUOTE_MAX): string {
  const clean = text.replace(/\r/g, '').trim();
  const cut = clean.length > max ? `${clean.slice(0, max).replace(/\s+\S*$/, '')} …` : clean;
  return cut
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

/** A first line for a note from the words: short, one line, no marks. */
export function noteTitle(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find(Boolean) ?? 'Saved from an answer';
  return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}

/** The link that opens the thread on this message (the #message-id jump). */
export const messageLink = (threadId: string, messageId: string): string =>
  `${threadLink(threadId)}#${messageId}`;

/** Put text in the thread's composer, after what is written, and focus it. Never sent. */
export function insertInComposer(threadId: string, text: string): void {
  window.dispatchEvent(new CustomEvent('ancile:composer-insert', { detail: { threadId, text } }));
}

export function quoteInReply(threadId: string, text: string): void {
  insertInComposer(threadId, `${quoteBlock(text)}\n\n`);
}

export function askAbout(threadId: string, text: string): void {
  insertInComposer(
    threadId,
    `About this:\n\n${quoteBlock(text)}\n\nWhat does it mean, and how sure are you?`,
  );
}

export async function saveToNote(a: { threadId: string; messageId: string; text: string }): Promise<void> {
  const nb = queryClient.getQueryData<ThreadView>(keys.thread(a.threadId))?.notebookId;
  if (!nb) {
    notify({
      level: 'info',
      title: 'Notes live in notebooks',
      body: 'Move this thread into a notebook (right-click it in the sidebar), then save the words.',
    });
    return;
  }
  const content = `${quoteBlock(a.text)}\n\n[Back to the answer](${messageLink(a.threadId, a.messageId)})\n`;
  const note = await createNote(nb, noteTitle(a.text), content);
  if (note) notify({ level: 'success', title: 'Saved to a note', body: 'It links back to this answer.' });
}

export async function branchFrom(threadId: string, messageId: string): Promise<void> {
  await branchHere(threadId, messageId, {
    previousHead: queryClient.getQueryData<ThreadView>(keys.thread(threadId))?.messages.at(-1)?.id ?? null,
  });
}
