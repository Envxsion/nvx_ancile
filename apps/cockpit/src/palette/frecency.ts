/**
 * ------------------------------------------------------------------
 *  Title    |  Palette frecency
 *  Ref      |  DESIGN.md §12 (palette)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Remember what you reach for in the palette, and how
 *           |  lately, so "Recent" can offer it first.
 *  How      |  Uses live in localStorage, keyed "kind:id". liveUses
 *           |  leaves out threads and notebooks that no longer exist
 *           |  (deleted notebooks, threads in the Trash or purged),
 *           |  and forgetUses removes them for good, so the palette
 *           |  never offers a place that opens to "not found".
 * ------------------------------------------------------------------
 */

export const FRECENCY_KEY = 'nvx.ancile.palette.frecency';

export type Use = { n: number; last: number; label: string; kind: 'thread' | 'notebook' | 'command' };

export function readUses(): Record<string, Use> {
  try {
    return JSON.parse(localStorage.getItem(FRECENCY_KEY) ?? '{}') as Record<string, Use>;
  } catch {
    return {};
  }
}

function writeUses(all: Record<string, Use>): void {
  try {
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked */
  }
}

export function score(u: Use): number {
  const hours = (Date.now() - u.last) / 3_600_000;
  return u.n / (1 + hours / 24);
}

export function recordUse(key: string, use: Omit<Use, 'n' | 'last'>): void {
  const all = readUses();
  const prev = all[key];
  all[key] = { ...use, n: (prev?.n ?? 0) + 1, last: Date.now() };
  const top = Object.entries(all)
    .sort((a, b) => score(b[1]) - score(a[1]))
    .slice(0, 60);
  writeUses(Object.fromEntries(top));
}

/** What is known to be gone. `notebooks` is the full list of notebooks that exist, once loaded. */
export interface Known {
  /** Every notebook that exists (absent: not loaded yet, so none is judged gone). */
  notebooks?: readonly string[];
  /** Threads known to be gone: in the Trash, or a 404 when asked for. */
  gone?: ReadonlySet<string>;
}

/** The uses whose notebook or thread still exists, as far as is known. */
export function liveUses(uses: Record<string, Use>, known: Known): Record<string, Use> {
  const notebooks = known.notebooks ? new Set(known.notebooks) : null;
  return Object.fromEntries(
    Object.entries(uses).filter(([key, u]) => {
      const id = key.slice(key.indexOf(':') + 1);
      if (u.kind === 'notebook') return !notebooks || notebooks.has(id);
      if (u.kind === 'thread') return !known.gone?.has(id);
      return true;
    }),
  );
}

/** Forget these uses for good. Returns how many were stored. */
export function forgetUses(keys: readonly string[]): number {
  const all = readUses();
  let n = 0;
  for (const k of keys)
    if (k in all) {
      delete all[k];
      n++;
    }
  if (n) writeUses(all);
  return n;
}
