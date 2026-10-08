/**
 * ------------------------------------------------------------------
 *  Title    |  Branch layer state
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Which branching surface is open: the full-screen tree,
 *           |  a comparison, the merge dialog, a delete waiting for
 *           |  confirmation, a branch being renamed. Anything can open
 *           |  one (tree, message actions, palette); BranchLayer draws
 *           |  them.
 *  How      |  A small Zustand store; selectors read single fields.
 * ------------------------------------------------------------------
 */

import type { Branch } from '@nvx/contracts';
import { create } from 'zustand';
import { subtreeSize } from '../lib/branching';

export interface ComparePair {
  threadId: string;
  a: string;
  b: string;
}

interface BranchLayerState {
  full: boolean;
  compare: ComparePair | null;
  merge: (ComparePair & { strategy?: 'manual' | 'synthesize' }) | null;
  del: { threadId: string; messageId: string; count: number } | null;
  rename: { threadId: string; branch: Branch } | null;
  setFull: (open: boolean) => void;
  setCompare: (p: ComparePair | null) => void;
  setMerge: (p: BranchLayerState['merge']) => void;
  setDel: (d: BranchLayerState['del']) => void;
  setRename: (r: BranchLayerState['rename']) => void;
}

export const useBranchLayer = create<BranchLayerState>((set) => ({
  full: false,
  compare: null,
  merge: null,
  del: null,
  rename: null,
  setFull: (full) => set({ full }),
  setCompare: (compare) => set({ compare }),
  setMerge: (merge) => set({ merge }),
  setDel: (del) => set({ del }),
  setRename: (rename) => set({ rename }),
}));

export function openCompare(threadId: string, a: string, b: string): void {
  useBranchLayer.setState({ compare: { threadId, a, b }, full: false });
}

/** Ask Core how much a delete removes, then ask the person. */
export async function askDelete(threadId: string, messageId: string): Promise<void> {
  const count = await subtreeSize(messageId);
  if (count !== null) useBranchLayer.setState({ del: { threadId, messageId, count } });
}
