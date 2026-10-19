/**
 * ------------------------------------------------------------------
 *  Title    |  Highlighted text and its fact-check card
 *  Ref      |  roadmap FC3 · DESIGN.md §10
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Hold what the person has highlighted in a message (so a
 *           |  small bar can offer Fact-check beside it) and the one
 *           |  card that is open for a highlight.
 *  How      |  `toolbar` is the live highlight, set while text is
 *           |  selected in a message. `card` is a highlight someone chose
 *           |  to check; it keeps the range, so the words stay marked
 *           |  where they are while the card is read (the browser's own
 *           |  selection goes the moment you click the card).
 *  Note     |  Small on purpose: it loads with the thread. The card
 *           |  itself loads on first use (thread/FactcheckCard.tsx).
 * ------------------------------------------------------------------
 */

import type { SelectionKind } from '@nvx/contracts';
import { create } from 'zustand';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Highlight {
  messageId: string;
  threadId: string;
  /** The words highlighted, as selected. */
  text: string;
  /** What the highlight sat inside (a code block, a link), when the page could tell. */
  kind?: SelectionKind | undefined;
  /** Where it is on screen now. */
  box: Box;
  /** The range, kept to mark the words and to move the card with them. */
  range: Range | null;
  /** How the bar was asked for: by selecting, or by the context menu at a point. */
  via: 'select' | 'menu';
  at: { x: number; y: number } | null;
}

export interface OpenCard extends Highlight {
  /** Changes with every ask, so a card checks once per ask. */
  nonce: number;
  /** Allow the web for this check (FC4). */
  web?: boolean;
  again?: boolean;
}

interface SelectionCheckState {
  toolbar: Highlight | null;
  card: OpenCard | null;
  showToolbar: (h: Highlight) => void;
  hideToolbar: (messageId?: string) => void;
  /** Open the card for a highlight (the bar's button, the F key, the menu). */
  openCard: (h: Highlight, opts?: { web?: boolean; again?: boolean }) => void;
  closeCard: () => void;
}

let nonce = 0;

export const useSelectionCheck = create<SelectionCheckState>((set) => ({
  toolbar: null,
  card: null,
  showToolbar: (h) => set({ toolbar: h }),
  hideToolbar: (messageId) =>
    set((s) => (messageId && s.toolbar?.messageId !== messageId ? s : { toolbar: null })),
  openCard: (h, opts = {}) =>
    set({
      toolbar: null,
      card: {
        ...h,
        nonce: ++nonce,
        ...(opts.web && { web: true }),
        ...(opts.again && { again: true }),
      },
    }),
  closeCard: () => set({ card: null }),
}));
