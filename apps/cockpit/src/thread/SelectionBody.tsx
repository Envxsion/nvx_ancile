/**
 * ------------------------------------------------------------------
 *  Title    |  A checked highlight, as it reads
 *  Ref      |  roadmap FC3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The content of one checked highlight: the verdict, the
 *           |  claim, the corrected claim, three to five evidence
 *           |  lines each with its source, and one closing line. Used
 *           |  by the card beside the highlight and by the Evidence tab.
 *  How      |  The verdict carries an icon and a word as well as a
 *           |  semantic colour (green, amber, red, grey), never signal
 *           |  violet. Evidence is labelled Source, Web, Sandbox run or
 *           |  Model knowledge; a web page opens in a new tab, a
 *           |  source opens in the viewer.
 * ------------------------------------------------------------------
 */

import type { SelectionCheck, SelectionEvidence } from '@nvx/contracts';
import { ORIGIN_WORDS, VERDICT_WORDS } from '../lib/selectionWords';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';

export function VerdictChip({ verdict }: { verdict: SelectionCheck['verdict'] }) {
  const v = VERDICT_WORDS[verdict];
  return (
    <span className="selverdict" data-verdict={verdict}>
      <Icon name={v.icon} size={13} />
      {v.label}
    </span>
  );
}

const STANCE: Record<SelectionEvidence['stance'], string> = {
  supports: 'Supports the claim.',
  contradicts: 'Contradicts the claim.',
  neutral: 'Related.',
};

function EvidenceLine({ e }: { e: SelectionEvidence }) {
  const openViewer = useUi((s) => s.openViewer);
  return (
    <li className="selev" data-stance={e.stance} data-origin={e.origin}>
      <span className="sr-only">{STANCE[e.stance]} </span>
      <span className="selev__text">{e.text}</span>
      <span className="selev__meta">
        <span className="selev__origin" data-origin={e.origin}>
          {ORIGIN_WORDS[e.origin]}
        </span>
        {e.url ? (
          <a className="selev__source" href={e.url} target="_blank" rel="noreferrer noopener" title={e.url}>
            {e.source}
          </a>
        ) : e.source_id ? (
          <button
            type="button"
            className="selev__source link-btn link-btn--quiet"
            onClick={() => openViewer({ sourceId: e.source_id as string })}
          >
            {e.source}
          </button>
        ) : (
          <span className="selev__source">{e.source}</span>
        )}
      </span>
    </li>
  );
}

export function SelectionBody({ c, compact = false }: { c: SelectionCheck; compact?: boolean }) {
  return (
    <div className="selbody" data-compact={compact || undefined}>
      <div className="selbody__head">
        <VerdictChip verdict={c.verdict} />
        <p className="selbody__headline">{c.headline}</p>
      </div>
      <blockquote className="selbody__claim">{c.text}</blockquote>
      {c.corrected ? (
        <div className="selbody__corrected">
          <span className="selbody__label">Corrected claim</span>
          <p>{c.corrected}</p>
        </div>
      ) : null}
      {c.evidence.length ? (
        <ul className="selbody__evidence">
          {c.evidence.map((e) => (
            <EvidenceLine key={`${e.origin}-${e.source}-${e.text}`} e={e} />
          ))}
        </ul>
      ) : null}
      {c.closing ? (
        <p className="selbody__closing">
          <span className="selbody__label">What changes</span> {c.closing}
        </p>
      ) : null}
      {c.ran ? (
        <p className="selbody__note" data-ran={c.ran.ran || undefined}>
          <Icon name="terminal" size={12} />
          {c.ran.ran
            ? `Ran in the sandbox${c.ran.ok ? '' : ' and raised an error'}: ${c.ran.output || 'nothing printed'}`
            : c.ran.output}
        </p>
      ) : null}
      {c.web.note ? (
        <p className="selbody__note">
          <Icon name="globe" size={12} />
          {c.web.note}
        </p>
      ) : null}
    </div>
  );
}
