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
