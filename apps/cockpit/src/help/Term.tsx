/**
 * ------------------------------------------------------------------
 *  Title    |  Term
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A word with a quiet dotted underline that says what it
 *           |  means when you hover or focus it, so jargon explains
 *           |  itself where it appears instead of in a manual.
 *  How      |  Radix Popover opened on hover (with a short delay) and
 *           |  on click or Enter. The text comes from the glossary.
 *           |  Settings → Advanced → Hints turns these into plain
 *           |  words, like the "?" hints.
 * ------------------------------------------------------------------
 */

import * as Popover from '@radix-ui/react-popover';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { track } from '../lib/telemetry';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import '../styles/learn.css';
import { glossaryEntry } from './glossary';

export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const enabled = usePrefs((s) => s.prefs.advanced.hints);
  const setHelp = useUi((s) => s.setHelp);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const entry = glossaryEntry(id);
  useEffect(() => {
    if (open) track('glossary_open');
  }, [open]);
  const label = children ?? entry?.term ?? id;
  if (!entry || !enabled) return <>{label}</>;

  const hover = (next: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), next ? 350 : 150);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <span
          role="button"
          tabIndex={0}
          className="term"
          onMouseEnter={() => hover(true)}
          onMouseLeave={() => hover(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((o) => !o);
            }
          }}
        >
          {label}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="hint-pop term-pop"
          side="top"
          sideOffset={6}
          collisionPadding={12}
          onMouseEnter={() => hover(true)}
          onMouseLeave={() => hover(false)}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <p className="hint-pop__title">{entry.term}</p>
          <p className="hint-pop__body">{entry.plain}</p>
          {entry.article ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setOpen(false);
                setHelp(true, entry.article);
              }}
            >
              Read more in the guide
            </button>
          ) : null}
          <Popover.Arrow className="hint-pop__arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
