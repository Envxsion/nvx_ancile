/**
 * ------------------------------------------------------------------
 *  Title    |  Source card
 *  Ref      |  ROADMAP.md Phase 3 · DESIGN.md §13.3 (progress means)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One source, honestly: what it is, what is happening to
 *           |  it in words ("Reading page 14 of 52"), what went wrong
 *           |  and how to fix it, whether it duplicates another, and
 *           |  how much of it a question may use.
 *  How      |  Click opens the viewer. The context level is a sliding
 *           |  three-way control. Everything else is in the menu (or
 *           |  right-click): rename edits the title in place; remove
 *           |  takes it out of this notebook (with Undo); delete takes
 *           |  it out of the workspace, after a confirm.
 * ------------------------------------------------------------------
 */

import { useMutation } from '@tanstack/react-query';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { Hint } from '../help/Hint';
import { relative } from '../lib/format';
import {
  deleteSource,
  dismissDuplicate,
  mergeSources,
  refetchSource,
  removeSource,
  renameSource,
  retrySource,
  setContextLevel,
} from '../lib/notebooks';
import type { SourceView } from '../lib/types';
import { useUi } from '../state/ui';
import { ConfirmDialog } from '../ui/Confirm';
import { Segmented } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';
import { ContextMenu, DropMenu, type MenuEntry } from '../ui/Menu';

export const KIND_ICON: Record<SourceView['kind'], IconName> = {
  file: 'file',
  url: 'globe',
  text: 'text',
  thread: 'thread',
};

const WORKING = new Set(['queued', 'extracting', 'enriching', 'embedding']);

function fileKind(s: SourceView): string {
  if (s.kind === 'url') {
    try {
      return new URL(s.uri ?? '').hostname.replace(/^www\./, '');
    } catch {
      return 'Link';
    }
  }
  if (s.kind === 'text') return 'Pasted text';
  if (s.kind === 'thread') return 'Past thread';
  const ext = (s.uri ?? s.title).split('.').pop()?.toUpperCase();
  return ext && ext.length <= 5 ? ext : 'File';
}

