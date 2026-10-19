/**
 * ------------------------------------------------------------------
 *  Title    |  Graph layout off the main thread
 *  Ref      |  ROADMAP P4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Laying out a flow or a branch tree with ELK is seconds
 *           |  of unbroken work on a big graph; run on the page it
 *           |  freezes typing, scrolling and every animation until it
 *           |  is done. Here it runs in a Web Worker and the page
 *           |  stays alive.
 *  How      |  elk-api drives elk-worker.min.js as a classic worker
 *           |  loaded by URL (the app's own origin, so the policy's
 *           |  worker-src 'self' covers it; nothing is inlined as a
 *           |  blob). If the worker cannot start or dies (a policy that
 *           |  forbids workers, an old webview), layout falls back to
 *           |  ELK on the main thread, loaded only then, and keeps
 *           |  using it: slower to respond, never wrong.
 *  Note     |  Same options in, same positions out on both paths.
 * ------------------------------------------------------------------
 */

import type { ElkNode } from 'elkjs/lib/elk-api';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';

export type Layout = (graph: ElkNode) => Promise<ElkNode>;

/** The error name of a worker that stopped, as opposed to a graph ELK could not lay out. */
export const WORKER_ERROR = 'LayoutWorkerError';

/** ELK in a Web Worker. Rejects if the worker cannot start, or later dies. */
export async function inWorker(): Promise<Layout> {
  if (typeof Worker === 'undefined') throw new Error('Web Workers are not available');
  const { default: ELK } = await import('elkjs/lib/elk-api.js');
  let broke: (e: Error) => void = () => {};
  const stopped = (why: string) => Object.assign(new Error(why), { name: WORKER_ERROR });
  const dead = new Promise<never>((_, reject) => {
    broke = reject;
  });
  // Nothing is listening for `dead` until a layout is running; a worker that dies idle must not
  // become an unhandled rejection.
  dead.catch(() => {});
  const elk = new ELK({
    workerFactory: (url) => {
      const w = new Worker(url ?? workerUrl);
      w.addEventListener('error', (e) => broke(stopped(e.message || 'The layout worker stopped')));
      w.addEventListener('messageerror', () => broke(stopped('The layout worker sent something unreadable')));
      return w;
    },
    workerUrl,
  });
  return (graph) => Promise.race([elk.layout(graph), dead]);
}

/** ELK on the page: how it ran before, and what runs when workers are not available. */
export async function onMainThread(): Promise<Layout> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return (graph) => elk.layout(graph);
}

let engine: Promise<{ layout: Layout; worker: boolean }> | null = null;

function start() {
  return inWorker()
    .then((layout) => ({ layout, worker: true }))
    .catch(() => onMainThread().then((layout) => ({ layout, worker: false })));
}

/** Forget the chosen engine (tests). */
export function resetLayoutEngine(): void {
  engine = null;
}

/** Lay a graph out. Prefers the worker; one that dies is replaced by the main thread, for this layout and after. */
export async function layoutGraph(graph: ElkNode): Promise<ElkNode> {
  engine ??= start();
  const chosen = await engine;
  try {
    return await chosen.layout(graph);
  } catch (error) {
    // A graph ELK rejects would be rejected again on the main thread: only a dead worker falls back.
    if (!chosen.worker || (error as Error)?.name !== WORKER_ERROR) throw error;
    engine = onMainThread().then((layout) => ({ layout, worker: false }));
    return (await engine).layout(graph);
  }
}
