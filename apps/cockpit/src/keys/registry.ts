/**
 * ------------------------------------------------------------------
 *  Title    |  The keymap
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every action has a key, and every key is declared here
 *           |  once: the `?` overlay, palette hints and tooltips all
 *           |  read this table, so they can never disagree.
 *  How      |  Bindings are data (id, keys, label, group, scope).
 *           |  Handlers attach at runtime with useBinding(id, fn), so
 *           |  a key does nothing on screens where it means nothing.
 *  Note     |  Keys: "mod" is ⌘ on macOS, Ctrl elsewhere. A space
 *           |  separates a sequence ("g n"). A person's own keys
 *           |  (Settings → Keyboard) override the defaults through
 *           |  setOverrides(); keysFor() is what everything displays.
 * ------------------------------------------------------------------
 */

export type Scope = 'global' | 'list' | 'thread' | 'tree' | 'flow';
export type Group = 'Everywhere' | 'Go to' | 'View' | 'Lists' | 'Thread' | 'Branch tree' | 'Flow editor';

export interface BindingDef {
  id: string;
  keys: string;
  label: string;
  group: Group;
  scope: Scope;
  /** Fires even while typing in an input (mod chords, Escape). */
  inInputs?: boolean;
}

export const BINDINGS: readonly BindingDef[] = [
  {
    id: 'palette.open',
    keys: 'mod+k',
    label: 'Open the command palette',
    group: 'Everywhere',
    scope: 'global',
    inInputs: true,
  },
  { id: 'search.focus', keys: '/', label: 'Search', group: 'Everywhere', scope: 'global' },
  { id: 'shortcuts.show', keys: '?', label: 'Show shortcuts', group: 'Everywhere', scope: 'global' },
  {
    id: 'layer.close',
    keys: 'escape',
    label: 'Close, or leave the composer',
    group: 'Everywhere',
    scope: 'global',
    inInputs: true,
  },
  { id: 'rail.toggle', keys: '[', label: 'Show or hide the sidebar', group: 'Everywhere', scope: 'global' },
  {
    id: 'drawer.toggle',
    keys: ']',
    label: 'Show or hide the side panel',
    group: 'Everywhere',
    scope: 'global',
  },
  {
    id: 'thread.new',
    keys: 'mod+shift+o',
    label: 'New thread, even while typing',
    group: 'Everywhere',
    scope: 'global',
    inInputs: true,
  },
  { id: 'model.switch', keys: 'm', label: 'Change model', group: 'Everywhere', scope: 'global' },
  {
    id: 'theme.toggle',
    keys: 'mod+shift+l',
    label: 'Switch theme',
    group: 'Everywhere',
    scope: 'global',
    inInputs: true,
  },
  { id: 'thread.quick', keys: 'n', label: 'New thread', group: 'Everywhere', scope: 'global' },
  {
    id: 'settings.open',
    keys: 'mod+,',
    label: 'Settings',
    group: 'Everywhere',
    scope: 'global',
    inInputs: true,
  },
  { id: 'help.open', keys: 'g h', label: 'Help', group: 'Go to', scope: 'global' },
  { id: 'center.open', keys: 'g i', label: 'Notifications', group: 'Go to', scope: 'global' },
  { id: 'rail.filter', keys: 'g f', label: 'Filter the sidebar', group: 'Go to', scope: 'global' },
  { id: 'go.settings', keys: 'g s', label: 'Settings', group: 'Go to', scope: 'global' },
  { id: 'history.back', keys: 'mod+[', label: 'Back', group: 'Go to', scope: 'global', inInputs: true },
  { id: 'history.forward', keys: 'mod+]', label: 'Forward', group: 'Go to', scope: 'global', inInputs: true },

  { id: 'view.focus', keys: 'mod+.', label: 'Focus mode', group: 'View', scope: 'global', inInputs: true },
  { id: 'zoom.in', keys: 'mod+=', label: 'Zoom in', group: 'View', scope: 'global', inInputs: true },
  { id: 'zoom.out', keys: 'mod+-', label: 'Zoom out', group: 'View', scope: 'global', inInputs: true },
  { id: 'zoom.reset', keys: 'mod+0', label: 'Actual size', group: 'View', scope: 'global', inInputs: true },
  { id: 'drawer.sources', keys: 'alt+1', label: 'Sources panel', group: 'View', scope: 'global' },
  { id: 'drawer.notes', keys: 'alt+2', label: 'Notes panel', group: 'View', scope: 'global' },
  { id: 'drawer.tree', keys: 'alt+3', label: 'Branch tree panel', group: 'View', scope: 'global' },
  { id: 'drawer.why', keys: 'alt+4', label: 'Why panel', group: 'View', scope: 'global' },

  { id: 'go.notebooks', keys: 'g n', label: 'Notebooks', group: 'Go to', scope: 'global' },
  { id: 'go.threads', keys: 'g t', label: 'Threads', group: 'Go to', scope: 'global' },
  { id: 'go.tree', keys: 'g b', label: 'Branch tree, full screen', group: 'Go to', scope: 'global' },
  { id: 'go.admin', keys: 'g a', label: 'Admin', group: 'Go to', scope: 'global' },
  { id: 'go.logs', keys: 'g l', label: 'Logs', group: 'Go to', scope: 'global' },

  { id: 'list.down', keys: 'j', label: 'Next item', group: 'Lists', scope: 'list' },
  { id: 'list.up', keys: 'k', label: 'Previous item', group: 'Lists', scope: 'list' },
  { id: 'list.open', keys: 'enter', label: 'Open', group: 'Lists', scope: 'list' },

  { id: 'composer.focus', keys: 'i', label: 'Write a message', group: 'Thread', scope: 'thread' },
  { id: 'message.edit', keys: 'e', label: 'Edit', group: 'Thread', scope: 'thread' },
  { id: 'message.regenerate', keys: 'r', label: 'Regenerate', group: 'Thread', scope: 'thread' },
  { id: 'message.lab', keys: 'x', label: 'Run in the lab', group: 'Thread', scope: 'thread' },
  { id: 'message.branch', keys: 'b', label: 'Branch from here', group: 'Thread', scope: 'thread' },
  { id: 'message.factcheck', keys: 'f', label: 'Fact-check', group: 'Thread', scope: 'thread' },
  { id: 'message.why', keys: 'w', label: 'Why did it say this?', group: 'Thread', scope: 'thread' },
  { id: 'message.copy', keys: 'c', label: 'Copy', group: 'Thread', scope: 'thread' },
  { id: 'message.cite', keys: 's', label: 'Show sources', group: 'Thread', scope: 'thread' },
  { id: 'message.note', keys: 'shift+n', label: 'Save as note', group: 'Thread', scope: 'thread' },
  { id: 'sibling.prev', keys: 'alt+[', label: 'Previous version', group: 'Thread', scope: 'thread' },
  { id: 'sibling.next', keys: 'alt+]', label: 'Next version', group: 'Thread', scope: 'thread' },
  {
    id: 'message.delete',
    keys: 'shift+backspace',
    label: 'Delete from here',
    group: 'Thread',
    scope: 'thread',
  },

  { id: 'tree.parent', keys: 'k', label: 'Parent', group: 'Branch tree', scope: 'tree' },
  { id: 'tree.child', keys: 'j', label: 'Child', group: 'Branch tree', scope: 'tree' },
  { id: 'tree.prevSibling', keys: 'h', label: 'Previous sibling', group: 'Branch tree', scope: 'tree' },
  { id: 'tree.nextSibling', keys: 'l', label: 'Next sibling', group: 'Branch tree', scope: 'tree' },
  {
    id: 'tree.open',
    keys: 'enter',
    label: 'Jump the conversation there',
    group: 'Branch tree',
    scope: 'tree',
  },
  { id: 'tree.compare', keys: 'c', label: 'Compare with where you are', group: 'Branch tree', scope: 'tree' },

  // The flow editor handles these on the canvas itself (flows/FlowEditor.tsx).
  { id: 'flow.add', keys: 'tab', label: 'Add a node', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.delete', keys: 'delete', label: 'Delete the selection', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.duplicate', keys: 'mod+d', label: 'Duplicate', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.copy', keys: 'mod+c', label: 'Copy', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.cut', keys: 'mod+x', label: 'Cut', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.paste', keys: 'mod+v', label: 'Paste', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.undo', keys: 'mod+z', label: 'Undo', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.redo', keys: 'mod+shift+z', label: 'Redo', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.selectAll', keys: 'mod+a', label: 'Select everything', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.group', keys: 'mod+g', label: 'Group the selection', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.ungroup', keys: 'mod+shift+g', label: 'Ungroup', group: 'Flow editor', scope: 'flow' },
  {
    id: 'flow.subflow',
    keys: 'mod+alt+g',
    label: 'Collapse into a subflow',
    group: 'Flow editor',
    scope: 'flow',
  },
  { id: 'flow.fit', keys: 'f', label: 'Zoom to fit', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.layout', keys: 'l', label: 'Tidy the layout', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.pin', keys: 'p', label: 'Pin or unpin an output', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.bypass', keys: 'b', label: 'Bypass or restore', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.save', keys: 'mod+s', label: 'Save', group: 'Flow editor', scope: 'flow', inInputs: true },
  {
    id: 'flow.try',
    keys: 'mod+enter',
    label: 'Try a message',
    group: 'Flow editor',
    scope: 'flow',
    inInputs: true,
  },
  { id: 'flow.issues', keys: 'i', label: 'Show what to fix', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.versions', keys: 'v', label: 'Versions and publishing', group: 'Flow editor', scope: 'flow' },
  { id: 'flow.panel', keys: 'enter', label: 'Open the selected node', group: 'Flow editor', scope: 'flow' },
] as const;

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Canonical form: lowercase, modifiers sorted, so "Shift+Mod+O" == "mod+shift+o". */
export function normalise(keys: string): string {
  return keys
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.toLowerCase().split('+');
      const key = parts.pop() ?? '';
      const mods = parts.filter(Boolean).sort();
      return [...mods, key].join('+');
    })
    .join(' ');
}

