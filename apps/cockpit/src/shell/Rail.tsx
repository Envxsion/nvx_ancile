/**
 * ------------------------------------------------------------------
 *  Title    |  Rail
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything you have, in the order you reach for it:
 *           |  pinned, notebooks, then threads by when you last worked
 *           |  in them. Filter as you type, rename in place, pin,
 *           |  archive, move or delete from a right-click.
 *  How      |  One flat cursor across the visible rows so j/k never
 *           |  sticks at a heading, live only while focus is in the
 *           |  rail (Enter elsewhere is not "open the first thread").
 *           |  The active row's plate slides between rows on a spring.
 *           |  More threads load as the list nears its end.
 *  Note     |  Under 820 px the rail is an overlay: it closes itself
 *           |  once you pick something.
 * ------------------------------------------------------------------
 */

import { spring } from '@nvx/aperture';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { motion } from 'motion/react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Checklist } from '../help/Checklist';
import { useBinding } from '../keys/dispatch';
import { threadQuery, useArchivedThreads, useNotebooks, useThreads } from '../lib/data';
import { hueVar, relative } from '../lib/format';
import { deleteThread, moveThread, renameThread, setArchived, setPinned } from '../lib/threads';
import type { Hue, NotebookView, ThreadSummary } from '../lib/types';
import { useMediaQuery } from '../lib/useMediaQuery';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { ContextMenu, DropMenu, type MenuEntry } from '../ui/Menu';
import { Kbd, Skeleton, Tip } from '../ui/primitives';
import { NewNotebook } from './NewNotebook';

type Row = { kind: 'notebook' | 'thread'; id: string };

const DAY = 86_400_000;
function bucket(iso: string, now: number): string {
  const d = new Date(iso);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const t = d.getTime();
  if (t >= start.getTime()) return 'Today';
  if (t >= start.getTime() - DAY) return 'Yesterday';
  if (t >= start.getTime() - 6 * DAY) return 'Previous 7 days';
  if (t >= start.getTime() - 29 * DAY) return 'Previous 30 days';
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Threads with an unsent draft, read once per render of the list. */
function useDraftIds(threads: ThreadSummary[] | undefined): Set<string> {
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read storage whenever the list changes
  return useMemo(() => {
    const ids = new Set<string>();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('nvx.ancile.draft:') && localStorage.getItem(k)) ids.add(k.split(':')[1] ?? '');
      }
    } catch {
      /* storage blocked */
    }
    return ids;
  }, [threads]);
}

function ActivePlate() {
  return <motion.span className="rail__plate" layoutId="rail-active" transition={spring.snappy} />;
}

function InlineRename({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <input
      ref={ref}
      className="rail__rename"
      value={v}
      aria-label="Thread name"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() && v.trim() !== initial ? v : null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(v.trim() && v.trim() !== initial ? v : null);
        if (e.key === 'Escape') onDone(null);
        e.stopPropagation();
      }}
    />
  );
}

