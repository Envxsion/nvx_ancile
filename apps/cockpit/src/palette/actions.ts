/**
 * ------------------------------------------------------------------
 *  Title    |  Palette actions
 *  Ref      |  ROADMAP KP1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every palette result does one thing on Enter. This is
 *           |  the rest: the actions on the highlighted result, in
 *           |  the panel Tab (or Ctrl+Enter) opens. A thread can be
 *           |  opened in a new window, pinned, moved, archived,
 *           |  copied as a link, exported or moved to the Trash; a
 *           |  notebook opened, started in or copied; a model made
 *           |  the default; a setting changed to any of its choices.
 *  How      |  targetOf() reads the highlighted item's value (the same
 *           |  "kind id ..." the prefetch reads). The builders return
 *           |  plain actions with what they need passed in, so they
 *           |  are tested without a screen. Every change goes through
 *           |  the functions the rest of the app uses (lib/threads,
 *           |  lib/models, the preferences store), so Undo, the
 *           |  Trash and scope checks are the same ones.
 *  Note     |  Nothing destructive happens without Undo: archive,
 *           |  move and delete all raise the Undo notice; delete goes
 *           |  to the Trash, kept for 30 days. A choice setting
 *           |  previews while you move over it and goes back when you
 *           |  leave the panel without choosing.
 * ------------------------------------------------------------------
 */

import type { Preferences } from '@nvx/contracts';
import type { ModelView, NotebookView, ThreadSummary } from '../lib/types';
import type { IconName } from '../ui/Icon';
import { currentOf, type Pick, type SettingDef } from './settingsIndex';

export type Target =
  | { kind: 'thread'; id: string }
  | { kind: 'notebook'; id: string }
  | { kind: 'model'; id: string }
  | { kind: 'setting'; id: string }
  | { kind: 'command'; id: string };

/** What the highlighted palette item stands for, from its cmdk value ("thread <id> <title>"). */
export function targetOf(value: string): Target | null {
  const m = /^(?:recent (thread|notebook):|(thread|notebook|model|setting|command) )(\S+)/.exec(value);
  if (!m) return null;
  return { kind: (m[1] ?? m[2]) as Target['kind'], id: m[3] as string };
}

export interface PanelAction {
  id: string;
  label: string;
  icon: IconName;
  /** A few words beside the label: where it goes, what it does. */
  hint?: string;
  /** The palette stays open after it runs. */
  keepOpen?: boolean;
  /** Takes something away; the label says it, Undo or the Trash brings it back. */
  danger?: boolean;
  /** The value a choice already has. */
  current?: boolean;
  /** A choice that shows itself while you move over it. */
  preview?: { apply: () => void; revert: () => void };
  run: () => void | Promise<void>;
}

export interface ActionDeps {
  origin: string;
  /** The thread on screen, for "use in this thread". */
  threadId: string | undefined;
  threads: ThreadSummary[];
  notebooks: NotebookView[];
  models: ModelView[];
  prefs: Preferences;
  open: (to: string, params?: Record<string, string>, search?: Record<string, string>) => void;
  openWindow: (url: string) => void;
  copy: (text: string) => void;
  say: (n: { level: 'success' | 'info' | 'warn'; title: string; body?: string }) => void;
  threadsApi: {
    setPinned: (id: string, pinned: boolean) => Promise<void> | void;
    setArchived: (id: string, archived: boolean, title?: string) => Promise<void> | void;
    moveThread: (id: string, notebookId: string | null, title?: string) => Promise<void> | void;
    deleteThread: (id: string, title: string) => void;
    exportThread: (id: string) => Promise<void> | void;
  };
  chooseModel: (m: ModelView, threadId?: string) => Promise<void> | void;
  setPref: (group: string, patch: Record<string, unknown>) => void;
}

const MOVE_LIMIT = 8;

