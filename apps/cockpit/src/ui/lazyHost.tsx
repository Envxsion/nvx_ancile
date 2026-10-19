/**
 * ------------------------------------------------------------------
 *  Title    |  Hosts that load after the shell
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Overlays and panels (palette, help, approvals, the code
 *           |  and artifact panels) draw nothing until something opens
 *           |  them. Their code does not need to be in the first
 *           |  download, only here soon after.
 *  How      |  lazyHost wraps a named export in React.lazy and an empty
 *           |  Suspense, so the shell paints first and the host's chunk
 *           |  follows. Anything that waits on it renders nothing for
 *           |  that moment.
 * ------------------------------------------------------------------
 */

import { type ComponentType, lazy, type ReactNode, Suspense } from 'react';

export function lazyHost<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
  /** What stands in while the chunk loads: give it the size of the real thing so nothing jumps. */
  fallback: ReactNode = null,
): M[K] extends ComponentType<infer P> ? ComponentType<P> : never {
  const Inner = lazy(async () => ({ default: (await load())[name] as ComponentType<object> }));
  const Host = (props: object) => (
    <Suspense fallback={fallback}>
      <Inner {...props} />
    </Suspense>
  );
  return Host as never;
}

/**
 * Fetch these chunks once the page has drawn and the browser is idle, so the first click on
 * something that loads on demand (a receipt, a flow's teamwork) finds it already here.
 */
export function preloadOnIdle(...loaders: (() => Promise<unknown>)[]): void {
  const run = () => {
    for (const load of loaders) void load().catch(() => {});
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4_000 });
  else setTimeout(run, 1_500);
}
