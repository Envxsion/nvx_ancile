/**
 * ------------------------------------------------------------------
 *  Title    |  Layout in a worker, with a fallback
 *  Ref      |  ROADMAP P4
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Flow and branch-tree layout run in a Web Worker and give
 *           |  the answer the main-thread engine gives. Where a worker
 *           |  cannot start (no Worker, a policy that forbids it) or
 *           |  dies, layout still happens, on the main thread. A
 *           |  500-node flow lays out on both paths.
 *  How      |  A stand-in Worker speaks ELK's message protocol, backed
 *           |  by the real engine, so what is checked is that the
 *           |  layout was handed over and what came back.
 * ------------------------------------------------------------------
 */

import type { FlowGraph, FlowNode } from '@nvx/contracts';
import ELK from 'elkjs/lib/elk.bundled.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoLayout } from '../src/flows/layout';
import { layoutGraph, onMainThread, resetLayoutEngine, WORKER_ERROR } from '../src/lib/elk';

const engine = new ELK();

/** What a stand-in worker saw. */
const seen = { created: 0, layouts: 0 };

/** A Worker that answers ELK's protocol with the real engine, on the same thread. */
class StandInWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  private listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(readonly url?: string | URL) {
    seen.created++;
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  emit(type: string, e: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(e);
  }
  terminate() {}
  postMessage(msg: { id: number; cmd: string; graph?: never; layoutOptions?: never }) {
    const reply = (data: unknown) => queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, data } }));
    if (msg.cmd !== 'layout') return reply({});
    seen.layouts++;
    void engine.layout(msg.graph as never, { layoutOptions: msg.layoutOptions }).then(reply, (e: Error) =>
      // As the real worker does: the error travels back in the answer.
      queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, error: { message: e.message } } })),
    );
  }
}

const node = (id: string, x = 0): FlowNode =>
  ({ id, kind: 'prompt', position: { x, y: 0 }, size: { w: 220, h: 72 }, data: {} }) as unknown as FlowNode;

/** A spine with branches that rejoin: flow-shaped, n nodes. */
function flow(n: number): FlowGraph {
  const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`, i));
  const edges = [];
  for (let i = 1; i < n; i++) {
    edges.push({ id: `e${i}`, from: `n${Math.floor((i - 1) / 2)}`, to: `n${i}` });
    if (i % 7 === 0 && i > 10) edges.push({ id: `x${i}`, from: `n${i - 9}`, to: `n${i}` });
  }
  return { nodes, edges } as unknown as FlowGraph;
}

const positions = (g: FlowGraph) => g.nodes.map((n) => `${n.id}:${n.position.x},${n.position.y}`).join(' ');

beforeEach(() => {
  resetLayoutEngine();
  seen.created = 0;
  seen.layouts = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('layout in a worker', () => {
  it('hands the graph to the worker and returns what the main-thread engine would', async () => {
    vi.stubGlobal('Worker', StandInWorker);
    const g = flow(40);
    const viaWorker = await autoLayout(g);
    expect(seen.created).toBe(1);
    expect(seen.layouts).toBe(1);

    vi.unstubAllGlobals();
    resetLayoutEngine();
    const onPage = await autoLayout(g);
    expect(seen.layouts).toBe(1);
    expect(positions(viaWorker)).toBe(positions(onPage));
  });

  it('keeps one worker for every layout after the first', async () => {
    vi.stubGlobal('Worker', StandInWorker);
    await autoLayout(flow(12));
    await autoLayout(flow(14));
    expect(seen.created).toBe(1);
    expect(seen.layouts).toBe(2);
  });

  it('lays out a 500-node flow, in the worker and on the main thread', async () => {
    const g = flow(500);
    vi.stubGlobal('Worker', StandInWorker);
    const t0 = performance.now();
    const viaWorker = await autoLayout(g);
    const workerMs = Math.round(performance.now() - t0);
    expect(seen.layouts).toBe(1);
    expect(viaWorker.nodes).toHaveLength(500);

    vi.unstubAllGlobals();
    resetLayoutEngine();
    const t1 = performance.now();
    const onPage = await autoLayout(g);
    const pageMs = Math.round(performance.now() - t1);
    expect(positions(onPage)).toBe(positions(viaWorker));
    console.log(
      `[perf] 500-node flow in jsdom, same thread both: worker path ${workerMs} ms, page path ${pageMs} ms`,
    );
  }, 120_000);
});

describe('when a worker cannot be used', () => {
  it('falls back to the main thread where there is no Worker at all', async () => {
    vi.stubGlobal('Worker', undefined);
    const out = await autoLayout(flow(20));
    expect(out.nodes).toHaveLength(20);
    expect(seen.created).toBe(0);
  });

  it('falls back where the policy forbids workers (creating one throws)', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new DOMException('Refused to create a worker: worker-src', 'SecurityError');
        }
      },
    );
    const out = await autoLayout(flow(20));
    expect(out.nodes).toHaveLength(20);
    // And it does not try again for the next layout.
    const again = await autoLayout(flow(10));
    expect(again.nodes).toHaveLength(10);
  });

  it('falls back, for this layout and after, when the worker dies', async () => {
    let made: StandInWorker | null = null;
    vi.stubGlobal(
      'Worker',
      class extends StandInWorker {
        constructor(url?: string | URL) {
          super(url);
          made = this;
        }
        // Takes the work and never answers: the worker is gone.
        postMessage() {}
      },
    );
    const pending = autoLayout(flow(20));
    await vi.waitFor(() => expect(made).not.toBeNull());
    (made as unknown as StandInWorker).emit('error', { message: 'Script error' });
    const out = await pending;
    expect(out.nodes).toHaveLength(20);
    // The next layout goes straight to the main thread.
    const created = seen.created;
    await autoLayout(flow(8));
    expect(seen.created).toBe(created);
  });

  it('does not retry a graph ELK itself rejects, and says so', async () => {
    vi.stubGlobal('Worker', StandInWorker);
    const bad = {
      id: 'root',
      children: [{ id: 'a', width: 1, height: 1 }],
      edges: [{ id: 'e', sources: ['a'], targets: ['zzz'] }],
    };
    await expect(layoutGraph(bad)).rejects.toThrow();
    const err = await layoutGraph(bad).catch((e) => e as Error);
    expect((err as Error).name).not.toBe(WORKER_ERROR);
  });

  it('can load the main-thread engine on its own', async () => {
    const layout = await onMainThread();
    const out = await layout({ id: 'root', children: [{ id: 'a', width: 10, height: 10 }], edges: [] });
    expect(out.children?.[0]).toMatchObject({ id: 'a', x: expect.any(Number) });
  });
});
