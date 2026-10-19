/**
 * ------------------------------------------------------------------
 *  Title    |  Attached files: what Pro adds
 *  Ref      |  ROADMAP.md CH6 (Pro half) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Under the chips of the files going with a message, one
 *           |  quiet line says what Pro adds where it is not on: what
 *           |  each file costs in tokens, and only the relevant pages
 *           |  when a message is too long for the model.
 *  How      |  Nothing here estimates or trims. With Pro on, Core puts
 *           |  `tokens` on each chip (thread/attach.ts shows it) and
 *           |  trims at send time; this line then draws nothing.
 * ------------------------------------------------------------------
 */

import { Link } from '@tanstack/react-router';
import { useProFeature } from '../pro/slot';

export function AttachPro() {
  const { unlocked, loading, build } = useProFeature('attachment_pages');
  if (loading || unlocked) return null;
  return (
    <li className="file-chip__pro mute gilt-frame gilt-frame--quiet">
      Pro shows what each file costs in tokens, and keeps only the relevant pages when a message is too long
      for the model.{' '}
      <Link to="/admin/$section" params={{ section: 'license' }} className="link-btn">
        {build === 'pro' ? 'Turn on Pro' : 'About Pro'}
      </Link>
    </li>
  );
}
