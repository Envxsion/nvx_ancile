/**
 * ------------------------------------------------------------------
 *  Title    |  Export: Word, PDF and branch comparison (Pro seam)
 *  Ref      |  ROADMAP.md EX3 (Pro half) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Below the free formats in the export dialog: with Pro
 *           |  and the licence, Pro's tools (parts.ExportTools) make a
 *           |  Word or PDF file with an evidence appendix, or compare
 *           |  two branches; without them, one quiet line says what
 *           |  unlocks it.
 *  How      |  Hands Pro the thread, the message the branch ends at,
 *           |  and the dialog's checkboxes. Core builds the file.
 *  Note     |  Nothing here builds or saves a file.
 * ------------------------------------------------------------------
 */

import { Link } from '@tanstack/react-router';
import { useProFeature } from '../pro/slot';

export function ExportPro({
  threadId,
  title,
  headId,
  options,
  onDone,
}: {
  threadId: string;
  title: string;
  headId: string | null;
  options: { sources: boolean; steps: boolean; thinking: boolean; receipts: boolean };
  onDone: () => void;
}) {
  const { ui, unlocked, loading, build } = useProFeature('export_docs');
  if (loading) return null;
  const Tools = ui?.parts?.ExportTools;
  if (Tools && unlocked)
    return <Tools threadId={threadId} title={title} headId={headId} options={options} onDone={onDone} />;
  return (
    <p className="mute export__pro gilt-frame gilt-frame--quiet">
      Word and PDF files with an evidence appendix, and a comparison of two branches side by side: part of NVX
      Ancile Pro.{' '}
      <Link to="/admin/$section" params={{ section: 'license' }} className="link-btn">
        {build === 'pro' ? 'Turn on Pro' : 'About Pro'}
      </Link>
    </p>
  );
}
