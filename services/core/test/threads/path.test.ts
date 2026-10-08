import { describe, expect, it } from 'vitest';
import {
  ancestorPath,
  applyCompaction,
  BrokenTreeError,
  childrenIndex,
  collapseLinear,
  defaultLeaf,
  lowestCommonAncestor,
  siblingInfo,
  snapBranchPoint,
  type TreeMsg,
} from '../../src/threads/path';

/*
 *  m1 ─ m2 ─ m3 ─ m4 ─ m5            (main)
 *                  └─ b1 ─ b2         (branch at m3: b1 is m4's sibling)
 */
const msgs: TreeMsg[] = [
  { id: 'm1', parentId: null, role: 'user' },
  { id: 'm2', parentId: 'm1', role: 'assistant' },
  { id: 'm3', parentId: 'm2', role: 'user' },
  { id: 'm4', parentId: 'm3', role: 'assistant' },
  { id: 'm5', parentId: 'm4', role: 'user' },
  { id: 'b1', parentId: 'm3', role: 'assistant' },
  { id: 'b2', parentId: 'b1', role: 'user' },
];
const byId = new Map(msgs.map((m) => [m.id, m] as const));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('ancestorPath', () => {
  it('returns root → head and shares the prefix across branches', () => {
    expect(ids(ancestorPath(byId, 'm5'))).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(ids(ancestorPath(byId, 'b2'))).toEqual(['m1', 'm2', 'm3', 'b1', 'b2']);
  });

  it('refuses broken trees', () => {
    const cyc = new Map<string, TreeMsg>([
      ['a', { id: 'a', parentId: 'b' }],
      ['b', { id: 'b', parentId: 'a' }],
    ]);
    expect(() => ancestorPath(cyc, 'a')).toThrow(BrokenTreeError);
    expect(() => ancestorPath(byId, 'nope')).toThrow(/missing/);
  });
});

describe('applyCompaction', () => {
  const comps = [
    { id: 's2', uptoMessageId: 'm2', tokens: 50 },
    { id: 's3', uptoMessageId: 'm3', tokens: 80 },
    { id: 'sx', uptoMessageId: 'm4', tokens: 90 },
  ];

  it('uses the longest summary on the path, reused by every branch through it', () => {
    const main = applyCompaction(ancestorPath(byId, 'm5'), comps, { keepRecent: 1 });
    expect(main.summary?.id).toBe('sx');
    expect(ids(main.messages)).toEqual(['m5']);

    const branch = applyCompaction(ancestorPath(byId, 'b2'), comps, { keepRecent: 1 });
    expect(branch.summary?.id).toBe('s3'); // m4 is not on this path
    expect(ids(branch.messages)).toEqual(['b1', 'b2']);
  });

  it('always keeps the recent turns verbatim', () => {
    const r = applyCompaction(ancestorPath(byId, 'm5'), comps, { keepRecent: 3 });
    expect(r.summary?.id).toBe('s2');
    expect(ids(r.messages)).toEqual(['m3', 'm4', 'm5']);
  });

  it('leaves the path alone when nothing applies', () => {
    expect(applyCompaction(ancestorPath(byId, 'm5'), [], { keepRecent: 2 }).summary).toBeNull();
  });
});

describe('tree helpers', () => {
  const kids = childrenIndex(msgs);

  it('knows siblings', () => {
    expect(siblingInfo(kids, byId.get('b1') as TreeMsg)).toEqual({ index: 1, count: 2, ids: ['m4', 'b1'] });
  });

  it('finds the common ancestor and the divergent tails', () => {
    const { lca, aRest, bRest } = lowestCommonAncestor(ancestorPath(byId, 'm5'), ancestorPath(byId, 'b2'));
    expect(lca?.id).toBe('m3');
    expect(ids(aRest)).toEqual(['m4', 'm5']);
    expect(ids(bRest)).toEqual(['b1', 'b2']);
  });

  it('defaults to the newest leaf below a branch point', () => {
    expect(defaultLeaf(kids, 'm3')).toBe('b2');
  });

  it('collapses linear runs for the tree view', () => {
    const nodes = collapseLinear(msgs);
    // m1 root (m2 folded), m3 fork, m4 and b1 first-after-fork, m5 and b2 leaves
    expect(nodes.map((n) => [n.id, n.parentId, n.collapsed])).toEqual([
      ['m1', null, 1],
      ['m3', 'm1', 0],
      ['m4', 'm3', 0],
      ['m5', 'm4', 0],
      ['b1', 'm3', 0],
      ['b2', 'b1', 0],
    ]);
  });

  it('snaps a branch point inside a tool call to its result', () => {
    const tool: TreeMsg[] = [
      { id: 'u', parentId: null, role: 'user' },
      { id: 'call', parentId: 'u', role: 'assistant', hasToolCall: true },
      { id: 'res', parentId: 'call', role: 'tool' },
    ];
    const k = childrenIndex(tool);
    expect(snapBranchPoint(k, tool[1] as TreeMsg)).toBe('res');
    expect(snapBranchPoint(k, tool[0] as TreeMsg)).toBe('u');
  });
});
