/**
 * ------------------------------------------------------------------
 *  Title    |  Memory: import and export
 *  Ref      |  docs/memory.md (Import and export) · ROADMAP track E
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Take memory with you (a zip, a git bundle with its
 *           |  history, or one readable Markdown file; all of it or one
 *           |  notebook's), and bring in what another tool remembered:
 *           |  an NVX Ancile export, a CLAUDE.md you pick, ChatGPT's
 *           |  saved memories, or plain notes.
 *  How      |  Export: choose, then Save export (made on this computer,
 *           |  saved by the browser). Import: pick or paste, Preview
 *           |  (nothing is written), untick what you do not want, Add
 *           |  for review; then Accept all or accept the ticked ones.
 *           |  Accepted entries go into memory in one commit, with one
 *           |  Undo for the lot.
 *  Note     |  Imports are outside content, so they only ever propose:
 *           |  nothing comes in until you accept it here.
 * ------------------------------------------------------------------
 */

import type {
  MemoryExportFormat,
  MemoryImportOrigin,
  MemoryImportPreview,
  MemoryImportRequest,
  MemoryImportTarget,
  MemoryProposal,
} from '@nvx/contracts';
import { useId, useMemo, useRef, useState } from 'react';
import { ApiCallError } from '../lib/api';
import { notify } from '../state/notify';
import { Check, Segmented, Switch } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { failed, useDecide } from './api';
import {
  downloadExport,
  previewImport,
  readPicked,
  useCreateImport,
  useDecideImport,
  useExportPlan,
  useImport,
  useImports,
} from './transferApi';

const FORMATS: { value: MemoryExportFormat; label: string; desc: string }[] = [
  { value: 'zip', label: 'Zip', desc: 'The files as they are now. Opens anywhere.' },
  { value: 'markdown', label: 'Markdown', desc: 'One readable file, every memory file in turn.' },
  { value: 'bundle', label: 'Git bundle', desc: 'The whole repository, with every change in its history.' },
];

export const ORIGINS: { value: MemoryImportOrigin; label: string; how: string; accept: string }[] = [
  {
    value: 'ancile',
    label: 'NVX Ancile',
    how: 'Pick a zip, git bundle or Markdown file that NVX Ancile exported. Entries keep their files and sections.',
    accept: '.zip,.bundle,.md',
  },
  {
    value: 'claude_code',
    label: 'Claude Code',
    how: 'Pick the CLAUDE.md or memory file you want. NVX Ancile reads only the file you pick, and never looks in your Claude Code folder on its own.',
    accept: '.md,.txt',
  },
  {
    value: 'chatgpt',
    label: 'ChatGPT',
    how: 'In ChatGPT, open Settings, Personalization, Memory, Manage. Copy the list and paste it here, one memory per line. A JSON list works too.',
    accept: '.txt,.json,.md',
  },
  {
    value: 'markdown',
    label: 'Notes',
    how: 'Pick or paste Markdown or plain text. Each bullet or paragraph becomes one entry, under its heading.',
    accept: '.md,.txt,.markdown',
  },
];

type TargetKey = 'user' | 'agents' | `notebook:${string}`;
const targetOf = (k: TargetKey): MemoryImportTarget =>
  k === 'user'
    ? { kind: 'user' }
    : k === 'agents'
      ? { kind: 'agents' }
      : { kind: 'notebook', notebook_id: k.slice(9) };

const errorText = (e: unknown) =>
  e instanceof ApiCallError
    ? `${e.body.error.title}. ${e.body.error.hint}`
    : 'Check NVX Ancile is running, then try again.';

/* ---- export ------------------------------------------------------------------------ */

