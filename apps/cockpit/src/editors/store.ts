/**
 * ------------------------------------------------------------------
 *  Title    |  Editors: which one is open
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The scope editor, the instructions and persona editor,
 *           |  and "New Claude Code thread in a folder" open from many
 *           |  places (the rail's menus, a notebook's menu, the thread
 *           |  header's chip, the palette, the model picker). One small
 *           |  store says which is open; EditorsHost draws it.
 *  How      |  openEditor({ kind, … }) / closeEditor(). One at a time.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';

export type Editor =
  | { kind: 'scope'; level: 'notebook' | 'thread'; id: string }
  | { kind: 'instructions'; level: 'notebook' | 'thread'; id: string }
  | { kind: 'new-claude-code'; notebookId: string | null; cwd: string | null }
  /** Context links of a thread or notebook (docs/notebooks.md). */
  | { kind: 'links'; level: 'notebook' | 'thread'; id: string; title: string; notebookId: string | null }
  /** Attach or detach context packs, or make one from this thread (Pro; the free build explains). */
  | { kind: 'packs'; level: 'notebook' | 'thread'; id: string; title: string }
  /** Merge another notebook into this one, optionally with it chosen already. */
  | { kind: 'merge'; into: { id: string; title: string }; from: string | null };

interface EditorsState {
  open: Editor | null;
  show: (e: Editor) => void;
  close: () => void;
}

export const useEditors = create<EditorsState>((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null }),
}));

export const openEditor = (e: Editor) => useEditors.getState().show(e);
export const closeEditor = () => useEditors.getState().close();
