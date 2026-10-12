/**
 * Branch trees with hundreds of forks: the outline is windowed (only rows
 * near the screen are in the page), keeps tree semantics (level, place among
 * siblings, the selected row always present for aria-activedescendant) and
 * keyboard walking, and big trees get a one-pass layout and a windowed
 * accessible mirror. Measured on a 1,000-node fixture.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TreePanel } from '../src/drawer/TreePanel';
import type { TreeNodeView } from '../src/lib/types';
import { MIRROR_RADIUS, mirrorSlice } from '../src/tree/BranchTree';
import { flattenTree, quickLayout, rowWindow, scrollToRow } from '../src/tree/outline';
import { TreeOutline } from '../src/tree/TreeOutline';

/** A thread of 1,000 points: a main path with a fork every few messages, some forks forking again. */
function bigTree(n = 1000): TreeNodeView[] {
  const out: TreeNodeView[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < n; i++) {
    const parent = i === 0 ? null : rand() < 0.7 ? `m${i - 1}` : `m${Math.floor(rand() * i)}`;
    out.push({
      id: `m${i}`,
      parentId: parent,
      role: i % 2 ? 'assistant' : 'user',
      preview: `Point ${i}`,
      modelId: null,
      collapsed: 0,
      branch: null,
      active: false,
    });
  }
  return out;
}

const parentOf = (n: TreeNodeView) => n.parentId;

describe('outline helpers', () => {
  it('flattens a 1,000-node tree in one pass, depth first, with level and place among siblings', () => {
    const nodes = bigTree();
    const t0 = performance.now();
    const rows = flattenTree(nodes, parentOf);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(rows).toHaveLength(1000);
    expect(rows[0]).toMatchObject({ level: 1, pos: 1, size: 1 });
    const at = new Map(rows.map((r, i) => [r.node.id, i]));
    for (const r of rows) {
      if (!r.node.parentId) continue;
      const p = rows[at.get(r.node.parentId) as number];
      // A child comes after its parent, one level down; its place is within its set.
      expect(at.get(r.node.id) as number).toBeGreaterThan(at.get(r.node.parentId) as number);
      expect(r.level).toBe((p?.level ?? 0) + 1);
      expect(r.pos).toBeGreaterThanOrEqual(1);
      expect(r.pos).toBeLessThanOrEqual(r.size);
      expect(p?.hasChildren).toBe(true);
    }
  });

  it('survives a chain a thousand deep and a parent that is not there', () => {
    const chain = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, p: i ? `c${i - 1}` : 'missing' }));
    const rows = flattenTree(chain, (n) => n.p);
    expect(rows.at(-1)?.level).toBe(1000);
  });

  it('windows a list and brings a row into view', () => {
    expect(rowWindow(1000, 0, 360, 36, 2)).toEqual([...Array(13).keys()]);
    const w = rowWindow(1000, 3600, 360, 36, 2, 999);
    expect(w[0]).toBe(98);
    expect(w.at(-1)).toBe(999); // the kept row is always there
    expect(rowWindow(0, 0, 360, 36)).toEqual([]);
    expect(scrollToRow(50, 0, 360, 36)).toBe(50 * 36 + 36 - 360);
    expect(scrollToRow(2, 0, 360, 36)).toBeNull();
    expect(scrollToRow(1, 400, 360, 36)).toBe(36);
  });

  it('lays out a 1,000-node tree in one pass: children a level below, parents over their children', () => {
    const nodes = bigTree();
    const t0 = performance.now();
    const pos = quickLayout(nodes, parentOf, { w: 220, h: 58, gapX: 18, gapY: 30 });
    expect(performance.now() - t0).toBeLessThan(300);
    expect(pos.size).toBe(1000);
    const seen = new Set<string>();
    for (const n of nodes) {
      const p = pos.get(n.id);
      expect(p).toBeDefined();
      const key = `${p?.x}:${p?.y}`;
      expect(seen.has(key)).toBe(false); // no two nodes on one spot
      seen.add(key);
      if (n.parentId) expect(p?.y).toBe((pos.get(n.parentId)?.y ?? 0) + 88);
    }
  });

  it('lists the accessible mirror near the cursor for a big tree, all of a small one', () => {
    expect(mirrorSlice(10, 3)).toEqual([...Array(10).keys()]);
    const big = mirrorSlice(1000, 500);
    expect(big).toHaveLength(MIRROR_RADIUS * 2 + 1);
    expect(big).toContain(500);
    expect(mirrorSlice(1000, 999).at(-1)).toBe(999);
    expect(mirrorSlice(1000, undefined)[0]).toBe(0);
  });
});

describe('the windowed outline', () => {
  it('draws only rows near the screen out of 1,000, with tree semantics, and walks with the keys', () => {
    const nodes = bigTree();
    let selected = 'm0';
    const view = () => (
      <TreeOutline
        nodes={nodes}
        parentOf={parentOf}
        selected={selected}
        onSelect={(id) => {
          selected = id;
        }}
        label="Branches in this thread"
        renderRow={(r) => <span>{r.node.preview}</span>}
      />
    );
    const { rerender } = render(view());
    const tree = screen.getByRole('tree', { name: 'Branches in this thread' });
    const items = () => screen.getAllByRole('treeitem');
    expect(items().length).toBeLessThan(40);
    expect(items()[0]?.getAttribute('aria-level')).toBe('1');
    expect(items()[0]?.getAttribute('aria-setsize')).toBe('1');
    expect(tree.getAttribute('aria-activedescendant')).toBe('tree-m0');
    expect(document.getElementById('tree-m0')?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    rerender(view());
    const second = flattenTree(nodes, parentOf)[1]?.node.id;
    expect(selected).toBe(second);
    expect(tree.getAttribute('aria-activedescendant')).toBe(`tree-${second}`);

    fireEvent.keyDown(tree, { key: 'End' });
    rerender(view());
    const last = flattenTree(nodes, parentOf).at(-1)?.node.id as string;
    expect(selected).toBe(last);
    // The selected row is in the page however far down it is.
    expect(document.getElementById(`tree-${last}`)).not.toBeNull();
    expect(items().length).toBeLessThan(60);

    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    rerender(view());
    expect(selected).toBe(nodes.find((n) => n.id === last)?.parentId);
    fireEvent.keyDown(tree, { key: 'Home' });
    rerender(view());
    expect(selected).toBe('m0');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    rerender(view());
    expect(selected).toBe(second);
  });

  it('moves the window as the list scrolls', () => {
    const nodes = bigTree();
    render(
      <TreeOutline
        nodes={nodes}
        parentOf={parentOf}
        selected="m0"
        onSelect={() => {}}
        label="Tree"
        rowHeight={36}
        renderRow={(r) => <span>{r.node.preview}</span>}
      />,
    );
    const tree = screen.getByRole('tree');
    act(() => {
      tree.scrollTop = 36 * 600;
      fireEvent.scroll(tree);
    });
    const ids = screen.getAllByRole('treeitem').map((el) => el.id);
    const rows = flattenTree(nodes, parentOf);
    expect(ids).toContain(`tree-${rows[600]?.node.id}`);
    expect(ids).toContain('tree-m0'); // the selected row stays
    expect(ids.length).toBeLessThan(50);
  });

  it('the panel takes a 1,000-node tree and counts its points', () => {
    render(<TreePanel nodes={bigTree()} />);
    expect(screen.getByText('1000')).toBeTruthy();
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(40);
  });
});