function ExportPanel() {
  const plan = useExportPlan();
  const [format, setFormat] = useState<MemoryExportFormat>('zip');
  const [notebook, setNotebook] = useState('');
  const [leaveOut, setLeaveOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const scopeId = useId();
  const privateId = useId();
  const withMemory = (plan.data?.notebooks ?? []).filter((n) => n.exists);
  const privates = withMemory.filter((n) => n.private);
  const chosen = withMemory.find((n) => n.id === notebook);
  const holdsPrivate = chosen ? chosen.private : privates.length > 0 && !(leaveOut && format !== 'bundle');

  const save = async () => {
    setBusy(true);
    try {
      const name = await downloadExport({ format, notebookId: notebook || null, leaveOutPrivate: leaveOut });
      notify({
        level: 'success',
        title: 'Memory exported',
        body: `${name} is in your downloads. Nothing was uploaded.`,
      });
    } catch (e) {
      failed(e, 'The export');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mem-move__card" aria-labelledby="mem-export-title">
      <header className="mem-move__head">
        <span className="mem-move__glyph" aria-hidden="true">
          <Icon name="download" size={16} />
        </span>
        <div>
          <h3 id="mem-export-title" className="mem-move__title">
            Export
          </h3>
          <p className="mute mem-move__lede">
            Made on this computer and saved where you choose. Nothing is uploaded.
            {plan.data ? ` ${plan.data.files} files, ${plan.data.entries} entries.` : ''}
          </p>
        </div>
      </header>
      {plan.isPending ? (
        <Skeleton lines={2} label="Reading memory" />
      ) : (
        <>
          <Segmented
            label="Export as"
            value={format}
            size="sm"
            onChange={setFormat}
            options={FORMATS.map((f) => ({ value: f.value, label: f.label }))}
          />
          <p className="mute mem-move__hint">{FORMATS.find((f) => f.value === format)?.desc}</p>
          <div className="mem-move__row">
            <label htmlFor={scopeId}>What to export</label>
            <select
              id={scopeId}
              className="input input--sm"
              value={notebook}
              onChange={(e) => setNotebook(e.target.value)}
            >
              <option value="">All of memory</option>
              {withMemory.map((n) => (
                <option key={n.id} value={n.id} disabled={format === 'bundle'}>
                  {n.title}
                  {n.private ? ' (private)' : ''}
                </option>
              ))}
            </select>
          </div>
          {!notebook && privates.length ? (
            <div className="mem-move__row">
              <span id={privateId}>
                Leave out private notebooks ({privates.length})
                {format === 'bundle' ? (
                  <span className="mute"> · a git bundle always holds everything</span>
                ) : null}
              </span>
              <Switch
                label="Leave out private notebooks"
                checked={leaveOut && format !== 'bundle'}
                disabled={format === 'bundle'}
                describedBy={privateId}
                onChange={setLeaveOut}
              />
            </div>
          ) : null}
          {holdsPrivate ? (
            <p className="mem-move__note" role="note">
              <Icon name="lock" size={12} /> This export holds memory from a private notebook. Keep the file
              somewhere private.
            </p>
          ) : null}
          <div className="mem-move__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void save()}
              disabled={busy}
            >
              <Icon name="download" size={14} />
              {busy ? 'Exporting…' : 'Save export'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/* ---- import: choose and preview -------------------------------------------------------- */

function ImportPanel({ onCreated }: { onCreated: (id: string) => void }) {
  const plan = useExportPlan();
  const [origin, setOrigin] = useState<MemoryImportOrigin>('chatgpt');
  const [target, setTarget] = useState<TargetKey>('user');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Pick<MemoryImportRequest, 'text' | 'data_base64' | 'filename'> | null>(
    null,
  );
  const [preview, setPreview] = useState<MemoryImportPreview | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const create = useCreateImport();
  const targetId = useId();
  const pasteId = useId();
  const how = ORIGINS.find((o) => o.value === origin) as (typeof ORIGINS)[number];

  const request = (): MemoryImportRequest | null => {
    const src = picked ?? (text.trim() ? { text } : null);
    if (!src) return null;
    return {
      origin,
      ...src,
      ...(origin !== 'ancile' && { target: targetOf(target) }),
    } as MemoryImportRequest;
  };

  const reset = () => {
    setPreview(null);
    setProblem(null);
  };

  const look = async () => {
    const req = request();
    if (!req) return;
    setBusy(true);
    setProblem(null);
    try {
      const p = await previewImport(req);
      setPreview(p);
      setTicked(new Set(p.items.filter((i) => i.status === 'new' && !i.flag).map((i) => i.index)));
    } catch (e) {
      setPreview(null);
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const req = request();
    if (!req) return;
    create.mutate(
      { ...req, include: [...ticked].sort((a, b) => a - b) },
      {
        onSuccess: (v) => {
          notify({
            level: 'success',
            title: `${v.counts.proposed} suggestions to review`,
            body: 'Nothing is in memory yet: accept the ones you want below.',
          });
          setPreview(null);
          setPicked(null);
          setText('');
          onCreated(v.id);
        },
        onError: (e) => setProblem(errorText(e)),
      },
    );
  };

  const notebooks = plan.data?.notebooks ?? [];

  return (
    <section className="mem-move__card" aria-labelledby="mem-import-title">
      <header className="mem-move__head">
        <span className="mem-move__glyph" aria-hidden="true">
          <Icon name="upload" size={16} />
        </span>
        <div>
          <h3 id="mem-import-title" className="mem-move__title">
            Import
          </h3>
          <p className="mute mem-move__lede">
            Bring in what another tool remembered. Everything comes in as a suggestion: nothing is kept until
            you accept it.
          </p>
        </div>
      </header>
      <Segmented
        label="Import from"
        value={origin}
        size="sm"
        onChange={(v) => {
          setOrigin(v);
          setPicked(null);
          reset();
        }}
        options={ORIGINS.map((o) => ({ value: o.value, label: o.label }))}
      />
      <p className="mute mem-move__hint">{how.how}</p>
      {origin !== 'ancile' ? (
        <div className="mem-move__row">
          <label htmlFor={targetId}>Put it in</label>
          <select
            id={targetId}
            className="input input--sm"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value as TargetKey);
              reset();
            }}
          >
            <option value="user">About you (USER.md)</option>
            <option value="agents">House rules for every model (AGENTS.md)</option>
            {notebooks.map((n) => (
              <option key={n.id} value={`notebook:${n.id}`}>
                Notebook: {n.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="mem-move__source">
        <input
          ref={file}
          type="file"
          className="sr-only"
          accept={how.accept}
          aria-label="Choose a file to import"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            reset();
            setPicked(await readPicked(f));
          }}
        />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => file.current?.click()}>
          <Icon name="file" size={14} />
          {picked?.filename ? 'Choose another file' : 'Choose a file'}
        </button>
        {picked?.filename ? (
          <span className="mem-move__picked">
            {picked.filename}
            <button
              type="button"
              className="icon-btn"
              aria-label={`Forget ${picked.filename}`}
              onClick={() => {
                setPicked(null);
                reset();
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ) : origin !== 'ancile' ? (
          <span className="mute">or paste below</span>
        ) : null}
      </div>
      {!picked && origin !== 'ancile' ? (
        <>
          <label htmlFor={pasteId} className="sr-only">
            Paste what to import
          </label>
          <textarea
            id={pasteId}
            className="input mem-move__paste"
            rows={5}
            placeholder={
              origin === 'chatgpt'
                ? 'Prefers metric units.\nWorks as a structural engineer.'
                : '- One idea per line'
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              reset();
            }}
          />
        </>
      ) : null}
      {problem ? (
        <p className="mem-move__problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="mem-move__actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void look()}
          disabled={busy || !request()}
        >
          <Icon name="eye" size={14} />
          {busy ? 'Reading…' : 'Preview'}
        </button>
      </div>
      {preview ? (
        <PreviewList
          preview={preview}
          ticked={ticked}
          setTicked={setTicked}
          onAdd={add}
          adding={create.isPending}
        />
      ) : null}
    </section>
  );
}

const STATUS_WORDS = { duplicate: 'Already in memory', repeated: 'Repeated above', new: '' } as const;

function PreviewList({
  preview,
  ticked,
  setTicked,
  onAdd,
  adding,
}: {
  preview: MemoryImportPreview;
  ticked: Set<number>;
  setTicked: (s: Set<number>) => void;
  onAdd: () => void;
  adding: boolean;
}) {
  const toggle = (i: number, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(i);
    else next.delete(i);
    setTicked(next);
  };
  const byFile = useMemo(() => {
    const m = new Map<string, typeof preview.items>();
    for (const i of preview.items) m.set(i.target_path, [...(m.get(i.target_path) ?? []), i]);
    return [...m];
  }, [preview]);
  if (!preview.items.length)
    return (
      <p className="mem-move__empty" role="status">
        No entries were found. Memory imports read bullets and paragraphs of text.
      </p>
    );
  return (
    <section className="mem-move__preview" aria-label="What would be imported">
      <p className="mem-move__count" role="status">
        <strong data-num>{ticked.size}</strong> of <span data-num>{preview.items.length}</span> ticked from{' '}
        {preview.filename ?? preview.label}
        {preview.skipped ? <span className="mute"> · {preview.skipped} lines left out</span> : null}
      </p>
      {preview.notes.length ? (
        <ul className="mem-move__notes">
          {preview.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {byFile.map(([path, items]) => (
        <div key={path} className="mem-move__file">
          <h4 className="mem-move__path">
            <Icon name="memory" size={12} /> {path}
            {preview.files.find((f) => f.path === path)?.exists ? null : (
              <span className="tag">New file</span>
            )}
          </h4>
          <ul className="mem-move__items">
            {items.map((i) => (
              <li key={i.index} className="mem-move__item" data-status={i.status}>
                <Check
                  checked={ticked.has(i.index)}
                  onChange={(on) => toggle(i.index, on)}
                  label={`Import: ${i.text}`}
                />
                <span className="mem-move__text">
                  <span className="mem-move__diff" aria-hidden="true">
                    +
                  </span>
                  {i.text}
                  <span className="mute mem-move__section"> · {i.section}</span>
                  {i.status !== 'new' ? <span className="tag">{STATUS_WORDS[i.status]}</span> : null}
                  {i.clipped ? <span className="tag">Cut to 600 characters</span> : null}
                  {i.flag ? <span className="mem-move__flag">{i.flag}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="mem-move__actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() =>
            setTicked(new Set(preview.items.filter((i) => i.status === 'new' && !i.flag).map((i) => i.index)))
          }
        >
          Tick new only
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={onAdd}
          disabled={!ticked.size || adding}
        >
          {adding ? 'Adding…' : `Add ${ticked.size} for review`}
        </button>
      </div>
    </section>
  );
}

/* ---- import: review -------------------------------------------------------------------- */

export function ImportReview({ id, onClose }: { id: string; onClose: () => void }) {
  const view = useImport(id);
  const decide = useDecideImport(id);
  const undo = useDecide();
  const [skip, setSkip] = useState<Set<string>>(new Set());
  if (view.isPending) return <Skeleton lines={3} label="Loading the import" />;
  if (!view.data) return null;
  const v = view.data;
  const waiting = v.proposals.filter((p) => p.status === 'proposed');
  const applied = v.proposals.filter((p) => p.status === 'applied');
  const chosen = waiting.filter((p) => !skip.has(p.id));

  const commit = (accept: 'all' | string[]) =>
    decide.mutate(
      { accept, reject: 'rest' },
      {
        onSuccess: (r) =>
          notify({
            level: 'success',
            title: r.applied
              ? `${r.applied} ${r.applied === 1 ? 'entry' : 'entries'} added to memory`
              : 'Import closed',
            body: r.applied ? 'In one commit, so one Undo takes them all back.' : 'Nothing was added.',
            ...(r.applied && r.import.proposals.find((p) => p.status === 'applied')
              ? {
                  undo: () =>
                    undo.mutate({
                      id: (r.import.proposals.find((p) => p.status === 'applied') as MemoryProposal).id,
                      decision: 'undo',
                    }),
                }
              : {}),
          }),
        onError: (e) => failed(e, 'Accepting the import'),
      },
    );

  return (
    <section className="mem-move__card mem-move__review" aria-labelledby="mem-review-title">
      <header className="mem-move__head">
        <span className="mem-move__glyph" aria-hidden="true">
          <Icon name="inbox" size={16} />
        </span>
        <div>
          <h3 id="mem-review-title" className="mem-move__title">
            Review: {v.filename ?? v.label}
          </h3>
          <p className="mute mem-move__lede">
            {v.status === 'reviewing'
              ? `${waiting.length} waiting. Untick any you do not want, then accept.`
              : `${v.counts.applied} accepted, ${v.counts.rejected} left out${v.counts.undone ? `, ${v.counts.undone} undone` : ''}.`}
          </p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close the review" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <ul className="mem-move__items">
        {v.proposals.map((p) => (
          <li key={p.id} className="mem-move__item" data-status={p.status}>
            {p.status === 'proposed' ? (
              <Check
                checked={!skip.has(p.id)}
                onChange={(on) => {
                  const next = new Set(skip);
                  if (on) next.delete(p.id);
                  else next.add(p.id);
                  setSkip(next);
                }}
                label={`Accept: ${p.text}`}
              />
            ) : (
              <span className="mem-move__state">
                {p.status === 'applied' ? 'Added' : p.status === 'undone' ? 'Undone' : 'Left out'}
              </span>
            )}
            <span className="mem-move__text">
              {p.text}
              <span className="mute mem-move__section">
                {' '}
                · {p.target_path} · {p.section}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {waiting.length ? (
        <div className="mem-move__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => commit([])}
            disabled={decide.isPending}
          >
            Leave all out
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => commit(chosen.map((p) => p.id))}
            disabled={decide.isPending || !chosen.length || chosen.length === waiting.length}
          >
            Accept {chosen.length} ticked
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => commit('all')}
            disabled={decide.isPending}
          >
            Accept all {waiting.length}
          </button>
        </div>
      ) : applied.length ? (
        <div className="mem-move__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => undo.mutate({ id: (applied[0] as MemoryProposal).id, decision: 'undo' })}
            disabled={undo.isPending}
          >
            <Icon name="undo" size={14} />
            Undo this import
          </button>
        </div>
      ) : null}
    </section>
  );
}

/* ---- the tab ------------------------------------------------------------------------- */

export function MemoryTransfer() {
  const imports = useImports();
  const [open, setOpen] = useState<string | null>(null);
  const waiting = (imports.data?.items ?? []).filter((i) => i.status === 'reviewing');
  return (
    <div className="mem-move">
      {open ? <ImportReview id={open} onClose={() => setOpen(null)} /> : null}
      {waiting.length && !open ? (
        <section className="mem-move__card" aria-label="Imports waiting for review">
          <h3 className="mem-move__title">Waiting for review</h3>
          <ul className="mem-move__items">
            {waiting.map((i) => (
              <li key={i.id} className="mem-move__item">
                <span className="mem-move__text">
                  {i.filename ?? i.label} <span className="mute">· {i.counts.proposed} suggestions</span>
                </span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(i.id)}>
                  Review
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="mem-move__grid">
        <ImportPanel onCreated={setOpen} />
        <ExportPanel />
      </div>
    </div>
  );
}
