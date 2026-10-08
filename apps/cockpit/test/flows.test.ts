/**
 * The flow editor's graph operations: every edit is a pure step that undo
 * can reverse, paste never collides with existing ids, collapsing a team
 * into a subflow keeps its wiring, layout is deterministic, and the local
 * checks catch what they claim to.
 */
import type { FlowGraph } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  addNode,
  align,
  collapseToSubflow,
  connect,
  copy,
  diff,
  distribute,
  emptyGraph,
  group,
  type History,
  paste,
  record,
  redo,
  removeNodes,
  renameNode,
  undo,
  ungroup,
} from '../src/flows/graph';
import { newNode, outputPorts } from '../src/flows/kinds';
import { autoLayout } from '../src/flows/layout';
import { localLint } from '../src/flows/lint';
import { LOCAL_TEMPLATES } from '../src/flows/templates';

function chain(): FlowGraph {
  let g = emptyGraph();
  g = addNode(g, newNode('input', 'input', { x: 0, y: 0 }));
  g = addNode(g, newNode('router', 'router_1', { x: 300, y: 0 }));
  g = addNode(g, newNode('model', 'model_1', { x: 600, y: -100 }));
  g = addNode(g, newNode('model', 'model_2', { x: 600, y: 100 }));
  g = addNode(g, newNode('output', 'output', { x: 900, y: 0 }));
  g = connect(g, 'input', 'router_1');
  g = connect(g, 'router_1', 'model_1', 'code');
  g = connect(g, 'router_1', 'model_2', 'writing');
  g = connect(g, 'model_1', 'output');
  g = connect(g, 'model_2', 'output');
  return g;
}

