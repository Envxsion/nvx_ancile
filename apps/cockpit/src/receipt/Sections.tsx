/**
 * ------------------------------------------------------------------
 *  Title    |  Receipt parts: sources, links and memory
 *  Ref      |  roadmap WY1 · DESIGN.md §11.4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The detail behind the receipt's "What went in" lines:
 *           |  the passages found and how each scored, the context
 *           |  links, and the memory files with the entries given.
 *  How      |  Each is folded away until asked for. They read what
 *           |  Core recorded (Explain); none of them invents a figure.
 * ------------------------------------------------------------------
 */

import type { Explain } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { useMemoryFile } from '../memory/api';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';

/** The score table behind "Show scores": every passage found, how each ranked, which were cited. */
export function Retrieval({ x }: { x: Explain }) {
  const openViewer = useUi((s) => s.openViewer);
  const r = x.retrieval;
  // Written by Claude Code in a terminal and brought in: nothing was recorded about sources.
  if (!r && x.origin === 'claude_code_import')
    return (
      <p className="mute rc__note">
        <Icon name="terminal" size={12} /> Written before import, no citation record. Claude Code wrote this
        in a terminal; NVX Ancile brought it in from the session, so which sources it read is not known.
      </p>
    );
  if (!r)
    return (
      <p className="mute rc__note">
        {x.retrieval_error
          ? `Your sources could not be searched (${x.retrieval_error.title}), so this answer is not from them.`
          : 'This answer did not draw on sources: the thread is not in a notebook.'}
      </p>
    );
  if (!r.hits.length)
    return <p className="mute rc__note">The search found nothing in this notebook for the question.</p>;
  const best = Math.max(...r.hits.map((h) => h.score), 0.0001);
  return (
    <>
      <p className="mute rc__note">
        Searched for “{r.query.length > 90 ? `${r.query.slice(0, 90)}…` : r.query}” ({r.mode}
        {r.embedder ? `, ${r.embedder.replace(/^local\//, '')}` : ''}) in{' '}
        <span data-num>{Math.round(r.ms)}</span> ms.
        {r.invalid_markers
          ? ` ${r.invalid_markers} made-up ${r.invalid_markers === 1 ? 'citation was' : 'citations were'} removed.`
          : ''}
      </p>
      <ul className="rc-scores">
        {r.hits.map((h) => (
          <li key={h.marker} data-cited={h.cited || undefined}>
            <span className="rc-scores__bar" style={{ width: `${Math.max(6, (h.score / best) * 100)}%` }} />
            <button
              type="button"
              className="rc-scores__title link-btn link-btn--quiet"
              onClick={() => openViewer({ sourceId: h.source_id, marker: h.marker })}
              title={h.source_title}
            >
              [{h.marker}] {h.source_title}
              {h.page != null ? `, p. ${h.page}` : ''}
              {h.via ? <span className="mute"> · from {h.via.notebook_title}</span> : null}
            </button>
            <span
              className="mute rc-scores__ranks"
              data-num
              title="Rank by meaning · rank by words, then the reranker's score"
            >
              {h.ranks.vector ?? '–'}·{h.ranks.text ?? '–'}
              {h.rerank_score != null ? ` → ${h.rerank_score.toFixed(2)}` : ''}
            </span>
            <span className="rc-scores__cited">{h.cited ? 'Cited' : 'Not cited'}</span>
          </li>
        ))}
      </ul>
      {r.grounded ? (
        <p className="rc__sealed">
          <Icon name="seal" size={13} className="gilt-ink" /> Every paragraph that states something cites a
          passage.
        </p>
      ) : null}
    </>
  );
}

const LINK_STATE: Record<Explain['links'][number]['state'], string> = {
  used: 'Used',
  empty: 'Nothing matched',
  refused: 'Not read',
};

/** Which links (and context packs) this answer drew on, and which a scope kept out. */
export function LinksUsed({ links }: { links: Explain['links'] }) {
  return (
    <ul className="rc-links">
      {links.map((l) => (
        <li key={`${l.link_id}-${l.to_id}`} data-state={l.state}>
          <Icon
            name={l.kind === 'pack' ? 'archive' : l.kind === 'summary' ? 'thread' : 'notebook'}
            size={12}
          />
          <span className="rc-links__title" dir="auto">
            {l.kind === 'pack' ? 'Context pack' : l.kind === 'summary' ? 'Thread' : 'Notebook'} “{l.title}”
          </span>
          <span className="mute">{l.via === 'notebook' ? 'linked on the notebook' : 'linked here'}</span>
          <span className="rc-links__state">
            {LINK_STATE[l.state]}
            {l.state === 'used' && l.passages ? ` · ${l.passages} passages, ${l.cited} cited` : ''}
          </span>
          {l.reason ? <span className="mute rc-links__reason">{l.reason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Used: ..." in words: the memory entries that shaped this answer, each linking to its file
 * (and the commit it was read at). Quiet: it lives in the Why panel, not under the answer.
 */
export function MemoryUsed({ used }: { used: NonNullable<Explain['memory_used']> }) {
  const shown = used.slice(0, 3);
  const clip = (t: string) => {
    const s = t.replace(/\*\*/g, '').replace(/\.$/, '');
    return s.length > 70 ? `${s.slice(0, 67).trimEnd()}…` : s;
  };
  return (
    <p className="rc-used" dir="auto">
      <span className="mute">Used: </span>
      {shown.map((u, i) => (
        <span key={`${u.path}-${u.key}`}>
          {i ? '; ' : ''}
          <Link
            to="/admin/$section"
            params={{ section: 'memory' }}
            search={{ file: u.path } as never}
            title={`${u.path} · ${u.key} · commit ${u.commit.slice(0, 7)}`}
          >
            {clip(u.text)}
          </Link>
        </span>
      ))}
      {used.length > shown.length ? (
        <span className="mute"> and {used.length - shown.length} more</span>
      ) : null}
    </p>
  );
}

/** The memory files an answer was given, each with the entries read from it. */
export function MemoryFiles({ memory }: { memory: NonNullable<Explain['memory']> }) {
  return (
    <ul className="rc-memory">
      {memory.files.map((file) => (
        <li key={file.path}>
          <div className="rc-memory__file">
            <Icon name="memory" size={13} />
            <Link to="/admin/$section" params={{ section: 'memory' }} search={{ file: file.path } as never}>
              {file.path}
            </Link>
            <span data-num className="mute" title={`Read at commit ${file.commit}`}>
              {file.commit.slice(0, 7)} · {file.tokens} tok
            </span>
          </div>
          <MemoryEntries path={file.path} keys={file.entries} dropped={file.dropped} />
        </li>
      ))}
    </ul>
  );
}

/** The entries an answer was given, as words: keys are looked up in the file. */
function MemoryEntries({ path, keys, dropped }: { path: string; keys: string[]; dropped: number }) {
  const file = useMemoryFile(keys.length ? path : null);
  const textOf = new Map((file.data?.entries ?? []).map((e) => [e.key, e.text]));
  return (
    <ul className="rc-memory__entries">
      {keys.map((k) => (
        <li key={k} dir="auto" title={k}>
          {textOf.get(k) ?? (file.isPending ? '…' : 'An entry since edited or removed')}
        </li>
      ))}
      {dropped ? (
        <li className="mute">
          {dropped} more {dropped === 1 ? 'entry' : 'entries'} did not fit
        </li>
      ) : null}
    </ul>
  );
}
