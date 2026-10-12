/**
 * ------------------------------------------------------------------
 *  Title    |  Context links
 *  Ref      |  docs/notebooks.md (Context links)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Let this thread or notebook draw on another notebook's
 *           |  sources, or another thread's summary, and see both
 *           |  ends: what this side reads, and who reads from it.
 *  How      |  A link a scope would refuse is refused when it is made,
 *           |  in Core's own words; a link refused later (a notebook
 *           |  made private since) stays listed with the reason, and
 *           |  is not read until the scopes allow it again.
 * ------------------------------------------------------------------
 */

import type { ContextLink } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useId, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { useNotebooks, useThreads } from '../lib/data';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { createLink, removeLink, useContextLinks } from './api';
import '../styles/notebooks.css';

function LinkRow({ link, end, onRemove }: { link: ContextLink; end: 'to' | 'from'; onRemove?: () => void }) {
  const other = link[end];
  return (
    <li>
      <Icon name={other.kind === 'notebook' ? 'notebook' : 'thread'} size={13} />
      <span className="ctx-links__title" dir="auto">
        {other.title ?? 'No longer here'}
        <span className="mute"> · {link.kind === 'sources' ? 'its sources' : 'its summary'}</span>
      </span>
      {onRemove ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRemove}>
          Remove link
        </button>
      ) : (
        <span />
      )}
      {link.status.ok ? null : <span className="ctx-links__status">Not read now: {link.status.reason}</span>}
    </li>
  );
}

export function LinksDialog({
  open,
  onOpenChange,
  from,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  from: { kind: 'thread' | 'notebook'; id: string; title: string; notebookId?: string | null };
}) {
  useLayer(open);
  const links = useContextLinks(from.kind, from.id, open);
  const notebooks = useNotebooks();
  const threads = useThreads();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = useId();
  const linked = new Set((links.data?.outgoing ?? []).map((l) => `${l.to.kind}:${l.to.id}`));
  const notebookOptions = (notebooks.data ?? []).filter(
    (n) =>
      !(from.kind === 'notebook' && n.id === from.id) &&
      n.id !== from.notebookId &&
      !linked.has(`notebook:${n.id}`),
  );
  const threadOptions = (threads.data ?? [])
    .filter((t) => !(from.kind === 'thread' && t.id === from.id) && !linked.has(`thread:${t.id}`))
    .slice(0, 60);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog ctx-links" aria-describedby={`${pick}-lede`}>
          <Dialog.Title className="dialog__title">Context links for {from.title}</Dialog.Title>
          <p id={`${pick}-lede`} className="dialog__lede">
            Let {from.kind === 'thread' ? 'this thread' : 'every thread in this notebook'} draw on another
            notebook's sources or another thread's summary. Nothing is moved or copied, and both sides' scopes
            are checked each time it is read.
          </p>
          <div className="ctx-links__add">
            <label className="field" htmlFor={pick}>
              <span className="field__label">Draw on</span>
              <select id={pick} className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose a notebook or thread</option>
                <optgroup label="Notebooks: read their sources">
                  {notebookOptions.map((n) => (
                    <option key={n.id} value={`notebook:${n.id}`}>
                      {n.title}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Threads: see their summary">
                  {threadOptions.map((t) => (
                    <option key={t.id} value={`thread:${t.id}`}>
                      {t.title}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!target || busy}
              data-busy={busy || undefined}
              onClick={async () => {
                const [kind, id] = target.split(':') as ['thread' | 'notebook', string];
                if (!id || busy) return;
                setBusy(true);
                const made = await createLink({ kind: from.kind, id: from.id }, { kind, id });
                setBusy(false);
                if (made) setTarget('');
              }}
            >
              <Icon name="link" size={14} />
              Add link
            </button>
          </div>
          {links.isPending && open ? (
            <Skeleton lines={3} label="Loading links" />
          ) : (
            <>
              <section className="ctx-links__group" aria-labelledby={`${pick}-out`}>
                <h3 id={`${pick}-out`} className="ctx-links__h">
                  This {from.kind} reads from
                </h3>
                {links.data?.outgoing.length ? (
                  <ul className="ctx-links__list">
                    {links.data.outgoing.map((l) => (
                      <LinkRow key={l.id} link={l} end="to" onRemove={() => void removeLink(l.id)} />
                    ))}
                  </ul>
                ) : (
                  <p className="mute">No links yet.</p>
                )}
              </section>
              <section className="ctx-links__group" aria-labelledby={`${pick}-in`}>
                <h3 id={`${pick}-in`} className="ctx-links__h">
                  Reads from this {from.kind}
                </h3>
                {links.data?.incoming.length ? (
                  <ul className="ctx-links__list">
                    {links.data.incoming.map((l) => (
                      <LinkRow key={l.id} link={l} end="from" onRemove={() => void removeLink(l.id)} />
                    ))}
                  </ul>
                ) : (
                  <p className="mute">Nothing reads from it.</p>
                )}
              </section>
            </>
          )}
          <div className="dialog__actions">
            <Dialog.Close className="btn btn--ghost">Done</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
