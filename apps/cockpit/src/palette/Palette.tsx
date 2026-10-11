/**
 * ------------------------------------------------------------------
 *  Title    |  Command palette
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  ⌘K reaches everything: threads (by title and by what
 *           |  was said in them), notebooks, models, every command,
 *           |  every setting and the guide. A prefix narrows it:
 *           |  `>` commands, `@` models, `#` notebooks, `?` help,
 *           |  `,` settings.
 *  How      |  cmdk inside a Radix dialog. With nothing typed it shows
 *           |  what you reach for most (frecency: how often, how
 *           |  lately). Message search asks Core after 180 ms of
 *           |  quiet. It does not animate beyond a fade: it opens
 *           |  dozens of times a day.
 *  Note     |  Command hints come from the keymap, so they are never
 *           |  out of date.
 * ------------------------------------------------------------------
 */

import type { ThreadSearchHit } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { searchHelp } from '../help/articles';
import { helpDone, useHelp } from '../help/store';
import { TOURS, tourEvent } from '../help/tours';
import { useBinding, useLayer } from '../keys/dispatch';
import { keysFor } from '../keys/registry';
import { api } from '../lib/api';
import { compactNow } from '../lib/branching';
import { useModels, useNotebooks, useThreads } from '../lib/data';
import { hueVar } from '../lib/format';
import { chooseModel, useCurrentModel, useThreadIdFromRoute } from '../lib/models';
import { deleteThread, exportThread, setArchived, setPinned } from '../lib/threads';
import type { Hue } from '../lib/types';
import { openBeam } from '../pro/beam';
import { useRepoCommands } from '../repos/commands';
import { notify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { type PaletteScope, useUi } from '../state/ui';
import { useBranchLayer } from '../tree/store';
import { Icon, type IconName } from '../ui/Icon';
import { Kbd } from '../ui/primitives';

const PREFIX: Record<string, PaletteScope> = {
  '>': 'commands',
  '@': 'models',
  '#': 'notebooks',
  '?': 'help',
  ',': 'settings',
};
const SCOPE_PREFIX: Record<PaletteScope, string> = {
  all: '',
  commands: '>',
  models: '@',
  notebooks: '#',
  help: '?',
  settings: ',',
};
const SCOPE_LABEL: Record<PaletteScope, string> = {
  all: '',
  commands: 'Commands',
  models: 'Models',
  notebooks: 'Notebooks',
  help: 'Guide',
  settings: 'Settings',
};
const PLACEHOLDER: Record<PaletteScope, string> = {
  all: 'Search threads, notebooks, commands, settings and the guide',
  commands: 'Run a command',
  models: 'Switch model',
  notebooks: 'Open a notebook',
  help: 'Search the guide',
  settings: 'Find a setting',
};

/** Settings the palette can jump to; the Settings page is the source of truth. */
const SETTINGS_INDEX: { label: string; group: string; words: string }[] = [
  { label: 'Theme', group: 'appearance', words: 'dark light system mode' },
  { label: 'Accent colour', group: 'appearance', words: 'colour color signal violet iris rose jade' },
  { label: 'Ground tint', group: 'appearance', words: 'graphite ink obsidian background' },
  { label: 'Contrast', group: 'appearance', words: 'high contrast accessibility' },
  { label: 'Glass or solid surfaces', group: 'appearance', words: 'blur transparency material' },
  { label: 'Film grain', group: 'appearance', words: 'noise texture' },
  { label: 'Gilt details', group: 'appearance', words: 'gold brass' },
  { label: 'Corners', group: 'appearance', words: 'radius sharp rounded' },
  { label: 'Interface font', group: 'appearance', words: 'archivo system typeface' },
  { label: 'Zoom', group: 'appearance', words: 'scale size bigger smaller' },
  { label: 'Density', group: 'layout', words: 'compact comfortable spacious' },
  { label: 'Sidebar and panel widths', group: 'layout', words: 'rail drawer width' },
  { label: 'Status bar items', group: 'layout', words: 'footer bar' },
  { label: 'Text size', group: 'reading', words: 'font size reading' },
  { label: 'Line spacing', group: 'reading', words: 'leading line height' },
  { label: 'Reading width', group: 'reading', words: 'measure column' },
  { label: 'Citations style', group: 'reading', words: 'footnote superscript' },
  { label: 'Send with Enter or Ctrl Enter', group: 'composer', words: 'send key newline' },
  { label: 'Snippets', group: 'composer', words: 'abbreviation template' },
  { label: 'Change a shortcut', group: 'keyboard', words: 'keys rebind shortcuts' },
  { label: 'Toasts', group: 'notifications', words: 'notification position duration' },
  { label: 'Motion', group: 'accessibility', words: 'reduce animation' },
  { label: 'Larger buttons', group: 'accessibility', words: 'touch targets' },
  { label: 'Custom CSS', group: 'advanced', words: 'style theme css' },
  { label: 'Effects and performance', group: 'advanced', words: 'lite blur performance' },
];

/* ---- Frecency: what you reach for, and how lately ---------------------- */

const FRECENCY_KEY = 'nvx.ancile.palette.frecency';
type Use = { n: number; last: number; label: string; kind: 'thread' | 'notebook' | 'command' };

function readUses(): Record<string, Use> {
  try {
    return JSON.parse(localStorage.getItem(FRECENCY_KEY) ?? '{}') as Record<string, Use>;
  } catch {
    return {};
  }
}
function recordUse(key: string, use: Omit<Use, 'n' | 'last'>): void {
  const all = readUses();
  const prev = all[key];
  all[key] = { ...use, n: (prev?.n ?? 0) + 1, last: Date.now() };
  const top = Object.entries(all)
    .sort((a, b) => score(b[1]) - score(a[1]))
    .slice(0, 60);
  try {
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(Object.fromEntries(top)));
  } catch {
    /* storage full or blocked */
  }
}
function score(u: Use): number {
  const hours = (Date.now() - u.last) / 3_600_000;
  return u.n / (1 + hours / 24);
}

