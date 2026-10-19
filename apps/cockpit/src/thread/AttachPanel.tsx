/**
 * ------------------------------------------------------------------
 *  Title    |  Files in the composer: the question and the chips
 *  Ref      |  ROADMAP.md CH6 · thread/attach.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the composer draws once a file is dropped or
 *           |  chosen: in a notebook, the question "attach to this
 *           |  message, or add as a source?", and a chip for each file
 *           |  that goes with the message, with its page count (and, with
 *           |  Pro, its token estimate) and a "Keep in notebook" switch.
 *  How      |  Loaded the first time a file is involved (lazyHost in
 *           |  Composer.tsx), so an idle composer does not carry it.
 *           |  The composer owns the state and the actions; this file
 *           |  only draws them and calls back.
 * ------------------------------------------------------------------
 */

import type { AttachmentRecord } from '@nvx/contracts';
import { Icon } from '../ui/Icon';
import { AttachPro } from './AttachPro';
import { chipWords } from './attach';

/** A file on its way to the next message: being read, then ready as a chip (CH6). */
export interface PendingFile {
  key: string;
  file: File;
  state: 'sending' | 'ready';
  record?: AttachmentRecord;
  /** Add it to the notebook as a source once the message has gone. */
  keep: boolean;
}

/** Files just dropped in a notebook, waiting for the choice: this message, or a source. */
export interface DropAsk {
  files: File[];
  /** Can be attached to a message (PDF, text, code, CSV). */
  attachable: File[];
  /** A source of this name is already in the notebook. */
  have: string[];
}

export function AskDrop({
  ask,
  synced,
  claudeCode,
  onAttach,
  onSource,
  onCancel,
}: {
  ask: DropAsk;
  synced: boolean;
  claudeCode: boolean;
  onAttach: () => void;
  onSource: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="composer__ask m-glass" role="group" aria-label="What to do with these files">
      <p className="composer__ask-words">
        {ask.files.length === 1 ? (ask.files[0]?.name ?? 'This file') : `${ask.files.length} files`}
        {': '}
        {ask.attachable.length > 0
          ? 'attach to this message only, or add to the notebook as a source?'
          : synced && !claudeCode
            ? 'a message cannot carry this kind of file. Add it to the notebook as a source?'
            : claudeCode
              ? 'Claude Code reads files from its folder, so add it to the notebook as a source?'
              : 'add to the notebook as a source?'}
        {ask.have.length > 0 ? ` ${ask.have.join(', ')} is already a source here.` : ''}
      </p>
      <div className="composer__ask-actions">
        {ask.attachable.length > 0 ? (
          <button type="button" className="btn btn--primary btn--sm" onClick={onAttach}>
            Attach to this message
          </button>
        ) : null}
        <button
          type="button"
          className={`btn btn--sm ${ask.attachable.length > 0 ? 'btn--ghost' : 'btn--primary'}`}
          onClick={onSource}
        >
          Add as a source
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The chips of the files going with this message (list items, for the composer's chip list). */
export function FileChips({
  files,
  inNotebook,
  onKeep,
  onRemove,
}: {
  files: PendingFile[];
  inNotebook: boolean;
  onKeep: (f: PendingFile) => void;
  onRemove: (f: PendingFile) => void;
}) {
  return (
    <>
      {files.map((f) => (
        <li
          key={f.key}
          className="file-chip file-chip--msg"
          data-state={f.state === 'ready' ? 'done' : 'sending'}
        >
          <Icon name="attach" size={12} />
          <span className="file-chip__name">{f.file.name}</span>
          <span data-num className="mute">
            {f.state === 'sending' ? 'reading' : f.record ? chipWords(f.record) : ''}
          </span>
          {inNotebook && f.state === 'ready' ? (
            <button
              type="button"
              className="file-chip__keep"
              role="switch"
              aria-checked={f.keep}
              onClick={() => onKeep(f)}
            >
              Keep in notebook
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn icon-btn--xs"
            aria-label={`Remove ${f.file.name}`}
            onClick={() => onRemove(f)}
          >
            <Icon name="close" size={10} />
          </button>
        </li>
      ))}
      {files.some((f) => f.state === 'ready') ? <AttachPro /> : null}
    </>
  );
}
