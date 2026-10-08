/**
 * ------------------------------------------------------------------
 *  Title    |  Memory editor
 *  Ref      |  DESIGN.md §6.4 (concurrency)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Edit a memory file by hand, see exactly what will change
 *           |  before it is committed, and never lose an edit to a
 *           |  change NVX Ancile made meanwhile.
 *  How      |  Edit → Review (a line diff against what was opened) →
 *           |  Save, which sends base_sha. Core merges a change on
 *           |  other lines by itself; a clash comes back as both sides
 *           |  with conflict markers, shown side by side, to resolve
 *           |  in place and save on top of the newer version.
 *  Note     |  Ctrl S reviews, and saves from the review. Esc steps
 *           |  back. A draft survives switching tabs, not files.
 * ------------------------------------------------------------------
 */

import type { MemoryConflictContext, MemoryFileContent } from '@nvx/contracts';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ApiCallError } from '../lib/api';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { failed, refreshMemory, saveFile } from './api';
import { DiffView } from './DiffView';
import { diffStats, lineDiff } from './linediff';

type Stage = 'edit' | 'review' | 'conflict';

export function MemoryEditor({ file, onDone }: { file: MemoryFileContent; onDone: () => void }) {
  const [text, setText] = useState(file.content);
  const [base, setBase] = useState<{ content: string; version: string | null }>({
    content: file.content,
    version: file.version === 'uncommitted' ? null : file.version,
  });
  const [stage, setStage] = useState<Stage>('edit');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<MemoryConflictContext | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const rows = useMemo(
    () => (stage === 'review' ? lineDiff(base.content, text) : []),
    [stage, base.content, text],
  );
  const stats = diffStats(rows);
  const dirty = text !== base.content;
  const lines = text.split('\n').length;

  useEffect(() => {
    if (stage === 'edit') area.current?.focus();
    if (stage === 'review') saveRef.current?.focus();
  }, [stage]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await saveFile(file.path, text, base.version, message);
      void refreshMemory();
      notify({
        level: 'success',
        title: r.changed ? 'Saved to memory' : 'Nothing to save',
        body: r.merged
          ? 'A change NVX Ancile made meanwhile was merged in.'
          : r.changed
            ? 'Committed. History can undo it.'
            : 'The file already says this.',
      });
      onDone();
    } catch (e) {
      if (e instanceof ApiCallError && e.body.error.code === 'memory.conflict') {
        const ctx = e.body.error.context as unknown as MemoryConflictContext;
        if (ctx?.merged_with_markers !== undefined) {
          setConflict(ctx);
          setText(ctx.merged_with_markers);
          setBase({ content: ctx.current_content, version: ctx.current });
          setStage('conflict');
          return;
        }
      }
      failed(e, 'Saving');
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      if (stage === 'review') void save();
      else if (dirty && !/^<{7}|^>{7}/m.test(text)) setStage('review');
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (stage === 'review') setStage('edit');
      else if (!dirty) onDone();
    }
    // Tab indents inside the editor rather than leaving it.
    if (e.key === 'Tab' && stage !== 'review' && e.target === area.current && !e.shiftKey) {
      e.preventDefault();
      const el = area.current;
      const { selectionStart: s, selectionEnd: t } = el;
      const next = `${text.slice(0, s)}  ${text.slice(t)}`;
      setText(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
    }
  };

  const markers = /^(<{7}|={7}|>{7})/m.test(text);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: editor-wide shortcuts (Ctrl S, Esc)
    <div className="mem-editor" onKeyDown={onKey} data-stage={stage}>
      {stage === 'conflict' && conflict ? (
        <div className="mem-conflict" role="alert">
          <div className="mem-conflict__head">
            <Icon name="merge" size={14} />
            <div>
              <strong>This file changed while you were editing it.</strong>
              <p className="mute">
                Lines between the markers clash. Keep what you want from each side, delete the marker lines,
                then review and save.
              </p>
            </div>
          </div>
          <div className="mem-conflict__sides">
            <section>
              <h4>Saved meanwhile</h4>
              <pre className="mem-conflict__text">{conflictSide(conflict.merged_with_markers, 'ours')}</pre>
            </section>
            <section>
              <h4>Your edit</h4>
              <pre className="mem-conflict__text">{conflictSide(conflict.merged_with_markers, 'theirs')}</pre>
            </section>
          </div>
        </div>
      ) : null}

      {stage === 'review' ? (
        <div className="mem-review">
          <div className="mem-review__stats">
            <span className="mem-review__add" data-num>
              +{stats.added}
            </span>
            <span className="mem-review__del" data-num>
              −{stats.removed}
            </span>
            <span className="mute">Review before it is committed.</span>
          </div>
          <DiffView rows={rows} label="Changes to save" />
          <label className="mem-review__msg">
            <span>What changed (optional)</span>
            <input
              className="input"
              value={message}
              maxLength={200}
              placeholder="Say why, for the history"
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
            />
          </label>
        </div>
      ) : (
        <div className="mem-editor__field">
          <div className="mem-editor__gutter" aria-hidden="true" data-num>
            {Array.from({ length: Math.min(lines, 5000) }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are their index
              <span key={i}>{i + 1}</span>
            ))}
          </div>
          <textarea
            ref={area}
            className="mem-editor__text"
            value={text}
            spellCheck
            aria-label={`Edit ${file.path}`}
            onChange={(e) => setText(e.target.value)}
            onScroll={(e) => {
              const g = e.currentTarget.previousElementSibling as HTMLElement | null;
              if (g) g.scrollTop = e.currentTarget.scrollTop;
            }}
          />
        </div>
      )}

      <footer className="mem-editor__bar">
        <span className="mute mem-editor__tip">
          {stage === 'review' ? (
            <>
              <kbd>Ctrl</kbd> <kbd>S</kbd> saves · <kbd>Esc</kbd> goes back
            </>
          ) : markers ? (
            'Remove the conflict markers to continue.'
          ) : (
            <>
              One idea per bullet. <kbd>Ctrl</kbd> <kbd>S</kbd> reviews.
            </>
          )}
        </span>
        <span className="mem-editor__actions">
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => (stage === 'review' ? setStage('edit') : onDone())}
          >
            {stage === 'review' ? 'Back to editing' : 'Cancel'}
          </button>
          {stage === 'review' ? (
            <button
              ref={saveRef}
              type="button"
              className="btn btn--primary btn--sm"
              data-busy={busy || undefined}
              disabled={busy}
              onClick={() => void save()}
            >
              Save to memory
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!dirty || markers}
              onClick={() => setStage('review')}
            >
              Review changes
            </button>
          )}
        </span>
      </footer>
    </div>
  );
}

/** One side of a text with git conflict markers. */
export function conflictSide(text: string, side: 'ours' | 'theirs'): string {
  const out: string[] = [];
  let state: 'both' | 'ours' | 'theirs' = 'both';
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) state = 'ours';
    else if (line.startsWith('=======') && state === 'ours') state = 'theirs';
    else if (line.startsWith('>>>>>>>') && state === 'theirs') state = 'both';
    else if (state === 'both' || state === side) out.push(line);
  }
  return out.join('\n');
}
