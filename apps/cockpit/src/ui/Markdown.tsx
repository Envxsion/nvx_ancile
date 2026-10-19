/**
 * ------------------------------------------------------------------
 *  Title    |  Markdown, loaded on demand
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Streamdown and the parser behind it are about half of what
 *           |  the first download used to carry. This wrapper keeps them
 *           |  out of the entry: the text shows as plain text for the
 *           |  moment the chunk takes, then as markdown.
 *  How      |  The chunk (MarkdownImpl) is requested as soon as the app
 *           |  has drawn (main.tsx) and by the first Markdown that
 *           |  mounts. Once it is in, Markdown renders in the same pass,
 *           |  with no flash. `plugins` picks the remark and rehype
 *           |  steps (thread/mdPlugins.ts) without importing them here.
 *  Note     |  Tests await loadMarkdown() in test/setup.ts.
 * ------------------------------------------------------------------
 */

import { type ComponentProps, useEffect, useSyncExternalStore } from 'react';
import type { Streamdown as StreamdownType } from 'streamdown';

export type MarkdownProps = Omit<
  ComponentProps<typeof StreamdownType>,
  'remarkPlugins' | 'rehypePlugins' | 'urlTransform'
> & {
  /** 'default': Streamdown's own. 'remark': the plugins every rendered document gets. 'thread': also the answer's sanitiser and URL rules. */
  plugins?: 'default' | 'remark' | 'thread';
};

type Impl = typeof import('./MarkdownImpl');

let impl: Impl | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Request the markdown chunk (once). Resolves when it is in. */
export function loadMarkdown(): Promise<void> {
  pending ??= import('./MarkdownImpl').then((m) => {
    impl = m;
    for (const l of listeners) l();
  });
  return pending;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function Markdown(props: MarkdownProps) {
  const ready = useSyncExternalStore(
    subscribe,
    () => impl,
    () => impl,
  );
  useEffect(() => {
    void loadMarkdown();
  }, []);
  if (!ready) {
    const { children, className } = props;
    return (
      <div className={className} data-md-pending="">
        <p style={{ whiteSpace: 'pre-wrap' }}>{typeof children === 'string' ? children : null}</p>
      </div>
    );
  }
  return <ready.Rendered {...props} />;
}
