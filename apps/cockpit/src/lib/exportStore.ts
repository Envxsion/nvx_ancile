/**
 * ------------------------------------------------------------------
 *  Title    |  Which thread the Export dialog is for
 *  Ref      |  roadmap EX3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One place that says "export this thread", so the
 *           |  thread menu, the palette and the message actions all
 *           |  open the same dialog.
 *  How      |  A tiny store; the dialog itself loads on first use.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';

interface ExportState {
  threadId: string | null;
  open: (threadId: string) => void;
  close: () => void;
}

export const useExport = create<ExportState>((set) => ({
  threadId: null,
  open: (threadId) => set({ threadId }),
  close: () => set({ threadId: null }),
}));

export const openExport = (threadId: string): void => useExport.getState().open(threadId);
