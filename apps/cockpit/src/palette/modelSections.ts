/**
 * ------------------------------------------------------------------
 *  Title    |  The palette's model rows
 *  Ref      |  docs/models.md (What the pickers show) · roadmap MD2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Lay the "Change model" results out the way the composer's
 *           |  menu does: a heading per company, the current model of
 *           |  each line, and the previous generations folded under
 *           |  one quiet Older row, so a bigger lineup is not a longer
 *           |  list.
 *  How      |  Pure over the groups useModelGroups builds. An
 *           |  OpenRouter copy of a model a provider serves directly is
 *           |  not a second row: the direct row says "also via
 *           |  OpenRouter", and the copy is still found by typing.
 *           |  Typing shows everything that matches, older included.
 *  Note     |  The model in use is never folded away.
 * ------------------------------------------------------------------
 */

import type { ModelEntry, ModelGroup } from '../engines/api';
import { groupedBy, splitOlder } from '../models/lineup';

export interface ModelSection {
  key: string;
  /** The group it belongs to: which Older row opens its previous generations. */
  kind: ModelGroup['kind'];
  /** The heading cmdk shows above the rows. */
  heading: string;
  items: ModelEntry[];
  /** How many older models wait behind the Older row that ends this section; 0 for none. */
  older: number;
}

/** "Anthropic: Claude Sonnet 5.5" and "Claude Sonnet 5.5" are one name. */
const plain = (name: string): string =>
  name
    .replace(/^[^:]{2,24}:\s+/, '')
    .toLowerCase()
    .trim();

const viaOpenRouter = (e: ModelEntry): boolean => e.model?.provider === 'OpenRouter';

/**
 * Ids of the OpenRouter copies of a model a provider serves directly, mapped to the direct row that
 * stands for them. Matching is by name: the same line, the same words.
 */
export function openRouterCopies(entries: readonly ModelEntry[]): Map<string, string> {
  const direct = new Map<string, string>();
  for (const e of entries) if (e.kind === 'cloud' && !viaOpenRouter(e)) direct.set(plain(e.name), e.id);
  const out = new Map<string, string>();
  for (const e of entries) {
    if (e.kind !== 'cloud' || !viaOpenRouter(e) || e.current) continue;
    const to = direct.get(plain(e.name));
    if (to) out.set(e.id, to);
  }
  return out;
}

export function modelSections(
  groups: readonly ModelGroup[],
  opts: { typed: boolean; olderOpen: ReadonlySet<string> },
): { sections: ModelSection[]; also: ReadonlySet<string> } {
  const copies = openRouterCopies(groups.flatMap((g) => g.items));
  const also = new Set(copies.values());
  const sections: ModelSection[] = [];
  for (const g of groups) {
    // Typing finds everything; browsing hides the copies and folds the older.
    const items = opts.typed ? g.items : g.items.filter((e) => !copies.has(e.id));
    if (opts.typed) {
      sections.push({ key: g.kind, kind: g.kind, heading: g.label, items: [...items], older: 0 });
      continue;
    }
    const { current, older } = splitOlder(
      items,
      items.filter((e) => e.current).map((e) => e.id),
    );
    const parts = groupedBy(current, (e) => e.group);
    const headed = parts.length > 1 && parts.some((p) => p.label);
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const open = opts.olderOpen.has(g.kind);
      sections.push({
        key: `${g.kind}:${p.label ?? ''}`,
        kind: g.kind,
        heading: headed && p.label ? p.label : g.label,
        items: last && open ? [...p.items, ...older] : p.items,
        older: last && !open ? older.length : 0,
      });
    });
    if (!parts.length && older.length)
      sections.push({
        key: `${g.kind}:older`,
        kind: g.kind,
        heading: g.label,
        items: [],
        older: older.length,
      });
  }
  return { sections, also };
}
