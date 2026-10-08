/**
 * ------------------------------------------------------------------
 *  Title    |  Memory browser
 *  Ref      |  DESIGN.md §6.1, §6.2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The files NVX Ancile remembers with, grouped by what
 *           |  they are for, and each file read as what it is: a list
 *           |  of things kept, with when and how sure.
 *  How      |  A file list on the left (arrow keys move, Enter opens),
 *           |  the open file on the right as entries, or in the editor.
 *           |  Entries learned by NVX Ancile wear the gilt seal: they
 *           |  are kept. Earlier beliefs fold away under the live ones.
 * ------------------------------------------------------------------
 */

import type { MemoryEntryView, MemoryFileSummary, MemoryKind } from '@nvx/contracts';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { relative } from '../lib/format';
import { Icon, type IconName } from '../ui/Icon';
import { EmptyState, Skeleton } from '../ui/primitives';
import { useMemoryFile, useMemoryFiles, useMemoryUi } from './api';
import { FileHistory } from './History';
import { MemoryEditor } from './MemoryEditor';

const GROUPS: { kind: MemoryKind; label: string; icon: IconName; blurb: string }[] = [
  { kind: 'agents', label: 'House rules', icon: 'shield', blurb: 'For every model. Only you change these.' },
  { kind: 'user', label: 'About you', icon: 'user', blurb: 'Preferences learned from your corrections.' },
  { kind: 'projects', label: 'Notebooks', icon: 'notebook', blurb: 'Decisions and findings per notebook.' },
  { kind: 'failures', label: 'Lessons', icon: 'zap', blurb: 'What went wrong, and what fixed it.' },
  { kind: 'models', label: 'Models', icon: 'model', blurb: 'Quirks of each model, learned in use.' },
  { kind: 'other', label: 'Other files', icon: 'file', blurb: 'Anything else in the folder.' },
];

const isGuide = (path: string) => /(^|\/)(README|_template)\.md$/i.test(path);

function FileRow({ f, active, onOpen }: { f: MemoryFileSummary; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="mem-file"
      data-active={active || undefined}
      data-guide={isGuide(f.path) || undefined}
      onClick={onOpen}
      aria-current={active || undefined}
    >
      <span className="mem-file__name">{f.title}</span>
      <span className="mem-file__path" data-num>
        {f.path}
      </span>
      <span className="mem-file__count" data-num title={`${f.entries} entries`}>
        {f.entries || ''}
      </span>
    </button>
  );
}

export function MemoryBrowser() {
  const files = useMemoryFiles();
  const path = useMemoryUi((s) => s.path);
  const open = useMemoryUi((s) => s.open);
  const listRef = useRef<HTMLDivElement>(null);
  const items = files.data?.items;
  const current = path ?? items?.find((f) => f.path === 'USER.md')?.path ?? items?.[0]?.path ?? null;

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        files: (items ?? [])
          .filter((f) => f.kind === g.kind)
          .sort((a, b) => Number(isGuide(a.path)) - Number(isGuide(b.path)) || a.path.localeCompare(b.path)),
      })).filter((g) => g.files.length > 0),
    [items],
  );

  // Arrow keys walk the files; the focus moves with the selection.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const flat = grouped.flatMap((g) => g.files.map((f) => f.path));
    const i = flat.indexOf(current ?? '');
    const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    open(next);
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLButtonElement>('.mem-file[data-active]')?.focus(),
    );
  };

  if (files.isPending) return <Skeleton lines={6} label="Loading memory" />;
  if (files.isError)
    return (
      <EmptyState
        icon="memory"
        title="Memory could not be read"
        body="Core could not open the memory folder. Health shows why; git must be installed."
      />
    );

  return (
    <div className="mem-browser">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow-key navigation over the buttons inside */}
      <div className="mem-files" ref={listRef} onKeyDown={onKey}>
        {grouped.map((g) => (
          <section key={g.kind} className="mem-files__group" aria-label={g.label}>
            <h3 className="mem-files__h" title={g.blurb}>
              <Icon name={g.icon} size={12} />
              {g.label}
            </h3>
            {g.files.map((f) => (
              <FileRow key={f.path} f={f} active={f.path === current} onOpen={() => open(f.path)} />
            ))}
          </section>
        ))}
      </div>
      {current ? (
        <FilePane key={current} path={current} summary={items?.find((f) => f.path === current)} />
      ) : null}
    </div>
  );
}

type Mode = 'read' | 'edit' | 'history';

