/**
 * ------------------------------------------------------------------
 *  Title    |  Merge a notebook into this one
 *  Ref      |  docs/notebooks.md (Merging notebooks)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Pick the notebook to fold in, see everything that would
 *           |  happen before it does, choose whose instructions to
 *           |  keep (or combine them), then merge.
 *  How      |  The preview is Core's (GET merge-preview): threads,
 *           |  sources (moved, already here, duplicates, other
 *           |  versions), notes, notebook memory, flows, folders,
 *           |  links and every scope field that narrows. The merge
 *           |  button says what happens. Undo lives in the history.
 *  Note     |  A scope never widens in a merge, and private wins: the
 *           |  dialog says so where it applies.
 * ------------------------------------------------------------------
 */

import type { MergeInstructionsChoice, NotebookMergePreview } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { useNotebooks } from '../lib/data';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { applyMerge, useMergePreview } from './api';
import '../styles/notebooks.css';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const words = (v: unknown): string => {
  if (v === null || v === undefined) return 'Any';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'None';
  return String(v);
};

function Row({
  icon,
  title,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="nbm__row">
      <span className="nbm__glyph" aria-hidden="true">
        <Icon name={icon} size={13} />
      </span>
      <div className="nbm__row-body">
        <p className="nbm__row-title">{title}</p>
        <div className="mute nbm__row-detail">{children}</div>
      </div>
    </div>
  );
}

