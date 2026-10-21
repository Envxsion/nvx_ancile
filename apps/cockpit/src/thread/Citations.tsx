/**
 * ------------------------------------------------------------------
 *  Title    |  Citations in answers
 *  Ref      |  ROADMAP.md Phase 3 ("[n] opens the exact span")
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Turn [n] in a grounded answer into a chip: hover to read
 *           |  the passage, click to open the source with the passage
 *           |  highlighted. A fully grounded answer wears the gilt seal.
 *  How      |  Markers outside code become links to #cite-n before
 *           |  Streamdown renders; its `a` component draws the chip
 *           |  from the message's citation_ref parts and retrieval
 *           |  trace (via context). Remote images never load on their
 *           |  own (a prompt-injected answer could use one to leak
 *           |  data): they show as a placeholder you can choose to load.
 *           |  Each citation is checked against its source now: a
 *           |  deleted source reads "Source removed" with the quoted
 *           |  passage still there; a source read again with different
 *           |  text reads "Source changed since cited" (track G).
 * ------------------------------------------------------------------
 */

import type { CitationStatus, Part, RetrievalTrace } from '@nvx/contracts';
import * as HoverCard from '@radix-ui/react-hover-card';
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';
import { helpDone } from '../help/store';
import { tourEvent } from '../help/tourEvent';
import { ThreadImage } from '../images/ThreadImage';
import { useCitationStatus } from '../lib/factcheck';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { SafeLink } from '../ui/SafeLink';
import { LiveClaim } from './Claims';
import { MdCode } from './Code';

type Ref = Extract<Part, { type: 'citation_ref' }>;
type Status = CitationStatus['items'][number];
interface Cites {
  refs: Map<number, Ref>;
  hits: Map<number, RetrievalTrace['hits'][number]>;
  status: Map<number, Status>;
}

const CiteContext = createContext<Cites>({ refs: new Map(), hits: new Map(), status: new Map() });

export function CiteProvider({
  parts,
  trace,
  messageId,
  children,
}: {
  parts: Part[];
  trace: RetrievalTrace | undefined;
  /** The answer's id: its citations are then checked against their sources now. */
  messageId?: string;
  children: ReactNode;
}) {
  const refs = new Map(parts.flatMap((p) => (p.type === 'citation_ref' ? [[p.marker, p] as const] : [])));
  const hits = new Map((trace?.hits ?? []).map((h) => [h.marker, h] as const));
  const checked = useCitationStatus(messageId, refs.size > 0);
  const status = new Map((checked.data?.items ?? []).map((s) => [s.marker, s] as const));
  return <CiteContext.Provider value={{ refs, hits, status }}>{children}</CiteContext.Provider>;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** What the card says about a source that is gone or different now; null when it is as cited. */
export function sourceNote(s: Status | undefined): { label: string; detail: string } | null {
  if (s?.state === 'removed')
    return {
      label: 'Source removed',
      detail: s.merged_into
        ? 'It was merged into another source. The passage above is what this answer was given.'
        : `It was deleted${s.removed_at ? ` on ${day(s.removed_at)}` : ''}. The passage above is what this answer was given.`,
    };
  if (s?.state === 'changed')
    return {
      label: 'Source changed since cited',
      detail: 'The source was read again and no longer has this passage word for word.',
    };
  return null;
}

/** A passage as reading text: markdown headings, emphasis and code marks dropped. */
export function plainQuote(md: string): string {
  return md
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join('\n')
    .replace(/[*_`]{1,3}([^*_`\n]+)[*_`]{1,3}/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NBSP = ' ';
const WORD_JOINER = '⁠';

/**
 * [3] → [3](#cite-3), outside code fences and inline code. A chip is glued
 * to the word before it and to the punctuation after it (a no-break space
 * and word joiners), so a line never starts with ". If you…" or a lone chip.
 */
export function linkMarkers(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((seg, i) =>
      i % 2
        ? seg
        : seg.replace(
            /([ \t]*)(\[\d{1,3}\](?!\()(?:[ \t]*\[\d{1,3}\](?!\())*)([.,;:!?)]*)/g,
            (_m, lead: string, run: string, trail: string) => {
              const chips = [...run.matchAll(/\[(\d{1,3})\]/g)].map((m) => `[${m[1]}](#cite-${m[1]})`);
              return `${lead ? NBSP : ''}${chips.join(WORD_JOINER)}${trail ? WORD_JOINER + trail : ''}`;
            },
          ),
    )
    .join('');
}