export function SourceCard({
  s,
  notebookId,
  compact,
}: {
  s: SourceView;
  notebookId: string;
  compact?: boolean;
}) {
  const openViewer = useUi((s) => s.openViewer);
  const [merging, setMerging] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rename = useMutation({
    mutationFn: (title: string) => renameSource(s.id, title),
  });
  const working = WORKING.has(s.status);
  const failed = s.status === 'failed';

  const items: MenuEntry[] = [
    {
      label: 'Open',
      icon: 'eye',
      disabled: working || failed,
      onSelect: () => openViewer({ sourceId: s.id }),
    },
    ...(s.kind === 'url' && s.uri
      ? [
          {
            label: 'Open the page',
            icon: 'ext' as IconName,
            onSelect: () => window.open(s.uri ?? '', '_blank', 'noopener'),
          },
          {
            label: 'Fetch again',
            icon: 'regenerate' as IconName,
            onSelect: () => void refetchSource(notebookId, s.id),
          },
        ]
      : []),
    ...(s.kind === 'file'
      ? [
          {
            label: 'Open the original',
            icon: 'download' as IconName,
            onSelect: () => window.open(`/api/v1/sources/${s.id}/file`, '_blank', 'noopener'),
          },
        ]
      : []),
    ...(failed
      ? [
          {
            label: 'Try again',
            icon: 'regenerate' as IconName,
            onSelect: () => void retrySource(notebookId, s.id),
          },
        ]
      : []),
    {
      label: 'Rename',
      icon: 'edit',
      onSelect: () => setRenaming(true),
    },
    {
      label: 'Copy its title',
      icon: 'copy',
      onSelect: () => void navigator.clipboard?.writeText(s.title),
    },
    { kind: 'separator' },
    {
      label: 'Remove from notebook',
      icon: 'minus',
      onSelect: () => void removeSource(notebookId, s),
    },
    {
      label: 'Delete source',
      icon: 'trash',
      danger: true,
      onSelect: () => setConfirmDelete(true),
    },
  ];

  return (
    <ContextMenu items={items}>
      <article
        className="source-card"
        data-status={s.status}
        data-compact={compact || undefined}
        style={s.progress != null ? ({ '--p': s.progress } as CSSProperties) : undefined}
      >
        {renaming ? (
          <RenameField
            title={s.title}
            onDone={(next) => {
              setRenaming(false);
              if (next) rename.mutate(next);
            }}
          />
        ) : (
          <button
            type="button"
            className="source-card__main"
            onClick={() => !working && !failed && openViewer({ sourceId: s.id })}
            disabled={working || failed}
            aria-label={`${s.title}. ${s.detail}`}
          >
            <span className="source-card__icon" data-kind={s.kind}>
              <Icon name={KIND_ICON[s.kind]} size={15} />
            </span>
            <span className="source-card__text">
              <span className="source-card__title" dir="auto">
                {s.title}
              </span>
              <span className="source-card__meta">
                <span>{fileKind(s)}</span>
                <span aria-hidden="true">·</span>
                <span className="source-card__detail">{s.detail}</span>
                {s.createdAt && !working ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{relative(s.createdAt)}</span>
                  </>
                ) : null}
              </span>
            </span>
          </button>
        )}
        <DropMenu
          items={items}
          trigger={
            <button
              type="button"
              className="icon-btn icon-btn--xs source-card__more"
              aria-label={`More for ${s.title}`}
            >
              <Icon name="more" size={14} />
            </button>
          }
        />

        {working ? (
          <div
            className="source-card__progress"
            role="progressbar"
            aria-label={s.detail}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={s.progress != null ? Math.round(s.progress * 100) : undefined}
          >
            <span className="source-card__bar" data-indeterminate={s.progress == null || undefined} />
          </div>
        ) : null}

        {failed && s.error ? (
          <div className="source-card__error" role="alert">
            <p>{s.error.hint}</p>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void retrySource(notebookId, s.id)}
            >
              <Icon name="regenerate" size={12} />
              Try again
            </button>
          </div>
        ) : null}

        {s.status === 'stale' ? (
          <div className="source-card__note">
            <Icon name="warn" size={12} />
            <span>The page has changed since NVX Ancile read it.</span>
            <button type="button" className="link-btn" onClick={() => void refetchSource(notebookId, s.id)}>
              Fetch it again
            </button>
          </div>
        ) : null}

        {s.duplicateOf ? (
          <div className="source-card__dup">
            <Icon name="merge" size={12} />
            <span>
              {s.duplicateOf.kind === 'new_version'
                ? 'A newer version of '
                : s.duplicateOf.kind === 'duplicate'
                  ? 'The same as '
                  : 'Very like '}
              <strong>{s.duplicateOf.title}</strong>
            </span>
            {merging ? (
              <span className="mute">Merging…</span>
            ) : (
              <>
                <button
                  type="button"
                  className="link-btn"
                  onClick={async () => {
                    setMerging(true);
                    const keepNew = s.duplicateOf?.kind === 'new_version';
                    await mergeSources(
                      notebookId,
                      keepNew ? s.id : (s.duplicateOf?.sourceId ?? ''),
                      keepNew ? (s.duplicateOf?.sourceId ?? '') : s.id,
                    );
                    setMerging(false);
                  }}
                >
                  {s.duplicateOf.kind === 'new_version' ? 'Replace it' : 'Merge'}
                </button>
                <button
                  type="button"
                  className="link-btn link-btn--quiet"
                  onClick={() => void dismissDuplicate(notebookId, s.id, s.duplicateOf?.sourceId ?? '')}
                >
                  Keep both
                </button>
              </>
            )}
          </div>
        ) : null}

        {!compact && !working && !failed ? (
          <div className="source-card__level">
            <span className="source-card__level-label">
              Questions use
              <Hint id="context-level" title="What a question can use" article="context-levels">
                Full lets any passage be found and cited. Summary uses only the source's summary. Off keeps it
                in the notebook but out of answers.
              </Hint>
            </span>
            <Segmented
              label={`What questions can use from ${s.title}`}
              size="sm"
              value={s.contextLevel}
              onChange={(v) => void setContextLevel(notebookId, s.id, v)}
              options={[
                { value: 'full', label: 'Full' },
                { value: 'insights', label: 'Summary' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </div>
        ) : null}
        <ConfirmDialog
          copy={
            confirmDelete
              ? {
                  title: `Delete source ${s.title}?`,
                  body: 'It leaves every notebook that uses it, and search and answers stop finding it. Answers that already cite it keep their citations. To keep it in other notebooks, choose Remove from notebook instead.',
                  action: 'Delete source',
                }
              : null
          }
          onConfirm={() => void deleteSource(s)}
          onClose={() => setConfirmDelete(false)}
        />
      </article>
    </ContextMenu>
  );
}

/** The title, editable in place. Enter or leaving the field saves; Escape keeps the old one. */
function RenameField({ title, onDone }: { title: string; onDone: (next: string | null) => void }) {
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => ref.current?.select(), []);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next?.trim() && next.trim() !== title ? next.trim() : null);
  };
  return (
    <div className="source-card__rename">
      <input
        ref={ref}
        className="input input--sm"
        value={value}
        maxLength={400}
        aria-label="Source title"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(value);
          if (e.key === 'Escape') finish(null);
          e.stopPropagation();
        }}
      />
    </div>
  );
}