function Preview({ p }: { p: NotebookMergePreview }) {
  const s = p.sources;
  const narrowed = p.scope.changes.filter((c) => c.narrows_into);
  return (
    <div className="nbm__preview">
      <Row icon="thread" title={count(p.threads.length, 'thread joins', 'threads join')}>
        {p.threads.length
          ? `Each keeps its own history${p.threads.some((t) => t.cwd) ? ' and its own Claude Code folder' : ''}.`
          : 'There are no threads to move.'}
      </Row>
      <Row icon="sources" title={count(s.move.length, 'source joins', 'sources join')}>
        {[
          s.already.length ? `${count(s.already.length, 'is', 'are')} already here.` : null,
          s.duplicates.length
            ? `${count(s.duplicates.length, 'copy has', 'copies have')} the same content as one here and ${s.duplicates.length === 1 ? 'is' : 'are'} merged into it; answers that cited ${s.duplicates.length === 1 ? 'it' : 'them'} still name ${s.duplicates.length === 1 ? 'it' : 'them'}.`
            : null,
          s.versions.length
            ? `${count(s.versions.length, 'looks', 'look')} like another version of one here: both are kept.`
            : null,
        ]
          .filter(Boolean)
          .join(' ') || 'Nothing else to sort out.'}
      </Row>
      <Row icon="note" title={count(p.notes.length, 'note joins', 'notes join')}>
        {p.memory.entries
          ? `${count(p.memory.entries, 'memory entry is', 'memory entries are')} added to this notebook's memory, in one change you can revert.`
          : 'No notebook memory to bring over.'}
      </Row>
      {p.flows.length ? (
        <Row icon="branch" title={count(p.flows.length, 'flow joins', 'flows join')}>
          {p.flows.some((f) => f.switched_off)
            ? 'This notebook already has an active flow, so they arrive switched off.'
            : 'They keep their state.'}
        </Row>
      ) : null}
      {p.folders.from.length ? (
        <Row icon="folder" title={count(p.folders.from.length, 'Claude Code folder', 'Claude Code folders')}>
          This notebook will hold {count(p.folders.into.length + p.folders.from.length, 'folder', 'folders')}:{' '}
          {[...p.folders.into, ...p.folders.from].join(', ')}.
        </Row>
      ) : null}
      {p.links.retarget || p.links.dropped ? (
        <Row
          icon="link"
          title={count(p.links.retarget, 'context link moves here', 'context links move here')}
        >
          {p.links.dropped
            ? `${count(p.links.dropped, 'link between the two goes', 'links between the two go')}.`
            : ''}
        </Row>
      ) : null}
      <Row icon="shield" title={narrowed.length ? 'The scope narrows' : 'The scope stays as it is'}>
        {p.scope.private.merged && !p.scope.private.into
          ? 'It becomes private: local models only, nothing leaves this machine. '
          : ''}
        {narrowed.length
          ? 'Merging never widens what either notebook allows.'
          : 'Nothing this notebook allows changes.'}
      </Row>
      {narrowed.length ? (
        <table className="nbm__scope">
          <caption className="sr-only">Scope fields that narrow</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Here now</th>
              <th scope="col">After the merge</th>
            </tr>
          </thead>
          <tbody>
            {narrowed.map((c) => (
              <tr key={c.field}>
                <th scope="row">{c.note.split(':')[0]}</th>
                <td>{words(c.into)}</td>
                <td className="nbm__narrow">{words(c.merged)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {p.warnings.length ? (
        <ul className="nbm__warnings">
          {p.warnings.map((w) => (
            <li key={w}>
              <Icon name="warn" size={12} /> {w}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Instructions({
  p,
  value,
  onChange,
}: {
  p: NotebookMergePreview;
  value: MergeInstructionsChoice;
  onChange: (v: MergeInstructionsChoice) => void;
}) {
  const name = useId();
  const combined = value.choice === 'combined' ? value : null;
  const both = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join('\n\n');
  return (
    <fieldset className="nbm__instructions">
      <legend className="nbm__legend">Instructions and persona</legend>
      <label className="nbm__choice">
        <input
          type="radio"
          name={name}
          checked={value.choice === 'into'}
          onChange={() => onChange({ choice: 'into' })}
        />
        <span>
          Keep this notebook's
          <span className="mute nbm__quote">{p.instructions.into.instructions || 'None set'}</span>
        </span>
      </label>
      <label className="nbm__choice">
        <input
          type="radio"
          name={name}
          checked={value.choice === 'from'}
          onChange={() => onChange({ choice: 'from' })}
        />
        <span>
          Take {p.from.title}'s
          <span className="mute nbm__quote">{p.instructions.from.instructions || 'None set'}</span>
        </span>
      </label>
      <label className="nbm__choice">
        <input
          type="radio"
          name={name}
          checked={value.choice === 'combined'}
          onChange={() =>
            onChange({
              choice: 'combined',
              instructions: both(p.instructions.into.instructions, p.instructions.from.instructions).slice(
                0,
                4000,
              ),
              persona: both(p.instructions.into.persona, p.instructions.from.persona).slice(0, 1000),
            })
          }
        />
        <span>Combine them</span>
      </label>
      {combined ? (
        <div className="nbm__combine">
          <label className="field">
            <span className="field__label">Instructions</span>
            <textarea
              className="input"
              rows={4}
              maxLength={4000}
              value={combined.instructions}
              onChange={(e) => onChange({ ...combined, instructions: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field__label">Persona</span>
            <textarea
              className="input"
              rows={2}
              maxLength={1000}
              value={combined.persona}
              onChange={(e) => onChange({ ...combined, persona: e.target.value })}
            />
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}

export function MergeDialog({
  open,
  onOpenChange,
  into,
  from: initialFrom = null,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  into: { id: string; title: string };
  /** Start with this notebook chosen (the same-repository suggestion). */
  from?: string | null;
}) {
  useLayer(open);
  const notebooks = useNotebooks();
  const [from, setFrom] = useState<string | null>(initialFrom);
  const [instructions, setInstructions] = useState<MergeInstructionsChoice>({ choice: 'into' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setFrom(initialFrom);
      setInstructions({ choice: 'into' });
    }
  }, [open, initialFrom]);
  const preview = useMergePreview(into.id, open ? from : null);
  const others = (notebooks.data ?? []).filter((n) => n.id !== into.id);
  const pickId = useId();
  const p = preview.data;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog nbm" aria-describedby={`${pickId}-lede`}>
          <Dialog.Title className="dialog__title">Merge a notebook into {into.title}</Dialog.Title>
          <p id={`${pickId}-lede`} className="dialog__lede">
            Everything in the other notebook joins this one. You see what changes first, and you can undo it
            for a week.
          </p>
          <label className="field" htmlFor={pickId}>
            <span className="field__label">Notebook to merge</span>
            <select
              id={pickId}
              className="input"
              value={from ?? ''}
              onChange={(e) => setFrom(e.target.value || null)}
            >
              <option value="">Choose a notebook</option>
              {others.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
          {from ? (
            preview.isPending ? (
              <Skeleton lines={5} label="Working out what would change" />
            ) : preview.isError ? (
              <p className="nbm__error" role="alert">
                The merge could not be previewed. Check that NVX Ancile is running, then choose the notebook
                again.
              </p>
            ) : p ? (
              <>
                <Preview p={p} />
                {p.instructions.same ? null : (
                  <Instructions p={p} value={instructions} onChange={setInstructions} />
                )}
              </>
            ) : null
          ) : null}
          <div className="dialog__actions">
            <Dialog.Close className="btn btn--ghost">Keep them apart</Dialog.Close>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!p || busy}
              data-busy={busy || undefined}
              onClick={async () => {
                if (!p || !from || busy) return;
                setBusy(true);
                const done = await applyMerge(into.id, from, instructions);
                setBusy(false);
                if (done) onOpenChange(false);
              }}
            >
              <Icon name="merge" size={14} />
              {p ? `Merge ${p.from.title} into ${into.title}` : 'Merge notebooks'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