/** Scopes that are live at the same time and so must not share a key. */
const OVERLAPS: Record<Scope, Scope[]> = {
  global: ['global', 'list', 'thread', 'tree', 'flow'],
  list: ['global', 'list'],
  thread: ['global', 'thread'],
  tree: ['global', 'tree'],
  flow: ['global', 'flow'],
};

export interface Conflict {
  a: string;
  b: string;
  keys: string;
}

/**
 * Two bindings conflict when their scopes can be active together and one
 * key sequence equals, or is a prefix of, the other ("g" vs "g n").
 */
export function findConflicts(bindings: readonly BindingDef[] = BINDINGS): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < bindings.length; i++) {
    for (let j = i + 1; j < bindings.length; j++) {
      const a = bindings[i];
      const b = bindings[j];
      if (!a || !b) continue;
      if (!OVERLAPS[a.scope].includes(b.scope)) continue;
      const ka = normalise(a.keys);
      const kb = normalise(b.keys);
      if (ka === kb || ka.startsWith(`${kb} `) || kb.startsWith(`${ka} `))
        out.push({ a: a.id, b: b.id, keys: ka });
    }
  }
  return out;
}

let overrides: Record<string, string> = {};
const listeners = new Set<() => void>();

/** A person's own keys, by binding id. Invalid or empty entries are ignored. */
export function setOverrides(next: Record<string, string>): void {
  const clean: Record<string, string> = {};
  for (const [id, keys] of Object.entries(next)) {
    if (keys.trim() && BINDINGS.some((b) => b.id === id)) clean[id] = normalise(keys);
  }
  if (JSON.stringify(clean) === JSON.stringify(overrides)) return;
  overrides = clean;
  for (const fn of listeners) fn();
}