/* ---- Message search ----------------------------------------------------- */

function useMessageSearch(q: string, enabled: boolean): { hits: ThreadSearchHit[]; busy: boolean } {
  const [hits, setHits] = useState<ThreadSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (!enabled || term.length < 3) {
      setHits([]);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(() => {
      api
        .get<{ items: ThreadSearchHit[] }>(`/threads/search?q=${encodeURIComponent(term)}&limit=8`)
        .then((r) => !cancelled && setHits(r.items))
        .catch(() => !cancelled && setHits([]))
        .finally(() => !cancelled && setBusy(false));
    }, 180);
    return () => {
      // A newer query (or leaving the scope) takes over; never leave the spinner on.
      cancelled = true;
      clearTimeout(t);
      setBusy(false);
    };
  }, [q, enabled]);
  return { hits, busy };
}

/** "the «match» in context" → a fragment with the match marked. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/«|»/);
  return (
    <span className="palette__snippet">
      {parts.map((p, i) =>
        // biome-ignore lint/suspicious/noArrayIndexKey: positional fragments of one string
        i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
      )}
    </span>
  );
}

interface Cmd {
  id: string;
  label: string;
  icon: IconName;
  binding?: string;
  words?: string;
  run: () => void;
  when?: boolean;
}

export function Palette() {
  const open = useUi((s) => s.paletteOpen);
  const initialScope = useUi((s) => s.paletteScope);
  const initialQuery = useUi((s) => s.paletteQuery);
  const openPalette = useUi((s) => s.openPalette);
  const close = useUi((s) => s.closePalette);
  const threadId = useThreadIdFromRoute();
  const models = useModels();
  const currentModel = useCurrentModel(threadId)?.id;
  const navigate = useNavigate();
  const notebooks = useNotebooks();
  const threads = useThreads();
  const startTour = useHelp((s) => s.startTour);
  const prefs = usePrefs((s) => s.prefs);
  const setPref = usePrefs((s) => s.set);
  const [value, setValue] = useState('');
  const repoCommands = useRepoCommands();
  useLayer(open);

  useBinding('palette.open', () => (open ? close() : openPalette()));
  useBinding('model.switch', () => openPalette('models'));
  useBinding('search.focus', () => openPalette('all'));

  useEffect(() => {
    if (!open) return;
    setValue(`${SCOPE_PREFIX[initialScope]}${initialQuery}`);
    helpDone('palette');
    tourEvent('palette-opened');
  }, [open, initialScope, initialQuery]);

  const scope: PaletteScope = PREFIX[value[0] ?? ''] ?? 'all';
  const query = scope === 'all' ? value : value.slice(1).trimStart();
  const show = (s: PaletteScope) => scope === 'all' || scope === s;
  const typed = query.trim().length > 0;
  const { hits, busy } = useMessageSearch(query, open && scope === 'all');
  // biome-ignore lint/correctness/useExhaustiveDependencies: show() is derived from scope
  const helpHits = useMemo(
    () => (show('help') && typed ? searchHelp(query).slice(0, 5) : []),
    [query, scope],
  );
  const uses = useMemo(() => (open ? readUses() : {}), [open]);

  const run = (fn: () => void, use?: { key: string; label: string; kind: Use['kind'] }) => {
    if (use) recordUse(use.key, { label: use.label, kind: use.kind });
    close();
    fn();
  };

  const thread = threadId ? threads.data?.find((t) => t.id === threadId) : undefined;
  const go = (to: string, params?: Record<string, string>) => () =>
    navigate({ to, ...(params && { params }) } as Parameters<typeof navigate>[0]);

  const allCommands: Cmd[] = [
    { id: 'new', label: 'New thread', icon: 'plus', binding: 'thread.new', run: go('/') },
    ...repoCommands,
    {
      id: 'new-notebook',
      label: 'New notebook',
      icon: 'notebook',
      words: 'create project',
      run: () => window.dispatchEvent(new CustomEvent('ancile:new-notebook')),
    },
    {
      id: 'model',
      label: 'Switch model',
      icon: 'model',
      binding: 'model.switch',
      run: () => setTimeout(() => openPalette('models'), 0),
    },
    {
      id: 'beam',
      label: 'Ask several models at once',
      icon: 'compare',
      words: 'beam fan out fuse compare models',
      run: () => openBeam({ threadId: thread?.id ?? null, notebookId: thread?.notebookId ?? null }),
    },
    {
      id: 'settings',
      label: 'Open settings',
      icon: 'settings',
      binding: 'settings.open',
      run: go('/settings/$group', { group: 'appearance' }),
    },
    {
      id: 'help',
      label: 'Open the guide',
      icon: 'book',
      binding: 'help.open',
      run: () => useUi.getState().setHelp(true),
    },
    {
      id: 'theme',
      label: 'Switch theme',
      icon: 'sun',
      binding: 'theme.toggle',
      run: () => useUi.getState().cycleTheme(),
    },
    {
      id: 'theme-system',
      label: 'Match system theme',
      icon: 'monitor',
      run: () => setPref('appearance', { theme: 'system' }),
    },
    {
      id: 'focus',
      label: useUi.getState().focusMode ? 'Leave focus mode' : 'Focus mode',
      icon: 'expand',
      binding: 'view.focus',
      words: 'zen distraction hide',
      run: () => useUi.getState().toggleFocus(),
    },
    {
      id: 'zoom-in',
      label: 'Zoom in',
      icon: 'plus',
      binding: 'zoom.in',
      run: () => setPref('appearance', { zoom: Math.min(1.4, prefs.appearance.zoom + 0.05) }),
    },
    {
      id: 'zoom-out',
      label: 'Zoom out',
      icon: 'minus',
      binding: 'zoom.out',
      run: () => setPref('appearance', { zoom: Math.max(0.8, prefs.appearance.zoom - 0.05) }),
    },
    {
      id: 'zoom-reset',
      label: 'Actual size',
      icon: 'search',
      binding: 'zoom.reset',
      run: () => setPref('appearance', { zoom: 1 }),
    },
    {
      id: 'rail',
      label: 'Show or hide the sidebar',
      icon: 'panelLeft',
      binding: 'rail.toggle',
      run: () => useUi.getState().toggleRail(),
    },
    {
      id: 'drawer',
      label: 'Show or hide the side panel',
      icon: 'panelRight',
      binding: 'drawer.toggle',
      run: () => useUi.getState().toggleDrawer(),
    },
    {
      id: 'grain',
      label: prefs.appearance.grain ? 'Turn film grain off' : 'Turn film grain on',
      icon: 'sparkle',
      run: () => setPref('appearance', { grain: !prefs.appearance.grain }),
    },
    {
      id: 'glass',
      label: prefs.appearance.material === 'glass' ? 'Use solid surfaces' : 'Use glass surfaces',
      icon: 'layout',
      run: () =>
        setPref('appearance', { material: prefs.appearance.material === 'glass' ? 'solid' : 'glass' }),
    },
    {
      id: 'notifications',
      label: 'Show notifications',
      icon: 'bell',
      binding: 'center.open',
      run: () => useUi.getState().setCenter(true),
    },
    {
      id: 'shortcuts',
      label: 'Show keyboard shortcuts',
      icon: 'keyboard',
      binding: 'shortcuts.show',
      run: () => useUi.getState().setShortcuts(true),
    },
    {
      id: 'admin',
      label: 'Open admin',
      icon: 'shield',
      binding: 'go.admin',
      run: go('/admin/$section', { section: 'health' }),
    },
    {
      id: 'logs',
      label: 'Go to logs',
      icon: 'logs',
      binding: 'go.logs',
      run: go('/admin/$section', { section: 'logs' }),
    },
    {
      id: 'flows',
      label: 'Open flows',
      icon: 'branch',
      words: 'routing router graph canvas pipeline team models',
      run: go('/flows'),
    },
    {
      id: 'memory',
      label: 'Search memory',
      icon: 'memory',
      run: go('/admin/$section', { section: 'memory' }),
    },
    {
      id: 'setup',
      label: 'Run setup again',
      icon: 'key',
      words: 'keys providers onboarding',
      run: go('/setup'),
    },
    // The thread on screen
    {
      id: 'pin',
      label: thread?.pinned ? 'Unpin this thread' : 'Pin this thread',
      icon: 'pin',
      when: !!thread,
      run: () => thread && void setPinned(thread.id, !thread.pinned),
    },
    {
      id: 'export',
      label: 'Export this thread as markdown',
      icon: 'download',
      when: !!threadId,
      run: () => threadId && exportThread(threadId),
    },
    {
      id: 'copy-link',
      label: 'Copy a link to this thread',
      icon: 'link',
      when: !!threadId,
      run: () => {
        void navigator.clipboard?.writeText(location.href);
        notify({ level: 'success', title: 'Link copied' });
      },
    },
    {
      id: 'archive',
      label: 'Archive this thread',
      icon: 'archive',
      when: !!thread,
      run: () => {
        if (!thread) return;
        void setArchived(thread.id, true, thread.title);
        void navigate({ to: '/' });
      },
    },
    {
      id: 'delete',
      label: 'Delete this thread',
      icon: 'trash',
      when: !!thread,
      run: () => thread && deleteThread(thread.id, thread.title, () => void navigate({ to: '/' })),
    },
    {
      id: 'tree',
      label: 'Show the branch tree',
      icon: 'tree',
      binding: 'go.tree',
      when: !!threadId,
      run: () => useBranchLayer.getState().setFull(true),
    },
    {
      id: 'tree-panel',
      label: 'Show the branch tree beside the thread',
      icon: 'panelRight',
      binding: 'drawer.tree',
      when: !!threadId,
      run: () => useUi.getState().openDrawer('tree'),
    },
    {
      id: 'compact',
      label: 'Compact this branch',
      icon: 'zap',
      words: 'context summary shorten tokens full',
      when: !!threadId && !useUi.getState().demo,
      run: () => threadId && void compactNow(threadId),
    },
    // Tours
    ...Object.values(TOURS).map((t) => ({
      id: `tour-${t.id}`,
      label: `Tour: ${t.title}`,
      icon: 'play' as IconName,
      words: 'learn guide walkthrough',
      run: () => startTour(t.id),
    })),
  ];
  const commands = allCommands.filter((c) => c.when !== false);

  const recent = Object.entries(uses)
    .sort((a, b) => score(b[1]) - score(a[1]))
    .slice(0, 5);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? openPalette() : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim scrim--palette" />
        <Dialog.Content
          className="palette m-glass-thick"
          aria-describedby={undefined}
          data-tour-target="palette-dialog"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command label="Command palette" shouldFilter loop>
            <div className="palette__input">
              <Icon name="search" />
              {scope !== 'all' ? <span className="palette__scope">{SCOPE_LABEL[scope]}</span> : null}
              <Command.Input
                value={scope === 'all' ? value : query}
                onValueChange={(v) => setValue(scope === 'all' ? v : `${SCOPE_PREFIX[scope]}${v}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Backspace' && scope !== 'all' && query === '') {
                    e.preventDefault();
                    setValue('');
                  }
                }}
                placeholder={PLACEHOLDER[scope]}
              />
              {busy ? <span className="palette__busy" role="status" aria-label="Searching messages" /> : null}
            </div>
            <Command.List className="palette__list">
              <Command.Empty className="palette__empty">
                {busy ? 'Searching messages…' : 'Nothing matches. Try fewer words, or ? to search the guide.'}
              </Command.Empty>

              {!typed && scope === 'all' && recent.length > 0 ? (
                <Command.Group heading="Recent">
                  {recent.map(([key, u]) => {
                    const [kind, id] = key.split(':') as [Use['kind'], string];
                    const cmd = kind === 'command' ? commands.find((c) => c.id === id) : undefined;
                    if (kind === 'command' && !cmd) return null;
                    return (
                      <Command.Item
                        key={`recent-${key}`}
                        value={`recent ${key} ${u.label}`}
                        onSelect={() =>
                          run(
                            () => {
                              if (cmd) cmd.run();
                              else if (kind === 'thread')
                                void navigate({ to: '/t/$threadId', params: { threadId: id } });
                              else void navigate({ to: '/n/$notebookId', params: { notebookId: id } });
                            },
                            { key, label: u.label, kind },
                          )
                        }
                      >
                        <Icon name={cmd?.icon ?? (kind === 'thread' ? 'thread' : 'notebook')} size={15} />
                        <span className="palette__label">{u.label}</span>
                        <span className="mute palette__meta">
                          {kind === 'command' ? 'Command' : kind === 'thread' ? 'Thread' : 'Notebook'}
                        </span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}

              {scope === 'all' && hits.length > 0 ? (
                <Command.Group heading="In messages">
                  {hits.map((h) => (
                    <Command.Item
                      key={`${h.thread_id}-${h.message_id}`}
                      value={`message ${h.message_id} ${query} ${h.title}`}
                      onSelect={() =>
                        run(
                          () =>
                            navigate({
                              to: '/t/$threadId',
                              params: { threadId: h.thread_id },
                              hash: h.message_id,
                            }),
                          {
                            key: `thread:${h.thread_id}`,
                            label: h.title,
                            kind: 'thread',
                          },
                        )
                      }
                    >
                      <Icon name="quote" size={15} />
                      <span className="palette__stack">
                        <span className="palette__label">{h.title}</span>
                        <Snippet text={h.snippet} />
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {show('commands') && (scope === 'commands' || typed) ? (
                <Command.Group heading="Commands">
                  {commands.map((c) => (
                    <Command.Item
                      key={c.id}
                      value={`command ${c.label} ${c.words ?? ''}`}
                      onSelect={() => run(c.run, { key: `command:${c.id}`, label: c.label, kind: 'command' })}
                    >
                      <Icon name={c.icon} size={15} />
                      <span className="palette__label">{c.label}</span>
                      {c.binding ? <Kbd keys={keysFor(c.binding) ?? ''} binding={c.binding} /> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {show('models') && (scope === 'models' || typed) ? (
                <Command.Group heading="Models">
                  {(models.data ?? [])
                    .filter((m) => m.chat !== false)
                    .map((m) => (
                      <Command.Item
                        key={m.id}
                        value={`model ${m.name} ${m.provider} ${m.id}`}
                        data-unavailable={m.status && m.status !== 'ready' ? true : undefined}
                        onSelect={() =>
                          run(() => {
                            if (threadId) void chooseModel(m, threadId);
                            else {
                              void chooseModel(m);
                              if (!m.status || m.status === 'ready')
                                notify({
                                  level: 'success',
                                  title: `New threads use ${m.name}`,
                                  body: 'Change it any time with M.',
                                });
                            }
                          })
                        }
                      >
                        <span
                          className="palette__swatch"
                          style={{ '--hue': hueVar(m.hue) } as CSSProperties}
                        />
                        <span className="palette__label">{m.name}</span>
                        <span className="mute palette__meta">
                          {m.offline ? "Try-out · doesn't use AI" : (m.note ?? m.provider)}
                        </span>
                        {m.id === currentModel ? <span className="palette__current">Current</span> : null}
                      </Command.Item>
                    ))}
                </Command.Group>
              ) : null}

              {show('notebooks') && (scope === 'notebooks' || typed) ? (
                <Command.Group heading="Notebooks">
                  {(notebooks.data ?? []).map((n) => (
                    <Command.Item
                      key={n.id}
                      value={`notebook ${n.id} ${n.title}`}
                      onSelect={() =>
                        run(() => navigate({ to: '/n/$notebookId', params: { notebookId: n.id } }), {
                          key: `notebook:${n.id}`,
                          label: n.title,
                          kind: 'notebook',
                        })
                      }
                    >
                      <span
                        className="palette__swatch"
                        style={{ '--hue': hueVar((n.color as Hue) ?? 'chalk') } as CSSProperties}
                      />
                      <span className="palette__label">{n.title}</span>
                      <span className="mute palette__meta" data-num>
                        {n.sources} {n.sources === 1 ? 'source' : 'sources'}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {scope === 'all' && typed ? (
                <Command.Group heading="Threads">
                  {(threads.data ?? []).map((t) => (
                    <Command.Item
                      key={t.id}
                      value={`thread ${t.id} ${t.title}`}
                      onSelect={() =>
                        run(() => navigate({ to: '/t/$threadId', params: { threadId: t.id } }), {
                          key: `thread:${t.id}`,
                          label: t.title,
                          kind: 'thread',
                        })
                      }
                    >
                      <Icon
                        name={t.pinned ? 'pin' : 'thread'}
                        size={15}
                        className={t.pinned ? 'gilt-ink' : undefined}
                      />
                      <span className="palette__label" dir="auto">
                        {t.title}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {show('settings') && (scope === 'settings' || typed) ? (
                <Command.Group heading="Settings">
                  {SETTINGS_INDEX.map((s) => (
                    <Command.Item
                      key={s.label}
                      value={`setting ${s.label} ${s.words}`}
                      onSelect={() =>
                        run(() => navigate({ to: '/settings/$group', params: { group: s.group } }))
                      }
                    >
                      <Icon name="settings" size={15} />
                      <span className="palette__label">{s.label}</span>
                      <span className="mute palette__meta">
                        {s.group[0]?.toUpperCase() + s.group.slice(1)}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {helpHits.length > 0 || (scope === 'help' && !typed) ? (
                <Command.Group heading="Guide">
                  {helpHits.map((a) => (
                    <Command.Item
                      key={a.id}
                      value={`help ${a.id} ${a.title} ${query}`}
                      onSelect={() => run(() => useUi.getState().setHelp(true, a.id))}
                    >
                      <Icon name="book" size={15} />
                      <span className="palette__stack">
                        <span className="palette__label">{a.title}</span>
                        <span className="mute palette__snippet">{a.summary}</span>
                      </span>
                    </Command.Item>
                  ))}
                  {scope === 'help' && !typed ? (
                    <Command.Item
                      value="help open guide"
                      onSelect={() => run(() => useUi.getState().setHelp(true))}
                    >
                      <Icon name="book" size={15} />
                      <span className="palette__label">Open the guide</span>
                    </Command.Item>
                  ) : null}
                </Command.Group>
              ) : null}

              {!typed && scope === 'all' ? (
                <Command.Group heading="Start here">
                  {commands.slice(0, 6).map((c) => (
                    <Command.Item
                      key={`start-${c.id}`}
                      value={`start ${c.label}`}
                      onSelect={() => run(c.run, { key: `command:${c.id}`, label: c.label, kind: 'command' })}
                    >
                      <Icon name={c.icon} size={15} />
                      <span className="palette__label">{c.label}</span>
                      {c.binding ? <Kbd keys={keysFor(c.binding) ?? ''} binding={c.binding} /> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
            </Command.List>
            <footer className="palette__foot">
              <span>
                <Kbd keys="enter" /> open
              </span>
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move
              </span>
              <span className="palette__prefixes">
                <kbd>&gt;</kbd> commands <kbd>@</kbd> models <kbd>#</kbd> notebooks <kbd>?</kbd> guide{' '}
                <kbd>,</kbd> settings
              </span>
            </footer>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