function ThreadRow({
  t,
  active,
  cursor,
  draft,
  notebooks,
  renaming,
  setRenaming,
  showTime,
  icon,
  prefetch,
}: {
  t: ThreadSummary;
  active: boolean;
  cursor: boolean;
  draft: boolean;
  notebooks: NotebookView[];
  renaming: boolean;
  setRenaming: (id: string | null) => void;
  showTime: boolean;
  icon?: boolean;
  prefetch: (id: string) => void;
}) {
  const navigate = useNavigate();
  const items: MenuEntry[] = [
    { label: 'Rename', icon: 'edit', keys: 'f2', onSelect: () => setRenaming(t.id) },
    {
      label: t.pinned ? 'Unpin' : 'Pin to the top',
      icon: 'pin',
      onSelect: () => void setPinned(t.id, !t.pinned),
    },
    {
      kind: 'sub',
      label: 'Move to notebook',
      icon: 'notebook',
      items: [
        ...notebooks
          .filter((n) => n.id !== t.notebookId)
          .map((n) => ({ label: n.title, onSelect: () => void moveThread(t.id, n.id, n.title) })),
        ...(t.notebookId
          ? [
              { kind: 'separator' as const },
              { label: 'Out of its notebook', onSelect: () => void moveThread(t.id, null) },
            ]
          : []),
        ...(notebooks.length === 0
          ? [{ label: 'No notebooks yet', disabled: true, onSelect: () => {} }]
          : []),
      ],
    },
    {
      label: 'Copy link',
      icon: 'link',
      onSelect: () => void navigator.clipboard?.writeText(`${location.origin}/t/${t.id}`),
    },
    { kind: 'separator' },
    { label: 'Archive', icon: 'archive', onSelect: () => void setArchived(t.id, true, t.title) },
    {
      label: 'Delete',
      icon: 'trash',
      danger: true,
      onSelect: () =>
        deleteThread(t.id, t.title, () => {
          if (active) void navigate({ to: '/' });
        }),
    },
  ];

  if (renaming)
    return (
      <div className="rail__item" data-active={active || undefined}>
        {active ? <ActivePlate /> : null}
        <InlineRename
          initial={t.title}
          onDone={(title) => {
            setRenaming(null);
            if (title) void renameThread(t.id, title);
          }}
        />
      </div>
    );

  return (
    <ContextMenu items={items}>
      <div className="rail__row" data-cursor={cursor || undefined}>
        <Link
          to="/t/$threadId"
          params={{ threadId: t.id }}
          className="rail__item"
          data-active={active || undefined}
          onMouseEnter={() => prefetch(t.id)}
          onDoubleClick={(e) => {
            e.preventDefault();
            setRenaming(t.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault();
              setRenaming(t.id);
            }
          }}
          title={t.title}
          dir="auto"
        >
          {active ? <ActivePlate /> : null}
          {icon ? (
            <Icon
              name={t.pinned ? 'pin' : 'thread'}
              size={14}
              className={t.pinned ? 'gilt-ink' : undefined}
            />
          ) : null}
          <span className="rail__label">{t.title}</span>
          {t.live ? <span className="live-dot" role="img" aria-label="Answering or waiting on you" /> : null}
          {draft && !active ? (
            <span className="rail__draft" title="Unsent draft">
              Draft
            </span>
          ) : null}
          {t.branches > 1 ? (
            <span className="rail__meta" title={`${t.branches} branches`}>
              <Icon name="branch" size={12} />
              <span data-num>{t.branches}</span>
            </span>
          ) : showTime ? (
            <span className="rail__meta rail__time">{relative(t.updatedAt)}</span>
          ) : null}
        </Link>
        <DropMenu
          items={items}
          trigger={
            <button
              type="button"
              className="rail__more icon-btn icon-btn--xs"
              aria-label={`More for ${t.title}`}
            >
              <Icon name="more" size={14} />
            </button>
          }
        />
      </div>
    </ContextMenu>
  );
}

function Section({
  title,
  children,
  action,
  id,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  id: string;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(`nvx.ancile.rail.${id}`) !== 'closed';
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(`nvx.ancile.rail.${id}`, o ? 'closed' : 'open');
      } catch {
        /* blocked */
      }
      return !o;
    });
  return (
    <section className="rail__group" data-open={open}>
      <div className="rail__section">
        <button type="button" className="rail__section-btn" onClick={toggle} aria-expanded={open}>
          <Icon name="chevronDown" size={11} className="rail__caret" />
          {title}
        </button>
        {action}
      </div>
      {open ? children : null}
    </section>
  );
}

