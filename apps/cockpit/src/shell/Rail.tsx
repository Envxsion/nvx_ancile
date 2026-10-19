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
 *           |  Threads can be selected (Ctrl or Shift click; Space,
 *           |  Shift+arrows, Ctrl+A on the keyboard). The selection
 *           |  lives in the rail, not in its rows, so a range runs
 *           |  across rows the window has not drawn. Selected threads
 *           |  drag onto a notebook together, and a bar offers move,
 *           |  archive, export and delete with one Undo. Threads that
 *           |  need you float to the top; answering ones pulse; an
 *           |  unread answer leaves a solid dot until you open it.
 *           |  Pro's saved smart sections draw between Pinned and
 *           |  Notebooks (pro/SmartSectionsHost.tsx).
 * ------------------------------------------------------------------
 */

import { spring } from '@nvx/aperture';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { m as motion } from 'motion/react';
import {
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  lazy,
  type MouseEvent,
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { syncThread } from '../claudecode/api';
import { groupTogether, useNotebookLinks } from '../claudecode/SameRepo';
import { threadLink } from '../desktop/api';
import { openEditor } from '../editors/store';
import { Checklist } from '../help/Checklist';
import { useBinding } from '../keys/dispatch';
import { useArchivedThreads, useNotebooks, useThreads } from '../lib/data';
import { openExport } from '../lib/exportStore';
import { hueVar, relative } from '../lib/format';
import {
  deleteThread,
  markSeen,
  moveThread,
  moveThreads,
  renameThread,
  setArchived,
  setPinned,
} from '../lib/threads';
import type { Hue, NotebookView, ThreadSummary } from '../lib/types';
import { useMediaQuery } from '../lib/useMediaQuery';
import { runHindsight } from '../memory/api';
import { SmartSectionsHost } from '../pro/SmartSectionsHost';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { Icon, isIconName } from '../ui/Icon';
import { loadError } from '../ui/LoadFailed';
import { ContextMenu, DropMenu, type MenuEntry } from '../ui/Menu';
import { Skeleton, Tip } from '../ui/primitives';
import { NewNotebook } from './NewNotebook';
import {
  ATTENTION_LABEL,
  type Attention,
  attentionOf,
  dragIds,
  EMPTY,
  extendTo,
  nextNeeding,
  prune,
  type RollUp,
  rollUp,
  type Selection,
  selectAll,
  selectionSaid,
  toggle as toggleSel,
  topOf,
} from './selection';
import { WindowedList } from './WindowedList';

// Loaded when first needed: the empty shell draws neither.
const BulkBar = lazy(() => import('./BulkBar').then((m) => ({ default: m.BulkBar })));
const TrashView = lazy(() => import('./TrashView').then((m) => ({ default: m.TrashView })));

/** What a dragged thread carries: the ids of every thread moving with it. */
export const DRAG_TYPE = 'application/x-ancile-threads';

/** A read that failed, sized for the rail: its own words and Try again, never "Nothing here yet". */
function RailFailed({ error, what, onRetry }: { error: unknown; what: string; onRetry: () => unknown }) {
  const e = loadError(error, what).error;
  return (
    <div className="rail__empty" role="alert">
      <p>{e.title}</p>
      <p>{e.hint}</p>
      <button type="button" className="link-btn" onClick={() => void onRetry()}>
        Try again
      </button>
    </div>
  );
}

type Row = { kind: 'notebook' | 'thread'; id: string };

/** More rows than this in the rail and its long lists are windowed (ROADMAP P7). */
export const RAIL_WINDOW_AT = 300;
/** ...each list that has at least this many rows. */
export const WINDOW_LIST_MIN = 60;
const threadId = (t: ThreadSummary) => t.id;

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

/**
 * What a thread wants of you, in one small mark. Working pulses (the live dot, the one place
 * signal violet means "live"); needs you is an amber shield; an unread answer is a solid dot
 * that stays until you open the thread. Reduced motion turns the pulse into a still ring.
 */
export function AttentionMark({ state, count }: { state: Attention; count?: number }) {
  if (state === 'none') return null;
  const label = count && count > 1 ? `${ATTENTION_LABEL[state]}: ${count}` : ATTENTION_LABEL[state];
  if (state === 'working') return <span className="live-dot rail__working" role="img" aria-label={label} />;
  if (state === 'needs_you')
    return (
      <span className="rail__needs" role="img" aria-label={label}>
        <Icon name="shield" size={12} />
        {count && count > 1 ? <span data-num>{count}</span> : null}
      </span>
    );
  return (
    <span className="rail__unread" role="img" aria-label={label}>
      {count && count > 1 ? <span data-num>{count}</span> : null}
    </span>
  );
}

const ThreadRow = memo(function ThreadRow({
  t,
  active,
  cursor,
  roving,
  onFocusRow,
  draft,
  notebooks,
  renaming,
  setRenaming,
  showTime,
  icon,
  selected,
  attention,
}: {
  t: ThreadSummary;
  active: boolean;
  cursor: boolean;
  /** The one row Tab reaches (roving tabindex); the others are reached with the arrow keys. */
  roving: boolean;
  onFocusRow: (kind: Row['kind'], id: string) => void;
  draft: boolean;
  notebooks: NotebookView[];
  renaming: boolean;
  setRenaming: (id: string | null) => void;
  showTime: boolean;
  icon?: boolean;
  selected: boolean;
  attention: Attention;
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
      label: 'Export',
      icon: 'download',
      onSelect: () => openExport(t.id),
    },
    {
      label: 'Copy link',
      icon: 'link',
      // ancile://thread/<id> in the desktop app (it opens in the app, whatever port Core has).
      onSelect: () => void navigator.clipboard?.writeText(threadLink(t.id)),
    },
    { kind: 'separator' },
    {
      label: 'Scope',
      icon: 'shield',
      onSelect: () => openEditor({ kind: 'scope', level: 'thread', id: t.id }),
    },
    {
      label: 'Instructions and persona',
      icon: 'note',
      onSelect: () => openEditor({ kind: 'instructions', level: 'thread', id: t.id }),
    },
    {
      label: 'Context links',
      icon: 'link',
      onSelect: () =>
        openEditor({
          kind: 'links',
          level: 'thread',
          id: t.id,
          title: t.title,
          notebookId: t.notebookId ?? null,
        }),
    },
    {
      label: 'Context packs',
      icon: 'archive',
      onSelect: () => openEditor({ kind: 'packs', level: 'thread', id: t.id, title: t.title }),
    },
    ...(t.fromClaudeCode
      ? [
          {
            label: 'Sync from Claude Code',
            icon: 'regenerate' as const,
            onSelect: () => void syncThread(t.id),
          },
        ]
      : []),
    {
      label: 'Hindsight pass',
      icon: 'evidence',
      onSelect: () => void runHindsight(t.id, (to) => void navigate({ to })),
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
          data-thread={t.id}
          data-selected={selected || undefined}
          draggable
          tabIndex={roving ? 0 : -1}
          onFocus={() => onFocusRow('thread', t.id)}
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
          title={t.fromClaudeCode ? `${t.title}, from Claude Code` : t.title}
          dir="auto"
        >
          {active ? <ActivePlate /> : null}
          {icon ? (
            <Icon
              name={t.pinned ? 'pin' : t.fromClaudeCode ? 'command' : 'thread'}
              size={14}
              className={t.pinned ? 'gilt-ink' : undefined}
            />
          ) : null}
          <span className="rail__label">{t.title}</span>
          {selected ? <span className="sr-only">, selected</span> : null}
          <AttentionMark state={attention} />
          {draft && !active ? (
            <span className="rail__draft" title="Unsent draft">
              Draft
            </span>
          ) : null}
          {t.branches > 1 && attention !== 'working' && attention !== 'needs_you' ? (
            <span className="rail__meta" title={`${t.branches} branches`}>
              <Icon name="branch" size={12} />
              <span data-num>{t.branches}</span>
            </span>
          ) : null}
          {attention === 'working' || attention === 'needs_you' ? (
            <span className="rail__meta rail__state" data-state={attention}>
              {attention === 'working' ? 'Working…' : 'Needs an answer'}
            </span>
          ) : t.branches > 1 ? null : showTime ? (
            <span className="rail__meta rail__time">{relative(t.updatedAt)}</span>
          ) : null}
        </Link>
        <DropMenu
          items={items}
          trigger={
            <button
              type="button"
              className="rail__more icon-btn icon-btn--xs"
              tabIndex={roving ? 0 : -1}
              aria-label={`More for ${t.title}`}
            >
              <Icon name="more" size={14} />
            </button>
          }
        />
      </div>
    </ContextMenu>
  );
});

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

/**
 * The places that are not a notebook or a thread: one row each, lit while
 * you are on them, with the shortcut in the tooltip.
 */
export const RAIL_PLACES = [
  { id: 'flows', label: 'Flows', icon: 'branch', binding: 'go.flows' },
  { id: 'automations', label: 'Automations', icon: 'clock', binding: 'go.automations' },
] as const;

export function railPlaceActive(id: (typeof RAIL_PLACES)[number]['id'], pathname: string): boolean {
  if (id === 'flows')
    return pathname === '/flows' || pathname.startsWith('/flows/') || pathname.endsWith('/flow');
  return pathname === '/admin/automations';
}

export function RailPlaces({ pathname }: { pathname: string }) {
  return (
    <ul className="rail__places" aria-label="Places">
      {RAIL_PLACES.map((p) => {
        const active = railPlaceActive(p.id, pathname);
        return (
          <li key={p.id}>
            <Tip label={p.label} binding={p.binding} side="right">
              {p.id === 'flows' ? (
                <Link
                  to="/flows"
                  className="rail__item rail__place"
                  data-active={active || undefined}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon name={p.icon} size={14} />
                  <span className="rail__label">{p.label}</span>
                </Link>
              ) : (
                <Link
                  to="/admin/$section"
                  params={{ section: 'automations' }}
                  className="rail__item rail__place"
                  data-active={active || undefined}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon name={p.icon} size={14} />
                  <span className="rail__label">{p.label}</span>
                </Link>
              )}
            </Tip>
          </li>
        );
      })}
    </ul>
  );
}

export function Rail() {
  const open = useUi((s) => s.railOpen);
  const toggle = useUi((s) => s.toggleRail);
  const width = usePrefs((s) => s.prefs.layout.railWidth);
  const setPref = usePrefs((s) => s.set);
  const narrow = useMediaQuery('(max-width: 820px)');
  const notebooks = useNotebooks();
  const links = useNotebookLinks(!useUi((s) => s.demo));
  const threads = useThreads();
  const [showArchive, setShowArchive] = useState(false);
  const archived = useArchivedThreads(showArchive);
  const params = useParams({ strict: false });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<Selection>(EMPTY);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [archiveTab, setArchiveTab] = useState<'archive' | 'trash'>('archive');
  const [said, setSaid] = useState('');
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
    // A thread waiting on you floats to the top and appears only there.
    const needsYou = ts.filter((t) => attentionOf(t) === 'needs_you');
    const calm = ts.filter((t) => attentionOf(t) !== 'needs_you');
    const pinned = calm.filter((t) => t.pinned);
    const rest = calm.filter((t) => !t.pinned && !t.notebookId);
    const now = Date.now();
    const byDate: { label: string; items: ThreadSummary[] }[] = [];
    for (const t of rest) {
      const label = bucket(t.updatedAt, now);
      const last = byDate[byDate.length - 1];
      if (last?.label === label) last.items.push(t);
      else byDate.push({ label, items: [t] });
    }
    return {
      needsYou,
      pinned,
      // Notebooks of one repository the person chose to show together stay side by side.
      notebooks: groupTogether(
        nbs
          .filter((n) => match(n.title) || ts.some((t) => t.notebookId === n.id))
          .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)),
        links.data?.groups ?? [],
      ).items.map((n) => ({ ...n, threads: calm.filter((t) => t.notebookId === n.id && !t.pinned) })),
      byDate,
    };
  }, [notebooks.data, threads.data, q, links.data]);
  const joined = useMemo(
    () => groupTogether(groups.notebooks, links.data?.groups ?? []).joined,
    [groups.notebooks, links.data],
  );

  const rows: Row[] = useMemo(
    () => [
      ...groups.needsYou.map((t) => ({ kind: 'thread' as const, id: t.id })),
      ...groups.pinned.map((t) => ({ kind: 'thread' as const, id: t.id })),
      ...groups.notebooks.flatMap((n) => [
        { kind: 'notebook' as const, id: n.id },
        ...n.threads.map((t) => ({ kind: 'thread' as const, id: t.id })),
      ]),
      ...groups.byDate.flatMap((g) => g.items.map((t) => ({ kind: 'thread' as const, id: t.id }))),
    ],
    [groups],
  );

  // Every selectable thread in the rail's order, drawn or not: a Shift range runs along this.
  const order = useMemo(() => rows.filter((r) => r.kind === 'thread').map((r) => r.id), [rows]);
  const selectedIds = useMemo(() => order.filter((id) => sel.ids.has(id)), [order, sel]);
  const allIds = useMemo(() => new Set((threads.data ?? []).map((t) => t.id)), [threads.data]);
  const byId = useMemo(() => new Map((threads.data ?? []).map((t) => [t.id, t] as const)), [threads.data]);
  const openId = params.threadId;
  const rolled = useMemo(() => {
    const m = new Map<string, RollUp>();
    const by = new Map<string, ThreadSummary[]>();
    for (const t of threads.data ?? [])
      if (t.notebookId) by.set(t.notebookId, [...(by.get(t.notebookId) ?? []), t]);
    for (const [id, list] of by) m.set(id, rollUp(list, openId));
    return m;
  }, [threads.data, openId]);

  // Threads that are gone leave the selection; the count is said once it changes.
  useEffect(() => setSel((s) => prune(s, [...allIds])), [allIds]);
  const lastCount = useRef(0);
  useEffect(() => {
    if (sel.ids.size !== lastCount.current) setSaid(selectionSaid(sel.ids.size));
    lastCount.current = sel.ids.size;
  }, [sel]);

  // Opening a thread reads it: the unread dot goes, here and in Core.
  const openThread = openId ? byId.get(openId) : undefined;
  const openUnread = openThread?.unread === true && !openThread.live;
  useEffect(() => {
    if (openId && openUnread) void markSeen(openId);
  }, [openId, openUnread]);

  // Alt+Down: the next thread that needs you.
  useBinding('rail.nextAttention', () => {
    const next = nextNeeding(
      groups.needsYou.map((t) => t.id),
      openId,
    );
    if (!next) {
      setSaid('No thread needs you.');
      return;
    }
    const at = rows.findIndex((r) => r.kind === 'thread' && r.id === next);
    if (at >= 0) setCursor(at);
    void navigate({ to: '/t/$threadId', params: { threadId: next } });
  });

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
    const row = listRef.current?.querySelector<HTMLElement>('[data-cursor]');
    row?.scrollIntoView({ block: 'nearest' });
    // Focus follows the cursor, so Enter and screen readers act on the row it is on.
    const at = document.activeElement;
    if (row && at && listRef.current?.contains(at) && at.tagName !== 'INPUT' && !at.closest('[data-cursor]'))
      row.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
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

  // Tab reaches the cursor's row only; the arrow keys, Home, End, j and k move it (and focus follows).
  const isRoving = (kind: Row['kind'], id: string) => rows[cursor]?.kind === kind && rows[cursor]?.id === id;
  const onFocusRow = useCallback(
    (kind: Row['kind'], id: string) => {
      const at = rows.findIndex((r) => r.kind === kind && r.id === id);
      if (at >= 0) setCursor(at);
    },
    [rows],
  );
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    // Selecting: Ctrl+A all, Space one, Shift with an arrow a range, Escape none.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSel(selectAll(order));
      return;
    }
    if (e.key === 'Escape' && sel.ids.size > 0) {
      e.preventDefault();
      setSel(EMPTY);
      return;
    }
    const onThreadLink = t.closest('a[data-thread]');
    if (e.key === ' ' && !e.altKey && !e.ctrlKey && !e.metaKey && onThreadLink) {
      e.preventDefault();
      const id = onThreadLink.getAttribute('data-thread');
      if (id) setSel((s) => (e.shiftKey ? extendTo(s, order, id) : toggleSel(s, id)));
      return;
    }
    if (
      e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      (e.key === 'ArrowDown' || e.key === 'ArrowUp')
    ) {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      let at = cursor + step;
      while (rows[at] && rows[at]?.kind !== 'thread') at += step;
      const row = rows[at];
      if (!row) return;
      e.preventDefault();
      const from = rows[cursor];
      // Start the range on the row you were on, so the first Shift+arrow takes both.
      setSel((s) =>
        extendTo(
          s.ids.size === 0 && from?.kind === 'thread' ? { ids: new Set([from.id]), anchor: from.id } : s,
          order,
          row.id,
        ),
      );
      setCursor(at);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const to =
      e.key === 'ArrowDown'
        ? cursor + 1
        : e.key === 'ArrowUp'
          ? cursor - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? rows.length - 1
              : null;
    if (to === null || rows.length === 0) return;
    e.preventDefault();
    setCursor(Math.max(0, Math.min(rows.length - 1, to)));
  };
  const isCursor = (kind: Row['kind'], id: string) =>
    focused && rows[cursor]?.kind === kind && rows[cursor]?.id === id;
  const nbs = useMemo(() => notebooks.data ?? [], [notebooks.data]);
  // Past a few hundred rows, long lists draw only what is near (WindowedList.tsx), keeping the
  // keyboard cursor's row drawn so j and k still walk through the hidden ones.
  const windowAt = rows.length > RAIL_WINDOW_AT ? WINDOW_LIST_MIN : Number.POSITIVE_INFINITY;
  const cursorThread = focused && rows[cursor]?.kind === 'thread' ? (rows[cursor]?.id ?? null) : null;
  // Notebooks that did not load are not "Start a notebook": a refresh that failed keeps the list.
  const notebooksFailed = notebooks.isError && !notebooks.data;

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

  // Ctrl or Cmd click toggles, Shift click takes the range (across rows the window has not drawn),
  // and a plain click opens the thread and drops the selection.
  const onListClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest('a[data-thread]');
    const id = link?.getAttribute('data-thread');
    if (!id) return;
    if (e.shiftKey) {
      e.preventDefault();
      setSel((s) => extendTo(s, order, id, e.ctrlKey || e.metaKey));
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setSel((s) => toggleSel(s, id));
    } else if (sel.ids.size > 0) setSel(EMPTY);
  };

  // Dragging a selected thread takes the whole selection; any other takes just itself.
  const onListDragStart = (e: DragEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).closest('a[data-thread]')?.getAttribute('data-thread');
    if (!id) return;
    const ids = dragIds(sel, id, order);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.setData(
      'text/plain',
      ids.length === 1 ? (byId.get(id)?.title ?? '') : `${ids.length} threads`,
    );
    e.dataTransfer.effectAllowed = 'move';
  };
  const dragging = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(DRAG_TYPE);
  const dropOnNotebook = (e: DragEvent, nb: { id: string; title: string }) => {
    setDropOn(null);
    if (!dragging(e)) return;
    e.preventDefault();
    let ids: string[] = [];
    try {
      const raw = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as unknown;
      ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      ids = [];
    }
    // A thread dropped on the notebook it is already in stays put.
    const moving = ids.filter((id) => byId.get(id)?.notebookId !== nb.id);
    if (moving.length === 0) {
      setSaid(`Already in ${nb.title}.`);
      return;
    }
    void moveThreads(moving, nb.id, nb.title);
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
    onFocusRow,
  };
  const markOf = (t: ThreadSummary) => attentionOf(t, openId);

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
        <Tip label="New thread" binding="thread.quick" side="right">
          <Link to="/" className="rail__new">
            <Icon name="plus" size={14} />
            <span>New thread</span>
          </Link>
        </Tip>
        <Tip label="Hide sidebar" binding="rail.toggle" side="right">
          <button type="button" className="icon-btn icon-btn--sm" onClick={toggle} aria-label="Hide sidebar">
            <Icon name="panelLeft" size={14} />
          </button>
        </Tip>
      </div>

      <RailPlaces pathname={pathname} />

      <Tip label="Filter the sidebar" binding="rail.filter" side="right">
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
          ) : null}
        </label>
      </Tip>

      <div
        className="rail__scroll"
        data-scrollable
        ref={listRef}
        tabIndex={-1}
        onKeyDown={onListKey}
        onClickCapture={onListClickCapture}
        onDragStart={onListDragStart}
        role="region"
        aria-label="Notebooks and threads list"
      >
        <p className="sr-only">{`${(threads.data ?? []).length} threads loaded. Arrow keys, Home and End move between them. Space selects a thread, Shift with an arrow selects a range, Control A selects all.`}</p>
        <p className="sr-only" role="status" aria-live="polite">
          {said}
        </p>
        {showArchive ? (
          <Section id="archive" title={archiveTab === 'trash' ? 'Trash' : 'Archive'}>
            <div className="rail__tabs" role="group" aria-label="Archive or Trash">
              <button
                type="button"
                className="rail__tab"
                aria-pressed={archiveTab === 'archive'}
                onClick={() => setArchiveTab('archive')}
              >
                Archived
              </button>
              <button
                type="button"
                className="rail__tab"
                aria-pressed={archiveTab === 'trash'}
                onClick={() => setArchiveTab('trash')}
              >
                Trash
              </button>
            </div>
            {archiveTab === 'trash' ? (
              <Suspense fallback={<Skeleton lines={4} label="Loading the Trash" />}>
                <TrashView compact />
              </Suspense>
            ) : archived.isPending ? (
              <Skeleton lines={5} label="Loading the archive" />
            ) : archived.isError && !archived.data ? (
              <RailFailed error={archived.error} what="The archive" onRetry={() => archived.refetch()} />
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
          <RailFailed error={threads.error} what="Threads" onRetry={() => threads.refetch()} />
        ) : (
          <>
            {groups.needsYou.length > 0 ? (
              <Section id="needs" title="Needs you">
                <ul className="rail__list">
                  {groups.needsYou.map((t) => (
                    <li key={t.id}>
                      <ThreadRow
                        t={t}
                        {...rowProps}
                        icon
                        active={params.threadId === t.id}
                        cursor={isCursor('thread', t.id)}
                        roving={isRoving('thread', t.id)}
                        draft={drafts.has(t.id)}
                        renaming={renaming === t.id}
                        showTime={false}
                        selected={sel.ids.has(t.id)}
                        attention={markOf(t)}
                      />
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

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
                        roving={isRoving('thread', t.id)}
                        draft={drafts.has(t.id)}
                        renaming={renaming === t.id}
                        showTime={false}
                        selected={sel.ids.has(t.id)}
                        attention={markOf(t)}
                      />
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {/* TC4: saved smart sections (Pro; the free build shows what they are). Hidden while filtering. */}
            {!q ? (
              <SmartSectionsHost
                activeId={params.threadId ?? null}
                notebooks={nbs.map((n) => ({ id: n.id, title: n.title }))}
              />
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
              {notebooksFailed ? (
                <RailFailed error={notebooks.error} what="Notebooks" onRetry={() => notebooks.refetch()} />
              ) : groups.notebooks.length === 0 && !creating ? (
                <button type="button" className="rail__ghost" onClick={() => setCreating(true)}>
                  <Icon name="plus" size={13} />
                  Start a notebook for a project's sources
                </button>
              ) : null}
              <ul className="rail__list">
                {groups.notebooks.map((n) => (
                  <li
                    key={n.id}
                    data-drop={dropOn === n.id || undefined}
                    onDragEnter={(e) => dragging(e) && setDropOn(n.id)}
                    onDragOver={(e) => {
                      if (!dragging(e)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (dropOn !== n.id) setDropOn(n.id);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
                    }}
                    onDrop={(e) => dropOnNotebook(e, n)}
                  >
                    <div className="rail__row" data-cursor={isCursor('notebook', n.id) || undefined}>
                      <Link
                        to="/n/$notebookId"
                        params={{ notebookId: n.id }}
                        className={`rail__item rail__item--notebook${joined.has(n.id) ? ' rail__item--joined' : ''}`}
                        data-active={params.notebookId === n.id || undefined}
                        tabIndex={isRoving('notebook', n.id) ? 0 : -1}
                        onFocus={() => onFocusRow('notebook', n.id)}
                        title={joined.has(n.id) ? 'Same repository as the notebook above' : undefined}
                        style={{ '--hue': hueVar((n.color as Hue) ?? 'chalk') } as CSSProperties}
                        dir="auto"
                      >
                        {params.notebookId === n.id ? <ActivePlate /> : null}
                        {isIconName(n.icon) ? (
                          <Icon name={n.icon} size={13} className="rail__glyph" />
                        ) : (
                          <span className="rail__swatch" aria-hidden="true" />
                        )}
                        <span className="rail__label">{n.title}</span>
                        {n.pinned ? <Icon name="pin" size={11} className="gilt-ink" /> : null}
                        {(() => {
                          const top = topOf(rolled.get(n.id) ?? { needs_you: 0, working: 0, unread: 0 });
                          return top ? <AttentionMark state={top.state} count={top.count} /> : null;
                        })()}
                        <span className="rail__meta" data-num title={`${n.sources} sources`}>
                          {n.sources}
                        </span>
                      </Link>
                    </div>
                    {n.threads.length > 0 ? (
                      <WindowedList
                        className="rail__sub"
                        items={n.threads}
                        keyOf={threadId}
                        scroller={listRef}
                        from={windowAt}
                        cursorKey={cursorThread}
                      >
                        {(t) => (
                          <ThreadRow
                            t={t}
                            {...rowProps}
                            active={params.threadId === t.id}
                            cursor={isCursor('thread', t.id)}
                            roving={isRoving('thread', t.id)}
                            draft={drafts.has(t.id)}
                            renaming={renaming === t.id}
                            showTime={false}
                            selected={sel.ids.has(t.id)}
                            attention={markOf(t)}
                          />
                        )}
                      </WindowedList>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>

            {groups.byDate.map((g) => (
              <Section key={g.label} id={`d-${g.label}`} title={g.label}>
                <WindowedList
                  items={g.items}
                  keyOf={threadId}
                  scroller={listRef}
                  from={windowAt}
                  cursorKey={cursorThread}
                >
                  {(t) => (
                    <ThreadRow
                      t={t}
                      {...rowProps}
                      active={params.threadId === t.id}
                      cursor={isCursor('thread', t.id)}
                      roving={isRoving('thread', t.id)}
                      draft={drafts.has(t.id)}
                      renaming={renaming === t.id}
                      showTime={g.label === 'Today' || g.label === 'Yesterday'}
                      selected={sel.ids.has(t.id)}
                      attention={markOf(t)}
                    />
                  )}
                </WindowedList>
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
            {!q && (threads.data ?? []).length === 0 && nbs.length === 0 && !notebooksFailed ? (
              <p className="rail__empty">Your threads will gather here. Start one with New thread.</p>
            ) : null}
            <div ref={sentinel} aria-hidden="true" />
            {threads.loadingMore ? <Skeleton lines={3} label="Loading more threads" /> : null}
          </>
        )}
      </div>

      {selectedIds.length > 0 ? (
        <Suspense fallback={null}>
          <BulkBar ids={selectedIds} notebooks={nbs} onClear={() => setSel(EMPTY)} />
        </Suspense>
      ) : null}

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
