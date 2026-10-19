/**
 * ------------------------------------------------------------------
 *  Title    |  Which thread a piece of an answer is in
 *  Ref      |  roadmap AN3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Let a code block in an answer know its thread without
 *           |  every renderer passing the id down.
 *  How      |  A React context the thread view provides; null outside
 *           |  a thread (a preview, a help article).
 * ------------------------------------------------------------------
 */

import { createContext, useContext } from 'react';

export const ThreadIdContext = createContext<string | null>(null);
export const useThreadId = (): string | null => useContext(ThreadIdContext);

/** The answer a block of code sits in: what "Apply to repo" and "Open as artifact" need to know about it. */
export interface AnswerInfo {
  messageId: string;
  /** When the answer was written (ISO): a file changed after this has moved on from the code. */
  createdAt: string;
  /** Still being written: a fence in it may be unfinished. */
  streaming: boolean;
}
export const AnswerContext = createContext<AnswerInfo | null>(null);
export const useAnswer = (): AnswerInfo | null => useContext(AnswerContext);