/**
 * Defaults moved so the browser cannot swallow them (keys/browser.ts).
 * They sit under a person's own keys and over the defaults.
 */
let safe: Record<string, string> = {};

export function setBrowserSafe(next: Readonly<Record<string, string>>): void {
  const clean: Record<string, string> = {};
  for (const [id, keys] of Object.entries(next))
    if (BINDINGS.some((b) => b.id === id)) clean[id] = normalise(keys);
  if (JSON.stringify(clean) === JSON.stringify(safe)) return;
  safe = clean;
  for (const fn of listeners) fn();
}

/** The keys a binding has with no override: the browser-safe one, else the default. */
export function baseKeys(id: string): string | undefined {
  return safe[id] ?? BINDINGS.find((b) => b.id === id)?.keys;
}

export function onOverridesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The keys in force for a binding: the person's own, else browser-safe, else the default. */
export function keysFor(id: string): string | undefined {
  return overrides[id] ?? baseKeys(id);
}

/** The bindings with a person's overrides applied. */
export function effectiveBindings(): BindingDef[] {
  return BINDINGS.map((b) => {
    const keys = overrides[b.id] ?? safe[b.id];
    return keys ? { ...b, keys } : b;
  });
}

export function bindingById(id: string): BindingDef | undefined {
  const b = BINDINGS.find((x) => x.id === id);
  const keys = overrides[id] ?? safe[id];
  return b && keys ? { ...b, keys } : b;
}

/** A binding's keys as plain text for copy ("Ctrl K", or "⌘K" on a Mac), following rebinds. */
export function keyText(id: string): string {
  const b = bindingById(id);
  if (!b) return '';
  return displayKeys(b.keys)
    .map((chord) => chord.join(isMac ? '' : ' '))
    .join(' then ');
}

/** Render keys for display: "mod+shift+o" → ["⌘", "⇧", "O"] */
export function displayKeys(keys: string): string[][] {
  const names: Record<string, string> = {
    mod: isMac ? '⌘' : 'Ctrl',
    shift: '⇧',
    alt: isMac ? '⌥' : 'Alt',
    escape: 'Esc',
    enter: '↵',
  };
  return normalise(keys)
    .split(' ')
    .map((chord) => chord.split('+').map((k) => names[k] ?? (k.length === 1 ? k.toUpperCase() : k)));
}
