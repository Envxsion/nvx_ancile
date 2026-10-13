/**
 * ------------------------------------------------------------------
 *  Title    |  Safe link
 *  Ref      |  lib/links.ts · apps/desktop/src-tauri/src/links.rs
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every link drawn from markdown (answers, notes, the
 *           |  guide, files): NVX Ancile pages in the app, web and
 *           |  mail links outside it, anything else as plain text.
 *  How      |  classifyLink() decides; internal links navigate with
 *           |  the router; external ones open a new tab, which the
 *           |  desktop shell hands to the system browser.
 * ------------------------------------------------------------------
 */

import { useRouter } from '@tanstack/react-router';
import type { ComponentProps } from 'react';
import { classifyLink } from '../lib/links';

/**
 * A link in an answer. NVX Ancile pages open in the app, web and mail links
 * open outside it (the desktop shell sends them to the system browser), and
 * any other scheme is plain text that says why it did not open.
 */
export function SafeLink({ href, children, ...rest }: ComponentProps<'a'>) {
  const router = useRouter({ warn: false });
  const link = classifyLink(href, location.origin);
  if (link.kind === 'refused')
    return (
      <span className="md-link-refused" title="This link was not opened: only web and email links open.">
        {children}
      </span>
    );
  if (link.kind === 'anchor')
    return (
      <a {...rest} href={link.href}>
        {children}
      </a>
    );
  if (link.kind === 'internal')
    return (
      <a
        {...rest}
        href={link.to}
        onClick={(e) => {
          if (
            !router ||
            e.defaultPrevented ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
          )
            return;
          e.preventDefault();
          void router.navigate({ href: link.to });
        }}
      >
        {children}
      </a>
    );
  return (
    <a {...rest} href={link.href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** For a Streamdown that only needs its links made safe. */
export const LINK_COMPONENTS = { a: SafeLink };