function Chip({ n }: { n: number }) {
  const { refs, hits, status } = useContext(CiteContext);
  const openViewer = useUi((s) => s.openViewer);
  const style = usePrefs((s) => s.prefs.reading.citations);
  const ref = refs.get(n);
  const hit = hits.get(n);
  const now = status.get(n);
  const note = sourceNote(now);
  const removed = now?.state === 'removed';
  const title = hit?.source_title ?? ref?.source_title ?? now?.source_title ?? null;
  const live = !!ref;
  const open = () => {
    if (!ref || removed) return;
    openViewer({ sourceId: ref.source_id, start: ref.char_start, end: ref.char_end, marker: n });
    helpDone('cite');
    tourEvent('citation-opened');
  };
  // A span, not a <button>: a button is an atomic inline, and Chrome breaks
  // the line after it even across a word joiner, stranding ". If…" on the
  // next line. An inline span keeps the chip glued to its punctuation.
  const chip = (
    <span
      role="button"
      tabIndex={live ? 0 : -1}
      className="cite-chip"
      data-style={style}
      data-live={live || undefined}
      data-source={note ? now?.state : undefined}
      aria-disabled={!live || undefined}
      aria-label={
        live ? `Source ${n}: ${title ?? 'open the passage'}${note ? `. ${note.label}` : ''}` : `Citation ${n}`
      }
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      data-tour={n === 1 ? 'citation' : undefined}
    >
      {n}
    </span>
  );
  if (!live) return chip;
  return (
    <HoverCard.Root openDelay={180} closeDelay={80}>
      <HoverCard.Trigger asChild>{chip}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content className="cite-card" side="top" sideOffset={8} collisionPadding={12}>
          <div className="cite-card__head">
            <span className="cite-card__n" data-num>
              {n}
            </span>
            <span className="cite-card__title">{title ?? 'Source'}</span>
            {hit?.page != null ? <span className="mute">p. {hit.page}</span> : null}
          </div>
          {note ? (
            <span className="cite-card__flag" data-source={now?.state}>
              {note.label}
            </span>
          ) : null}
          <blockquote className="cite-card__quote" dir="auto">
            {plainQuote(ref.quote)}
          </blockquote>
          {note ? <p className="cite-card__note">{note.detail}</p> : null}
          {removed ? null : (
            <button type="button" className="link-btn" onClick={open}>
              {note ? 'Open the current version' : 'Open in the source'}
            </button>
          )}
          <HoverCard.Arrow className="hint-pop__arrow" width={12} height={6} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

/** Markdown images: local ones inline, remote ones only after a yes (images/ThreadImage.tsx). */
function SafeImage({ src, alt }: ComponentProps<'img'>) {
  return <ThreadImage src={typeof src === 'string' ? src : ''} alt={alt} />;
}

function Link({ href, children, ...rest }: ComponentProps<'a'>) {
  const m = href ? /^#cite-(\d+)$/.exec(href) : null;
  if (m) return <Chip n={Number(m[1])} />;
  const claim = href ? /^#claim-([\w-]+)$/.exec(href) : null;
  if (claim) return <LiveClaim id={claim[1] as string}>{children}</LiveClaim>;
  return (
    <SafeLink href={href} {...rest}>
      {children}
    </SafeLink>
  );
}

/** Links, images and code as Aperture draws them, for every Streamdown in the thread. */
export const MD_COMPONENTS = { a: Link, img: SafeImage, code: MdCode };