function FilePane({ path, summary }: { path: string; summary: MemoryFileSummary | undefined }) {
  const file = useMemoryFile(path);
  const [mode, setMode] = useState<Mode>('read');
  const [showOld, setShowOld] = useState(false);

  const live = file.data?.entries.filter((e) => !e.superseded) ?? [];
  const old = file.data?.entries.filter((e) => e.superseded) ?? [];
  const sections = useMemo(() => {
    const m = new Map<string, MemoryEntryView[]>();
    for (const e of live) m.set(e.section ?? '', [...(m.get(e.section ?? '') ?? []), e]);
    return [...m];
  }, [live]);

  return (
    <article className="mem-pane" aria-label={summary?.title ?? path}>
      <header className="mem-pane__head">
        <div className="mem-pane__title">
          <h2 data-display>{summary?.title ?? path}</h2>
          <p className="mute">
            <span data-num>{path}</span>
            {summary ? <> · changed {relative(summary.updated_at)}</> : null}
            {summary && !summary.auto ? <> · only you edit this file</> : null}
          </p>
        </div>
        <div className="mem-pane__modes segmented" role="tablist" aria-label="View">
          {(
            [
              ['read', 'Entries', 'memory'],
              ['edit', 'Edit', 'edit'],
              ['history', 'History', 'clock'],
            ] as const
          ).map(([m, label, icon]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              data-state={mode === m ? 'checked' : undefined}
              className="segmented__opt"
              onClick={() => setMode(m)}
            >
              <Icon name={icon} size={13} />
              {label}
            </button>
          ))}
        </div>
      </header>

      {file.isPending ? <Skeleton lines={5} label="Loading the file" /> : null}

      {file.data && mode === 'edit' ? <MemoryEditor file={file.data} onDone={() => setMode('read')} /> : null}

      {mode === 'history' ? <FileHistory path={path} /> : null}

      {file.data && mode === 'read' ? (
        live.length === 0 ? (
          <EmptyState
            icon="memory"
            title={isGuide(path) ? 'A guide, not memory' : 'Nothing kept here yet'}
            body={
              isGuide(path)
                ? 'This file explains the folder. NVX Ancile never injects it.'
                : 'Entries appear as NVX Ancile learns, or write your own: one idea per bullet.'
            }
            action={{ label: 'Edit the file', onClick: () => setMode('edit') }}
          />
        ) : (
          <div className="mem-entries">
            {sections.map(([section, es]) => (
              <section key={section} className="mem-entries__section">
                {section ? <h3 className="mem-entries__h">{section}</h3> : null}
                <ul>
                  {es.map((e, i) => (
                    <Entry key={e.key} e={e} i={i} />
                  ))}
                </ul>
              </section>
            ))}
            {old.length ? (
              <section className="mem-entries__section mem-entries__old">
                <button
                  type="button"
                  className="link-btn link-btn--quiet"
                  aria-expanded={showOld}
                  onClick={() => setShowOld((v) => !v)}
                >
                  <Icon name={showOld ? 'chevronDown' : 'chevronRight'} size={12} />
                  {old.length} earlier {old.length === 1 ? 'belief' : 'beliefs'}, kept for the record
                </button>
                {showOld ? (
                  <ul>
                    {old.map((e, i) => (
                      <Entry key={e.key} e={e} i={i} />
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </div>
        )
      ) : null}
    </article>
  );
}

function Entry({ e, i }: { e: MemoryEntryView; i: number }) {
  const learned = e.confidence !== null || (e.src !== null && e.src !== 'onboarding');
  return (
    <li
      className="mem-entry"
      data-superseded={e.superseded || undefined}
      data-learned={learned || undefined}
      style={{ ['--i' as string]: Math.min(i, 12) }}
    >
      {learned && !e.superseded ? (
        <span className="mem-entry__seal" title="Learned and kept by NVX Ancile">
          <Icon name="seal" size={13} />
        </span>
      ) : (
        <span className="mem-entry__dot" aria-hidden="true" />
      )}
      <span className="mem-entry__text">{e.text.replace(/\*\*/g, '')}</span>
      <span className="mem-entry__meta">
        {e.confidence !== null ? (
          <span className="mem-conf" title={`Confidence ${Math.round(e.confidence * 100)}%`}>
            <span className="mem-conf__fill" style={{ width: `${Math.round(e.confidence * 100)}%` }} />
          </span>
        ) : null}
        {e.at ? <time data-num>{e.at}</time> : null}
      </span>
    </li>
  );
}
