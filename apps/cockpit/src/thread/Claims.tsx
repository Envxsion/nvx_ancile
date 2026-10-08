/**
 * ------------------------------------------------------------------
 *  Title    |  Claims and citations, inline
 *  Ref      |  DESIGN.md §10.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Fact-check verdicts drawn under the words they judge,
 *           |  and citation markers that open the exact source span.
 *  How      |  Verified: faint dotted ok line. Unverified: dotted mute
 *           |  line. Contradicted: wavy fail line. Each also carries a
 *           |  tiny glyph and an accessible name, so colour is never
 *           |  the only signal (DESIGN.md §10, §13.4).
 *           |  Live claims are marked into the markdown before it is
 *           |  rendered: their spans become links to #claim-<id>, and
 *           |  the link component (Citations.tsx) draws them here,
 *           |  with the evidence a hover away.
 *  Note     |  A span is only underlined when it can be marked safely:
 *           |  inside one paragraph, outside code, not across another
 *           |  link. The rest are still listed in the Evidence panel.
 * ------------------------------------------------------------------
 */

import type { ClaimEvidence, ClaimVerdict, FactcheckClaim } from '@nvx/contracts';
import * as HoverCard from '@radix-ui/react-hover-card';
import { createContext, type ReactNode, useContext } from 'react';
import { percent } from '../lib/format';
import type { CitationView } from '../lib/types';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';

const VERDICT = {
  verified: { label: 'Verified', icon: 'check', describe: 'Supported by your sources' },
  unverified: { label: 'Unverified', icon: 'question', describe: 'Not enough evidence either way' },
  contradicted: { label: 'Contradicted', icon: 'alert', describe: 'Your sources say otherwise' },
  not_checkable: { label: 'Not checkable', icon: 'quote', describe: 'An opinion, advice or a prediction' },
} as const;

export function VerdictMark({ verdict }: { verdict: ClaimVerdict }) {
  const v = VERDICT[verdict];
  return (
    <span className="verdict" data-verdict={verdict}>
      <Icon name={v.icon} size={12} />
      {v.label}
    </span>
  );
}

/**
 * A span, not a <button>: buttons lay out as atomic inline boxes and cannot
 * wrap, so a long claim would jump onto its own line. The span keeps button
 * semantics (role, focus, Enter/Space) and its own words stay readable to
 * screen readers, with the verdict appended rather than replacing the text.
 */
export function Claim({
  id,
  verdict,
  children,
  messageId,
}: {
  id: string;
  verdict: ClaimVerdict;
  children: ReactNode;
  messageId?: string;
}) {
  const focusClaim = useUi((s) => s.focusClaim);
  const v = VERDICT[verdict];
  return (
    <span
      role="button"
      tabIndex={0}
      className="claim"
      data-verdict={verdict}
      onClick={() => focusClaim(id, messageId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          focusClaim(id, messageId);
        }
      }}
    >
      {children}
      <sup className="claim__glyph" aria-hidden="true">
        <Icon name={v.icon} size={9} />
      </sup>
      <span className="sr-only">{` (${v.label}: ${v.describe}. Show evidence.)`}</span>
    </span>
  );
}

export function Cite({ marker, citation }: { marker: number; citation: CitationView | undefined }) {
  const openDrawer = useUi((s) => s.openDrawer);
  return (
    <button
      type="button"
      className="cite"
      onClick={() => openDrawer('sources')}
      aria-label={citation ? `Source ${marker}: ${citation.title}, ${citation.location}` : `Source ${marker}`}
      title={citation ? `${citation.title} · ${citation.location}\n“${citation.quote}”` : undefined}
    >
      <span data-num>{marker}</span>
    </button>
  );
}

/* ---- Live claims ---------------------------------------------------------- */

interface ClaimsValue {
  messageId: string | null;
  claims: Map<string, FactcheckClaim>;
}

const ClaimsContext = createContext<ClaimsValue>({ messageId: null, claims: new Map() });

export function ClaimsProvider({
  messageId,
  claims,
  children,
}: {
  messageId: string;
  claims: FactcheckClaim[] | undefined;
  children: ReactNode;
}) {
  const map = new Map((claims ?? []).map((c) => [c.id, c] as const));
  return <ClaimsContext.Provider value={{ messageId, claims: map }}>{children}</ClaimsContext.Provider>;
}

