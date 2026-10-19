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

import { type ComponentType, lazy, Suspense } from 'react';

export function lazyHost<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): M[K] extends ComponentType<infer P> ? ComponentType<P> : never {
  const Inner = lazy(async () => ({ default: (await load())[name] as ComponentType<object> }));
  const Host = (props: object) => (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
  return Host as never;
}