export function Rail() {
  const open = useUi((s) => s.railOpen);
  const toggle = useUi((s) => s.toggleRail);
  const width = usePrefs((s) => s.prefs.layout.railWidth);
  const setPref = usePrefs((s) => s.set);
  const narrow = useMediaQuery('(max-width: 820px)');
  const notebooks = useNotebooks();
  const threads = useThreads();
  const [showArchive, setShowArchive] = useState(false);
  const archived = useArchivedThreads(showArchive);
  const params = useParams({ strict: false });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const drafts = useDraftIds(threads.data);

  // On a phone the rail is an overlay: picking something closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on navigation only
  useEffect(() => {
    if (narrow && useUi.getState().railOpen) useUi.getState().toggleRail();
  }, [pathname]);

  const q = filter.trim().toLowerCase();
  const match = (title: string) => !q || title.toLowerCase().includes(q);

  // biome-ignore lint/correctness/useExhaustiveDependencies: match() is derived from q
  const groups = useMemo(() => {
    const nbs = (notebooks.data ?? []).filter((n) => !n.archived);
    const ts = (threads.data ?? []).filter((t) => match(t.title));
    const pinned = ts.filter((t) => t.pinned);
    const rest = ts.filter((t) => !t.pinned && !t.notebookId);
    const now = Date.now();
    const byDate: { label: string; items: ThreadSummary[] }[] = [];
    for (const t of rest) {
      const label = bucket(t.updatedAt, now);
      const last = byDate[byDate.length - 1];
      if (last?.label === label) last.items.push(t);
      else byDate.push({ label, items: [t] });
    }
    return {
      pinned,
      notebooks: nbs
        .filter((n) => match(n.title) || ts.some((t) => t.notebookId === n.id))
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
        .map((n) => ({ ...n, threads: ts.filter((t) => t.notebookId === n.id && !t.pinned) })),
      byDate,
    };
  }, [notebooks.data, threads.data, q]);

  const rows: Row[] = useMemo(
    () => [
      ...groups.pinned.map((t) => ({ kind: 'thread' as const, id: t.id })),
      ...groups.notebooks.flatMap((n) => [
        { kind: 'notebook' as const, id: n.id },
        ...n.threads.map((t) => ({ kind: 'thread' as const, id: t.id })),
      ]),
      ...groups.byDate.flatMap((g) => g.items.map((t) => ({ kind: 'thread' as const, id: t.id }))),
    ],
    [groups],
  );

  const openRow = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'thread') void navigate({ to: '/t/$threadId', params: { threadId: row.id } });
    else void navigate({ to: '/n/$notebookId', params: { notebookId: row.id } });
  };

  const focusList = (index: number) => {
    if (!open) toggle();
    setCursor(index);
    requestAnimationFrame(() => listRef.current?.focus());
  };

  useBinding('rail.toggle', toggle);
  useBinding('list.down', () => setCursor((c) => Math.min(rows.length - 1, c + 1)), open && focused);
  useBinding('list.up', () => setCursor((c) => Math.max(0, c - 1)), open && focused);
  useBinding('list.open', () => openRow(rows[cursor]), open && focused);
  useBinding('go.threads', () =>
    focusList(
      Math.max(
        0,
        rows.findIndex((r) => r.kind === 'thread'),
      ),
    ),
  );
  useBinding('go.notebooks', () =>
    focusList(
      Math.max(
        0,
        rows.findIndex((r) => r.kind === 'notebook'),
      ),
    ),
  );
  useBinding('rail.filter', () => {
    if (!open) toggle();
    requestAnimationFrame(() => filterRef.current?.focus());
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the cursor moves; the DOM holds the target
  useEffect(() => {
    if (!focused) return;
    listRef.current?.querySelector<HTMLElement>('[data-cursor]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  // "New notebook" from the palette or a tour.
  useEffect(() => {
    const on = () => {
      if (!useUi.getState().railOpen) useUi.getState().toggleRail();
      setCreating(true);
    };
    window.addEventListener('ancile:new-notebook', on);
    return () => window.removeEventListener('ancile:new-notebook', on);
  }, []);

  // Load the next page as the end of the list comes into view.
  const { more, hasMore } = threads;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && more(), { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, more]);

  const isCursor = (kind: Row['kind'], id: string) =>
    focused && rows[cursor]?.kind === kind && rows[cursor]?.id === id;
  const prefetch = (id: string) => void qc.prefetchQuery(threadQuery(id));
  const nbs = notebooks.data ?? [];

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setFilter('');
      e.currentTarget.blur();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusList(0);
    }
    if (e.key === 'Enter') openRow(rows[0]);
  };

  // Drag the edge to resize; double-click it to reset.
  const onResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const startW = width;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.documentElement.dataset.resizing = '';
    const move = (ev: PointerEvent) => {
      const w = Math.round(Math.min(360, Math.max(200, startW + ev.clientX - startX)));
      document.querySelector<HTMLElement>('.shell')?.style.setProperty('--rail-w', `${w}px`);
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      delete document.documentElement.dataset.resizing;
      const w = Math.round(Math.min(360, Math.max(200, startW + ev.clientX - startX)));
      setPref('layout', { railWidth: w });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  };

  const rowProps = {
    notebooks: nbs,
    setRenaming,
    prefetch,
  };

  return (
    <nav
      className="rail"
      data-tour="rail"
      data-open={open}
      aria-label="Notebooks and threads"
      style={{ '--rail-w-pref': `${width}px` } as CSSProperties}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="rail__head">
        <Link to="/" className="rail__new">
          <Icon name="plus" size={14} />
          <span>New thread</span>
          <Kbd keys="n" />
        </Link>
        <Tip label="Hide sidebar" binding="rail.toggle" side="right">
          <button type="button" className="icon-btn icon-btn--sm" onClick={toggle} aria-label="Hide sidebar">
            <Icon name="panelLeft" size={14} />
          </button>
        </Tip>
      </div>

      <label className="rail__filter">
        <Icon name="filter" size={13} />
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKey}
          placeholder="Filter"
          aria-label="Filter notebooks and threads"
        />
        {filter ? (
          <button
            type="button"
            className="icon-btn icon-btn--xs"
            onClick={() => setFilter('')}
            aria-label="Clear filter"
          >
            <Icon name="close" size={11} />
          </button>
        ) : (
          <Kbd keys="g f" />
        )}
      </label>

      <div
        className="rail__scroll"
        data-scrollable
        ref={listRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the list takes focus so j/k can walk it
        tabIndex={0}
        role="region"
        aria-label="Notebooks and threads list"
      >
        {showArchive ? (
          <Section id="archive" title="Archive">
            {archived.isPending ? (
              <Skeleton lines={5} label="Loading the archive" />
            ) : (archived.data ?? []).length === 0 ? (
              <p className="rail__empty">
                Nothing archived. Archive a thread to tidy it away without deleting it.
              </p>
            ) : (
              <ul className="rail__list">
                {(archived.data ?? []).map((t) => (
                  <li key={t.id} className="rail__row">
                    <Link to="/t/$threadId" params={{ threadId: t.id }} className="rail__item" dir="auto">
                      <Icon name="archive" size={14} />
                      <span className="rail__label">{t.title}</span>
                    </Link>
                    <Tip label="Restore">
                      <button
                        type="button"
                        className="rail__more icon-btn icon-btn--xs"
                        aria-label={`Restore ${t.title}`}
                        onClick={() => void setArchived(t.id, false, t.title)}
                      >
                        <Icon name="undo" size={13} />
                      </button>
                    </Tip>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ) : notebooks.isPending || threads.isPending ? (
          <Skeleton lines={9} label="Loading notebooks and threads" />
        ) : threads.isError ? (
          <div className="rail__empty">
            <p>The list could not be loaded.</p>
            <button type="button" className="link-btn" onClick={() => void threads.refetch()}>
              Try again
            </button>
          </div>
        ) : (
          <>
            {groups.pinned.length > 0 ? (
              <Section id="pinned" title="Pinned">
                <ul className="rail__list">
                  {groups.pinned.map((t) => (
                    <li key={t.id}>
                      <ThreadRow
                        t={t}
                        {...rowProps}
                        icon
                        active={params.threadId === t.id}
                        cursor={isCursor('thread', t.id)}
                        draft={drafts.has(t.id)}
                        renaming={renaming === t.id}
                        showTime={false}
                      />
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            <Section
              id="notebooks"
              title="Notebooks"
              action={
                <Tip label="New notebook">
                  <button
                    type="button"
                    className="icon-btn icon-btn--xs"
                    aria-label="New notebook"
                    data-tour="new-notebook"
                    onClick={() => setCreating(true)}
                  >
                    <Icon name="plus" size={12} />
                  </button>
                </Tip>
              }
            >
              {creating ? <NewNotebook onDone={() => setCreating(false)} /> : null}
              {groups.notebooks.length === 0 && !creating ? (
                <button type="button" className="rail__ghost" onClick={() => setCreating(true)}>
                  <Icon name="plus" size={13} />
                  Start a notebook for a project's sources
                </button>
              ) : null}
              <ul className="rail__list">
                {groups.notebooks.map((n) => (
                  <li key={n.id}>
                    <div className="rail__row" data-cursor={isCursor('notebook', n.id) || undefined}>
                      <Link
                        to="/n/$notebookId"
                        params={{ notebookId: n.id }}
                        className="rail__item rail__item--notebook"
                        data-active={params.notebookId === n.id || undefined}
                        style={{ '--hue': hueVar((n.color as Hue) ?? 'chalk') } as CSSProperties}
                        dir="auto"
                      >
                        {params.notebookId === n.id ? <ActivePlate /> : null}
                        <span className="rail__swatch" aria-hidden="true" />
                        <span className="rail__label">{n.title}</span>
                        {n.pinned ? <Icon name="pin" size={11} className="gilt-ink" /> : null}
                        <span className="rail__meta" data-num title={`${n.sources} sources`}>
                          {n.sources}
                        </span>
                      </Link>
                    </div>
                    {n.threads.length > 0 ? (
                      <ul className="rail__sub">
                        {n.threads.map((t) => (
                          <li key={t.id}>
                            <ThreadRow
                              t={t}
                              {...rowProps}
                              active={params.threadId === t.id}
                              cursor={isCursor('thread', t.id)}
                              draft={drafts.has(t.id)}
                              renaming={renaming === t.id}
                              showTime={false}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>

            {groups.byDate.map((g) => (
              <Section key={g.label} id={`d-${g.label}`} title={g.label}>
                <ul className="rail__list">
                  {g.items.map((t) => (
                    <li key={t.id}>
                      <ThreadRow
                        t={t}
                        {...rowProps}
                        active={params.threadId === t.id}
                        cursor={isCursor('thread', t.id)}
                        draft={drafts.has(t.id)}
                        renaming={renaming === t.id}
                        showTime={g.label === 'Today' || g.label === 'Yesterday'}
                      />
                    </li>
                  ))}
                </ul>
              </Section>
            ))}

            {q && rows.length === 0 ? (
              <div className="rail__empty">
                <p>Nothing called “{filter}”.</p>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => useUi.getState().openPalette('all', filter)}
                >
                  Search inside messages
                </button>
              </div>
            ) : null}
            {!q && (threads.data ?? []).length === 0 && nbs.length === 0 ? (
              <p className="rail__empty">Your threads will gather here. Start one with New thread.</p>
            ) : null}
            <div ref={sentinel} aria-hidden="true" />
            {threads.loadingMore ? <Skeleton lines={3} label="Loading more threads" /> : null}
          </>
        )}
      </div>

      <div className="rail__foot">
        <Checklist />
        <div className="rail__foot-row">
          <button
            type="button"
            className="rail__item rail__foot-item"
            data-active={showArchive || undefined}
            onClick={() => setShowArchive((s) => !s)}
            aria-pressed={showArchive}
          >
            <Icon name={showArchive ? 'chevronLeft' : 'archive'} size={14} />
            <span className="rail__label">{showArchive ? 'Back to threads' : 'Archive'}</span>
          </button>
          <Tip label="Settings" binding="settings.open" side="top">
            <Link
              to="/settings/$group"
              params={{ group: 'appearance' }}
              className="icon-btn icon-btn--sm"
              aria-label="Settings"
            >
              <Icon name="settings" size={14} />
            </Link>
          </Tip>
          <Tip label="Admin" binding="go.admin" side="top">
            <Link
              to="/admin/$section"
              params={{ section: 'health' }}
              className="icon-btn icon-btn--sm"
              aria-label="Admin"
            >
              <Icon name="shield" size={14} />
            </Link>
          </Tip>
          <Tip label="Help" binding="help.open" side="top">
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Help"
              onClick={() => useUi.getState().setHelp(true)}
            >
              <Icon name="book" size={14} />
            </button>
          </Tip>
        </div>
      </div>

      <div
        className="rail__resize"
        aria-hidden="true"
        onPointerDown={onResize}
        onDoubleClick={() => setPref('layout', { railWidth: 248 })}
      />
    </nav>
  );
}
