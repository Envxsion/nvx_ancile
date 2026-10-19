/**
 * ------------------------------------------------------------------
 *  Title    |  Bulk bar
 *  Ref      |  ROADMAP TC4 · guard rail GR23
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Once threads are selected in the rail, a bar floats
 *           |  over its foot with what you can do to all of them:
 *           |  move, archive, delete, export. One action, one
 *           |  notice, one Undo.
 *  How      |  Loaded on demand (the empty shell never draws it).
 *           |  A toolbar: Tab reaches it, arrow keys move along it.
 *           |  Delete moves threads to the Trash, so it asks nothing
 *           |  and says how to undo; a thread being answered is left
 *           |  alone and named in the notice.
 * ------------------------------------------------------------------
 */

import { m as motion } from 'motion/react';
import { type KeyboardEvent, useRef } from 'react';
import { fetchThreadTail } from '../lib/threadPages';
import { archiveThreads, deleteThreads, moveThreads, threadMarkdown } from '../lib/threads';
import type { NotebookView } from '../lib/types';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';

/** The latest messages of each selected thread, as one markdown file. */
async function exportMany(ids: string[]): Promise<void> {
  const parts: string[] = [];
  let failed = 0;
  for (const id of ids) {
    try {
      parts.push(threadMarkdown(await fetchThreadTail(id)));
    } catch {
      failed++;
    }
  }
  if (parts.length === 0) {
    notify({
      level: 'error',
      title: 'Nothing was exported',
      body: 'The threads could not be read. Check that NVX Ancile is running, then try again.',
    });
    return;
  }
  const blob = new Blob([parts.join('\n\n---\n\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ancile-threads-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  notify({
    level: failed ? 'warn' : 'success',
    title: `Exported ${parts.length} ${parts.length === 1 ? 'thread' : 'threads'}`,
    body: failed
      ? `${failed} could not be read and are not in the file.`
      : `${a.download} is in your downloads. Each thread is its latest messages.`,
  });
}

export function BulkBar({
  ids,
  notebooks,
  onClear,
}: {
  ids: string[];
  notebooks: NotebookView[];
  onClear: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const n = ids.length;
  const noun = n === 1 ? 'thread' : 'threads';

  const moveItems: MenuEntry[] = [
    ...notebooks
      .filter((nb) => !nb.archived)
      .map((nb) => ({ label: nb.title, onSelect: () => void moveThreads(ids, nb.id, nb.title) })),
    ...(notebooks.length === 0
      ? [{ label: 'No notebooks yet', disabled: true, onSelect: () => {} }]
      : [{ kind: 'separator' } as const]),
    { label: 'Out of their notebooks', onSelect: () => void moveThreads(ids, null) },
  ];

  // A toolbar is one Tab stop; the arrow keys walk its buttons.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClear();
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const buttons = [...(bar.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    buttons[(at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  return (
    <motion.div
      ref={bar}
      className="bulkbar"
      role="toolbar"
      aria-label={`Actions for ${n} selected ${noun}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.2, ease: [0.19, 1, 0.22, 1] }}
      onKeyDown={onKey}
    >
      <span className="bulkbar__count" data-num>
        {n} selected
      </span>
      <DropMenu
        items={moveItems}
        trigger={
          <button type="button" className="bulkbar__btn" aria-haspopup="menu">
            <Icon name="notebook" size={13} />
            Move
          </button>
        }
      />
      <button type="button" className="bulkbar__btn" onClick={() => void archiveThreads(ids)}>
        <Icon name="archive" size={13} />
        Archive
      </button>
      <button type="button" className="bulkbar__btn" onClick={() => void exportMany(ids)}>
        <Icon name="download" size={13} />
        Export
      </button>
      <button
        type="button"
        className="bulkbar__btn bulkbar__btn--danger"
        onClick={() => void deleteThreads(ids)}
      >
        <Icon name="trash" size={13} />
        Delete
      </button>
      <button type="button" className="icon-btn icon-btn--xs" aria-label="Clear selection" onClick={onClear}>
        <Icon name="close" size={11} />
      </button>
    </motion.div>
  );
}