/** Code fences and inline code: claims never reach inside them. */
function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g))
    out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * Wrap each claim that falls inside this text part as [span](#claim-id).
 * `base` is where the part starts in the answer's text (its text parts joined).
 */
export function markClaims(text: string, base: number, claims: FactcheckClaim[] | undefined): string {
  if (!claims?.length) return text;
  const code = codeRanges(text);
  const marks = claims
    .filter((c) => c.verdict !== 'not_checkable')
    .map((c) => ({ id: c.id, s: c.char_start - base, e: c.char_end - base }))
    .filter(({ s, e }) => s >= 0 && e <= text.length && e > s)
    .filter(({ s, e }) => !/[[\]\n`]/.test(text.slice(s, e)))
    .filter(({ s, e }) => !code.some(([a, b]) => s < b && a < e))
    .sort((a, b) => a.s - b.s);
  let out = '';
  let at = 0;
  for (const m of marks) {
    if (m.s < at) continue;
    out += `${text.slice(at, m.s)}[${text.slice(m.s, m.e)}](#claim-${m.id})`;
    at = m.e;
  }
  return out + text.slice(at);
}

const stem = (w: string) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '');

/** The quote with the words it shares with the claim lifted out. */
export function Highlighted({ quote, claim }: { quote: string; claim: string }) {
  const want = new Set((claim.match(/[A-Za-z]{4,}|\d+(?:[.,]\d+)*/g) ?? []).map(stem));
  const parts = quote.split(/([A-Za-z]{4,}|\d+(?:[.,]\d+)*)/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 && want.has(stem(p)) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional words in a fixed quote
          <mark key={i} className="ev-mark">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

function EvidenceQuote({ e, claim }: { e: ClaimEvidence; claim: string }) {
  const openViewer = useUi((s) => s.openViewer);
  const canOpen = e.source_id && e.char_start != null && e.char_end != null;
  return (
    <li className="ev-quote" data-stance={e.stance}>
      <span className="ev-quote__stance">
        {e.stance === 'supports'
          ? 'Your source says'
          : e.stance === 'contradicts'
            ? 'Your source says otherwise'
            : 'Related'}
      </span>
      <blockquote>
        <Highlighted quote={e.quote} claim={claim} />
      </blockquote>
      <span className="ev-quote__foot">
        <cite>
          {e.source_title}
          {e.page != null ? `, p. ${e.page}` : ''}
        </cite>
        {canOpen ? (
          <button
            type="button"
            className="link-btn"
            onClick={() =>
              openViewer({
                sourceId: e.source_id as string,
                start: e.char_start as number,
                end: e.char_end as number,
              })
            }
          >
            Open in the source
          </button>
        ) : null}
      </span>
    </li>
  );
}

/** Evidence for one claim: both sides when it is contradicted. */
export function EvidenceList({ claim, limit }: { claim: FactcheckClaim; limit?: number }) {
  const shown = claim.evidence.filter((e) => e.stance !== 'neutral');
  const list = (shown.length ? shown : claim.evidence).slice(0, limit ?? 6);
  // Contradictions first: they are the reason to look.
  list.sort((a, b) => Number(b.stance === 'contradicts') - Number(a.stance === 'contradicts'));
  if (!list.length) return <p className="ev-none">Nothing in your sources mentions this.</p>;
  return (
    <ul className="ev-quotes">
      {list.map((e) => (
        <EvidenceQuote key={`${e.ref}-${e.char_start}`} e={e} claim={claim.text} />
      ))}
    </ul>
  );
}

function EvidencePopover({
  claim,
  messageId,
  children,
}: {
  claim: FactcheckClaim;
  messageId: string | null;
  children: ReactNode;
}) {
  const focusClaim = useUi((s) => s.focusClaim);
  return (
    <HoverCard.Root openDelay={220} closeDelay={120}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="ev-card"
          data-verdict={claim.verdict}
          side="top"
          sideOffset={8}
          collisionPadding={12}
        >
          <div className="ev-card__head">
            <VerdictMark verdict={claim.verdict} />
            <span className="ev-card__conf" data-num title={claim.explanation}>
              {percent(claim.confidence)}
            </span>
          </div>
          {claim.verdict === 'contradicted' ? (
            <div className="ev-card__said">
              <span className="ev-quote__stance">The answer says</span>
              <p>{claim.text}</p>
            </div>
          ) : null}
          <EvidenceList claim={claim} limit={2} />
          {claim.rationale ? <p className="ev-card__why">{claim.rationale}</p> : null}
          <button
            type="button"
            className="link-btn ev-card__all"
            onClick={() => focusClaim(claim.id, messageId ?? undefined)}
          >
            All evidence for this answer
          </button>
          <HoverCard.Arrow className="hint-pop__arrow" width={12} height={6} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

/** A claim marked into an answer from Core, drawn by the markdown link component. */
export function LiveClaim({ id, children }: { id: string; children: ReactNode }) {
  const { claims, messageId } = useContext(ClaimsContext);
  const claim = claims.get(id);
  if (!claim) return <>{children}</>;
  return (
    <EvidencePopover claim={claim} messageId={messageId}>
      <Claim id={id} verdict={claim.verdict} messageId={messageId ?? undefined}>
        {children}
      </Claim>
    </EvidencePopover>
  );
}

/** Confidence as a small ring: the arc is the score. */
export function ScoreRing({
  value,
  size = 16,
  sealed = false,
}: {
  value: number;
  size?: number;
  sealed?: boolean;
}) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className="score-ring"
      data-sealed={sealed || undefined}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle className="score-ring__track" cx={size / 2} cy={size / 2} r={r} />
      <circle
        className="score-ring__arc"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
