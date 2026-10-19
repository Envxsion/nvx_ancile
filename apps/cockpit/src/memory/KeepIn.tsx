/**
 * ------------------------------------------------------------------
 *  Title    |  Keep it for... (scope and file when approving)
 *  Ref      |  ROADMAP M1 · DESIGN.md §6.3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Decide where an approved learning goes: for You, for
 *           |  This notebook, or Everywhere, or in a file you pick.
 *  How      |  A small radio group and a file list, used by the inbox
 *           |  card and the answer tray. Nothing is sent until Keep:
 *           |  the parent holds the value and passes it to the decision.
 *           |  The scope it starts on is where it was proposed.
 *  Note     |  This notebook is off, with the reason, when the thing
 *           |  was not learned in a notebook, that notebook has been
 *           |  deleted, or the thread is gone. Lessons and model quirks
 *           |  are kept by topic, so they offer only a file.
 * ------------------------------------------------------------------
 */

import type { MemoryProposal, ProposalScope } from '@nvx/contracts';
import { useId } from 'react';
import type { Keep } from './api';
import { useMemoryFiles } from './api';

const SCOPES: { id: ProposalScope; label: string }[] = [
  { id: 'user', label: 'You' },
  { id: 'notebook', label: 'This notebook' },
  { id: 'everywhere', label: 'Everywhere' },
];

/** The scope a suggestion is aimed at as proposed, from its file. */
export function scopeOfPath(path: string): ProposalScope | null {
  if (path === 'USER.md') return 'user';
  if (path === 'AGENTS.md') return 'everywhere';
  if (path.startsWith('PROJECTS/')) return 'notebook';
  return null;
}

/** Why "This notebook" cannot be chosen, or null when it can. */
export function notebookBlocker(p: Pick<MemoryProposal, 'source' | 'target_path'>): string | null {
  if (scopeOfPath(p.target_path) === 'notebook') return null;
  const s = p.source;
  if (!s) return 'Not learned in a thread';
  if (s.thread_deleted) return 'The thread it came from was deleted';
  if (!s.notebook) return 'It was not learned in a notebook';
  if (s.notebook.title === null) return 'That notebook was deleted';
  return null;
}

const isLesson = (k: MemoryProposal['kind']) => k === 'failure_lesson' || k === 'model_quirk';

export function KeepIn({
  p,
  value,
  onChange,
}: {
  p: Pick<MemoryProposal, 'kind' | 'source' | 'target_path'>;
  value: Keep;
  onChange: (next: Keep) => void;
}) {
  const id = useId();
  const files = useMemoryFiles();
  const initial = scopeOfPath(p.target_path);
  const selected = value.path ? null : (value.scope ?? initial);
  const blocked = notebookBlocker(p);
  const paths = (files.data?.items ?? [])
    .map((f) => f.path)
    .filter((x) => !/(^|\/)(README|_template)\.md$/i.test(x));

  return (
    <fieldset className="mem-keep">
      <legend className="mem-keep__legend">Keep it</legend>
      {isLesson(p.kind) ? null : (
        <div className="mem-keep__scopes" role="radiogroup" aria-label="Keep it for">
          {SCOPES.map((s) => {
            const off = s.id === 'notebook' && !!blocked;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={selected === s.id}
                className="mem-keep__scope"
                data-on={selected === s.id || undefined}
                disabled={off}
                title={off ? (blocked ?? undefined) : undefined}
                onClick={() => onChange({ scope: s.id })}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      )}
      {paths.length ? (
        <label className="mem-keep__file" htmlFor={`${id}-file`}>
          <span className="mute">{isLesson(p.kind) ? 'In' : 'or in'}</span>
          <select
            id={`${id}-file`}
            className="input mem-keep__select"
            aria-label="Or choose a file"
            value={value.path ?? ''}
            onChange={(e) => onChange(e.target.value ? { path: e.target.value } : {})}
          >
            <option value="">{isLesson(p.kind) ? `As suggested (${p.target_path})` : 'Choose a file'}</option>
            {paths.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {blocked && !isLesson(p.kind) ? <span className="mem-keep__note mute">{blocked}</span> : null}
    </fieldset>
  );
}
