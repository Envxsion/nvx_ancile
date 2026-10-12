/**
 * ------------------------------------------------------------------
 *  Title    |  Code editor: which file is open
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The code editor opens from many places (a tool step's
 *           |  Read, Edit or Write, an artifact, the palette later).
 *           |  One small store says which file is open, and the edit
 *           |  to compare when it came from an agent's change.
 *  How      |  openFile({ path, threadId, edit? }) / closeFile().
 *           |  FileEditorHost (mounted once in AppShell) draws it.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';
import type { AgentEdit } from './before';

export interface OpenFile {
  /** Absolute, or /workspace/…, or relative to the workspace. */
  path: string;
  /** The thread that mentioned it, so its scope applies to reading and saving. */
  threadId: string | null;
  /** An agent's change to show on the Changes tab. */
  edit?: AgentEdit | null;
  /** Start in edit mode instead of read-only. */
  editing?: boolean;
}

interface FileEditorState {
  open: OpenFile | null;
  show: (f: OpenFile) => void;
  close: () => void;
}

export const useFileEditor = create<FileEditorState>((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null }),
}));

export const openFile = (f: OpenFile) => useFileEditor.getState().show(f);
export const closeFile = () => useFileEditor.getState().close();
