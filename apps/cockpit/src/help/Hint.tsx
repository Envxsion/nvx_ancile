/**
 * ------------------------------------------------------------------
 *  Title    |  Hint
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A small "?" beside anything that needs a sentence of
 *           |  explanation: what it does, and the article that says
 *           |  more. It pulses three times the first time you meet it,
 *           |  then sits still.
 *  How      |  Radix Popover. Seen hints are remembered (help store);
 *           |  Settings → Advanced → Hints hides them all.
 * ------------------------------------------------------------------
 */

import * as Popover from '@radix-ui/react-popover';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { useHelp } from './store';

export function Hint({
  id,
  title,
  children,
  article,
}: {
  id: string;
  title: string;
  children: string;
  article?: string;
}) {
  const enabled = usePrefs((s) => s.prefs.advanced.hints);
  const seen = useHelp((s) => s.hintsSeen.includes(id));
  const see = useHelp((s) => s.seeHint);
  const setHelp = useUi((s) => s.setHelp);
  if (!enabled) return null;
  return (
    <Popover.Root onOpenChange={(o) => o && see(id)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="hint-btn"
          data-new={!seen || undefined}
          aria-label={`About ${title}`}
        >
          ?
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="hint-pop" side="top" sideOffset={8} collisionPadding={12}>
          <p className="hint-pop__title">{title}</p>
          <p className="hint-pop__body">{children}</p>
          {article ? (
            <Popover.Close asChild>
              <button type="button" className="link-btn" onClick={() => setHelp(true, article)}>
                Read more in the guide
              </button>
            </Popover.Close>
          ) : null}
          <Popover.Arrow className="hint-pop__arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