export function threadActions(id: string, d: ActionDeps): PanelAction[] {
  const t = d.threads.find((x) => x.id === id);
  if (!t) return [];
  const url = `${d.origin}/t/${id}`;
  const out: PanelAction[] = [
    {
      id: 'open',
      label: 'Open',
      icon: 'thread',
      run: () => d.open('/t/$threadId', { threadId: id }),
    },
    {
      id: 'open-window',
      label: 'Open in a new window',
      icon: 'ext',
      run: () => d.openWindow(url),
    },
    {
      id: 'pin',
      label: t.pinned ? 'Unpin' : 'Pin',
      icon: 'pin',
      run: () => d.threadsApi.setPinned(id, !t.pinned),
    },
  ];
  // Moving: every notebook but the one it is in, then out of its notebook.
  const targets = d.notebooks.filter((n) => !n.archived && n.id !== t.notebookId).slice(0, MOVE_LIMIT);
  for (const n of targets)
    out.push({
      id: `move:${n.id}`,
      label: `Move to ${n.title}`,
      icon: 'notebook',
      run: () => d.threadsApi.moveThread(id, n.id, n.title),
    });
  if (t.notebookId)
    out.push({
      id: 'move:none',
      label: 'Move out of its notebook',
      icon: 'notebook',
      run: () => d.threadsApi.moveThread(id, null),
    });
  out.push(
    {
      id: 'copy-link',
      label: 'Copy a link',
      icon: 'link',
      run: () => {
        d.copy(url);
        d.say({ level: 'success', title: 'Link copied' });
      },
    },
    {
      id: 'export',
      label: 'Export this thread',
      icon: 'download',
      run: () => d.threadsApi.exportThread(id),
    },
    {
      id: 'archive',
      label: t.archived ? 'Restore from the archive' : 'Archive',
      icon: 'archive',
      hint: 'Undo is one press',
      run: () => d.threadsApi.setArchived(id, !t.archived, t.title),
    },
    {
      id: 'delete',
      label: 'Move to the Trash',
      icon: 'trash',
      danger: true,
      hint: 'Kept for 30 days',
      run: () => d.threadsApi.deleteThread(id, t.title),
    },
  );
  return out;
}

export function notebookActions(id: string, d: ActionDeps): PanelAction[] {
  const n = d.notebooks.find((x) => x.id === id);
  if (!n) return [];
  const url = `${d.origin}/n/${id}`;
  return [
    { id: 'open', label: 'Open', icon: 'notebook', run: () => d.open('/n/$notebookId', { notebookId: id }) },
    {
      id: 'new-thread',
      label: 'Start a thread here',
      icon: 'plus',
      run: () => d.open('/', undefined, { notebook: id }),
    },
    { id: 'open-window', label: 'Open in a new window', icon: 'ext', run: () => d.openWindow(url) },
    {
      id: 'copy-link',
      label: 'Copy a link',
      icon: 'link',
      run: () => {
        d.copy(url);
        d.say({ level: 'success', title: 'Link copied' });
      },
    },
  ];
}

export function modelActions(id: string, d: ActionDeps): PanelAction[] {
  const m = d.models.find((x) => x.id === id);
  // A model that cannot answer has nothing to make the default of; its row says what it needs.
  if (!m || (m.status && m.status !== 'ready')) return [];
  const out: PanelAction[] = [
    {
      id: 'make-default',
      label: 'Make default for new threads',
      icon: 'model',
      run: async () => {
        await d.chooseModel(m);
        d.say({ level: 'success', title: `New threads use ${m.name}`, body: 'Change it any time with M.' });
      },
    },
  ];
  if (d.threadId)
    out.unshift({
      id: 'use-here',
      label: 'Use in this thread',
      icon: 'thread',
      run: () => d.chooseModel(m, d.threadId),
    });
  return out;
}

/** A setting's choices, each applied as you move over it and kept when you choose it. */
export function settingActions(def: SettingDef, d: ActionDeps): PanelAction[] {
  if (def.kind === 'opens') return [];
  const cur = currentOf(d.prefs, def);
  const set = (patch: Record<string, unknown>) => d.setPref(def.prefGroup, patch);
  if (def.kind === 'toggle')
    return [true, false].map((on) => ({
      id: on ? 'on' : 'off',
      label: on ? (def.on ?? 'On') : (def.off ?? 'Off'),
      icon: 'settings' as IconName,
      keepOpen: true,
      current: !!cur === on,
      preview: { apply: () => set({ [def.pref]: on }), revert: () => set({ [def.pref]: !!cur }) },
      run: () => set({ [def.pref]: on }),
    }));
  const pick: Pick = def;
  return pick.options.map((o) => ({
    id: o.value,
    label: o.label,
    icon: 'settings' as IconName,
    keepOpen: true,
    current: o.value === cur,
    preview: { apply: () => set({ [pick.pref]: o.value }), revert: () => set({ [pick.pref]: cur }) },
    run: () => set({ [pick.pref]: o.value }),
  }));
}

/** The actions for a highlighted result, or none. */
export function actionsFor(t: Target | null, d: ActionDeps, def?: SettingDef): PanelAction[] {
  if (!t) return [];
  switch (t.kind) {
    case 'thread':
      return threadActions(t.id, d);
    case 'notebook':
      return notebookActions(t.id, d);
    case 'model':
      return modelActions(t.id, d);
    case 'setting':
      return def ? settingActions(def, d) : [];
    default:
      return [];
  }
}