describe('flow graph edits', () => {
  it('undo and redo step through edits one at a time', () => {
    let h: History = { past: [], future: [] };
    const a = chain();
    h = record(h, a);
    const b = removeNodes(a, ['model_2']);
    const back = undo(h, b);
    expect(back?.graph).toBe(a);
    const fwd = redo(back?.history as History, a);
    expect(fwd?.graph).toBe(b);
    expect(undo({ past: [], future: [] }, a)).toBeNull();
  });

  it('removing a node removes its edges', () => {
    const g = removeNodes(chain(), ['router_1']);
    expect(g.edges.some((e) => e.from === 'router_1' || e.to === 'router_1')).toBe(false);
    expect(g.edges).toHaveLength(2);
  });

  it('never connects a node to itself, into the input, or twice', () => {
    const g = chain();
    expect(connect(g, 'model_1', 'model_1')).toBe(g);
    expect(connect(g, 'model_1', 'input')).toBe(g);
    expect(connect(g, 'model_1', 'output')).toBe(g);
    expect(connect(g, 'output', 'model_1')).toBe(g);
  });

  it('pastes with fresh ids and keeps the edges between copied nodes', () => {
    const g = chain();
    const clip = copy(g, ['router_1', 'model_1']);
    expect(clip.edges).toHaveLength(1);
    const r = paste(g, clip);
    expect(r.ids).toHaveLength(2);
    expect(new Set(r.graph.nodes.map((n) => n.id)).size).toBe(r.graph.nodes.length);
    const pasted = r.graph.edges.filter((e) => r.ids.includes(e.from) && r.ids.includes(e.to));
    expect(pasted).toHaveLength(1);
    expect(pasted[0]?.label).toBe('code');
  });

  it('renames a node everywhere it is referenced', () => {
    const g = renameNode(chain(), 'router_1', 'jev');
    expect(g.nodes.some((n) => n.id === 'jev')).toBe(true);
    expect(g.edges.filter((e) => e.from === 'jev')).toHaveLength(2);
    expect(renameNode(g, 'jev', 'model_1')).toBe(g); // taken: no change
  });

  it('groups and ungroups, keeping members', () => {
    const r = group(chain(), ['model_1', 'model_2'], 'Specialists');
    expect(r.id).toBe('group_1');
    expect(r.graph.nodes.filter((n) => n.parent === 'group_1')).toHaveLength(2);
    const back = ungroup(r.graph, 'group_1');
    expect(back.nodes.some((n) => n.kind === 'group')).toBe(false);
    expect(back.nodes.every((n) => !n.parent)).toBe(true);
  });

  it('aligns and distributes', () => {
    const g = align(chain(), ['model_1', 'model_2'], 'top');
    const ys = g.nodes.filter((n) => n.id.startsWith('model')).map((n) => n.position.y);
    expect(new Set(ys).size).toBe(1);
    const d = distribute(chain(), ['input', 'router_1', 'output'], 'h');
    expect(d.nodes.find((n) => n.id === 'router_1')?.position.x).toBe(450);
  });

  it('collapses a selection into a subflow and keeps the wiring', () => {
    const r = collapseToSubflow(chain(), ['router_1', 'model_1', 'model_2'], 'flw_block');
    expect(r).not.toBeNull();
    if (!r) return;
    const sub = r.outer.nodes.find((n) => n.id === r.nodeId);
    expect(sub?.kind).toBe('subflow');
    expect(r.outer.nodes.map((n) => n.id).sort()).toEqual(['input', 'output', r.nodeId].sort());
    expect(r.outer.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(
      [`input>${r.nodeId}`, `${r.nodeId}>output`].sort(),
    );
    // Inside: its own input and output, routes intact.
    expect(r.inner.nodes.some((n) => n.kind === 'input')).toBe(true);
    expect(r.inner.nodes.some((n) => n.kind === 'output')).toBe(true);
    expect(
      r.inner.edges
        .filter((e) => e.from === 'router_1')
        .map((e) => e.label)
        .sort(),
    ).toEqual(['code', 'writing']);
    expect(r.inner.edges.some((e) => e.from === 'input' && e.to === 'router_1')).toBe(true);
  });

  it('diffs two versions, ignoring moves', () => {
    const a = chain();
    const moved = {
      ...a,
      nodes: a.nodes.map((n) => ({ ...n, position: { x: n.position.x + 5, y: n.position.y } })),
    };
    expect(diff(a, moved)).toEqual({ added: [], removed: [], changed: [], edgesAdded: [], edgesRemoved: [] });
    let b = removeNodes(a, ['model_2']);
    b = addNode(b, newNode('join', 'join_1', { x: 0, y: 0 }));
    b = {
      ...b,
      nodes: b.nodes.map((n) => (n.id === 'model_1' ? ({ ...n, label: 'Coder' } as typeof n) : n)),
    };
    const d = diff(a, b);
    expect(d.added).toEqual(['join_1']);
    expect(d.removed).toEqual(['model_2']);
    expect(d.changed).toEqual(['model_1']);
  });

  it('gives routers one port per route, managers a workers and an answer port', () => {
    const g = chain();
    expect(outputPorts(g.nodes.find((n) => n.id === 'router_1') as never)).toEqual(['code', 'writing']);
    expect(outputPorts(newNode('manager', 'm', { x: 0, y: 0 }))).toEqual(['workers', 'answer']);
    expect(outputPorts(newNode('output', 'o', { x: 0, y: 0 }))).toEqual([]);
  });
});

describe('auto-layout', () => {
  it('lays the same graph out the same way, left to right', async () => {
    const a = await autoLayout(chain());
    const b = await autoLayout(chain());
    expect(a.nodes.map((n) => n.position)).toEqual(b.nodes.map((n) => n.position));
    const x = (id: string) => a.nodes.find((n) => n.id === id)?.position.x ?? 0;
    expect(x('input')).toBeLessThan(x('router_1'));
    expect(x('router_1')).toBeLessThan(x('model_1'));
    expect(x('model_1')).toBeLessThan(x('output'));
  });
});

describe('local checks', () => {
  it('passes a well-formed flow', () => {
    const v = localLint(chain(), new Map());
    expect(v.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('flags a missing answer, unreachable nodes and routes that go nowhere', () => {
    let g = removeNodes(chain(), ['output']);
    g = addNode(g, newNode('model', 'stray', { x: 0, y: 500 }));
    g = { ...g, edges: g.edges.filter((e) => e.label !== 'writing') };
    const codes = localLint(g, new Map()).issues.map((i) => i.code);
    expect(codes).toContain('flow.no_output');
    expect(codes).toContain('flow.unreachable');
    expect(codes).toContain('flow.route_unused');
  });

  it('refuses an unbounded cycle but allows one through a loop node', () => {
    let g = connect(chain(), 'model_1', 'router_1');
    expect(localLint(g, new Map()).issues.some((i) => i.code === 'flow.cycle')).toBe(true);
    g = addNode(chain(), newNode('loop', 'loop_1', { x: 0, y: 0 }));
    g = connect(g, 'model_1', 'loop_1');
    g = connect(g, 'loop_1', 'model_1', 'body');
    expect(localLint(g, new Map()).issues.some((i) => i.code === 'flow.cycle')).toBe(false);
  });

  it('every starter template is clean', () => {
    for (const t of LOCAL_TEMPLATES) {
      const errors = localLint(t.graph, new Map()).issues.filter((i) => i.level === 'error');
      expect({ t: t.id, errors }).toEqual({ t: t.id, errors: [] });
    }
  });
});
