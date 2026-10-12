/**
 * ------------------------------------------------------------------
 *  Title    |  Tree outline, windowed
 *  Ref      |  ROADMAP G (Branch trees with hundreds of forks)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A thread's tree as an indented list that stays quick
 *           |  with a thousand points: only the rows near the screen
 *           |  are in the page, like the conversation's windowing.
 *  How      |  Rows have one height; a spacer gives the list its full
 *           |  height and the rows in view sit at their place in it
 *           |  (outline.ts rowWindow). The list is one ARIA tree that
 *           |  owns focus and points at the selected row with
 *           |  aria-activedescendant; that row is always drawn. Each
 *           |  row has aria-level, aria-posinset and aria-setsize, so a
 *           |  screen reader knows where it is without the others.
 *           |  Arrow keys walk it (down and up in order, right to a
 *           |  child, left to the parent, Home and End), Enter opens.
 *  Note     |  j, k, h and l stay the app's own keys (the panel binds
 *           |  them); this list adds the standard tree keys.
 * ------------------------------------------------------------------
 */

import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flattenTree, type OutlineRow, rowWindow, scrollToRow, type TreeLike } from './outline';

/** The height a viewport is taken to have before it is measured (and in tests). */
const FALLBACK_VIEWPORT = 480;

export function TreeOutline<T extends TreeLike>({
  nodes,
  parentOf,
  selected,
  onSelect,
  onOpen,
  label,
  rowHeight = 36,
  idPrefix = 'tree-',
  renderRow,
  rowProps,
  onFocusChange,
}: {
  nodes: T[];
  parentOf: (n: T) => string | null;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
  label: string;
  rowHeight?: number;
  idPrefix?: string;
  renderRow: (row: OutlineRow<T>) => ReactNode;
  rowProps?: (row: OutlineRow<T>) => Record<string, unknown>;
  onFocusChange?: (focused: boolean) => void;
}) {
  const rows = useMemo(() => flattenTree(nodes, parentOf), [nodes, parentOf]);
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.node.id, i] as const)), [rows]);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const at = selected !== undefined ? indexOf.get(selected) : undefined;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || FALLBACK_VIEWPORT);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the selected row in view as it moves.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || at === undefined) return;
    const next = scrollToRow(at, el.scrollTop, el.clientHeight || viewport, rowHeight);
    if (next !== null) {
      el.scrollTop = next;
      setScrollTop(next);
    }
  }, [at, rowHeight, viewport]);

  const shown = rowWindow(rows.length, scrollTop, viewport, rowHeight, 8, at);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (at === undefined) {
      if (rows[0] && (e.key === 'ArrowDown' || e.key === 'Home')) onSelect(rows[0].node.id);
      return;
    }
    const cur = rows[at] as OutlineRow<T>;
    let next: number | undefined;
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else if (e.key === 'ArrowRight') next = cur.hasChildren ? at + 1 : undefined;
    else if (e.key === 'ArrowLeft') {
      const p = parentOf(cur.node);
      next = p ? indexOf.get(p) : undefined;
    } else if (e.key === 'Enter' && onOpen) {
      e.preventDefault();
      onOpen(cur.node.id);
      return;
    } else return;
    e.preventDefault();
    const row = next !== undefined ? rows[next] : undefined;
    if (row) onSelect(row.node.id);
  };

  return (
    <div
      ref={scroller}
      className="tree tree--windowed"
      role="tree"
      aria-label={label}
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      aria-activedescendant={selected && at !== undefined ? `${idPrefix}${selected}` : undefined}
    >
      <div className="tree__spacer" style={{ height: rows.length * rowHeight }}>
        {shown.map((i) => {
          const r = rows[i] as OutlineRow<T>;
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: the tree owns focus via aria-activedescendant
            <div
              key={r.node.id}
              id={`${idPrefix}${r.node.id}`}
              role="treeitem"
              aria-level={r.level}
              aria-posinset={r.pos}
              aria-setsize={r.size}
              aria-selected={selected === r.node.id}
              aria-expanded={r.hasChildren ? true : undefined}
              className="tree__row"
              data-selected={selected === r.node.id || undefined}
              style={{ '--depth': r.level - 1, top: i * rowHeight, height: rowHeight } as CSSProperties}
              onClick={() => onSelect(r.node.id)}
              onDoubleClick={() => onOpen?.(r.node.id)}
              onKeyDown={() => {}}
              {...rowProps?.(r)}
            >
              {renderRow(r)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
