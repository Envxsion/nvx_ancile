/**
 * ------------------------------------------------------------------
 *  Title    |  What is loading, and its dot
 *  Ref      |  ROADMAP LM1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The few lines the status bar needs to show that an
 *           |  Ollama model is loading into memory.
 *  How      |  A tiny store (warming.tsx fills it when a model is
 *           |  picked) and the dot. The loading itself is code that
 *           |  is fetched on the first pick, so it is not part of
 *           |  the first download.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';
import '../styles/loaded.css';

interface WarmingState {
  /** Model ids loading right now. */
  loading: Record<string, true>;
  set: (id: string, on: boolean) => void;
}

export const useWarming = create<WarmingState>((set) => ({
  loading: {},
  set: (id, on) =>
    set((s) => {
      if (on === !!s.loading[id]) return s;
      const next = { ...s.loading };
      if (on) next[id] = true;
      else delete next[id];
      return { loading: next };
    }),
}));

/** The dot beside a model that is loading; nothing otherwise. */
export function WarmingDot({ modelId }: { modelId: string | null | undefined }) {
  const on = useWarming((s) => (modelId ? !!s.loading[modelId] : false));
  if (!on) return null;
  return (
    <span className="warming-dot" role="status">
      <span className="sr-only">Loading into memory</span>
    </span>
  );
}
