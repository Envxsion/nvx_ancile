/**
 * ------------------------------------------------------------------
 *  Title    |  Settings
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Make NVX Ancile yours: every preference in one place,
 *           |  searchable, each change live, each one reversible, and
 *           |  the lot portable as one file.
 *  How      |  /settings/$group. Search filters rows across every
 *           |  group at once. Import shows exactly what would change
 *           |  before it changes anything.
 * ------------------------------------------------------------------
 */

import { DEFAULT_PREFERENCES, Preferences, type PrefGroup } from '@nvx/contracts';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { helpDone } from '../../help/store';
import { ProSurfaceView } from '../../pro/slot';
import { notify } from '../../state/notify';
import { usePrefs } from '../../state/prefs';
import { useUi } from '../../state/ui';
import { PrivacyGroup } from '../../telemetry/ShareStats';
import { Icon, type IconName } from '../../ui/Icon';
import { Kbd } from '../../ui/primitives';
import {
  AccessibilityGroup,
  AdvancedGroup,
  AppearanceGroup,
  ComposerGroup,
  LayoutGroup,
  NotificationsGroup,
  ReadingGroup,
} from './groups';
import { KeyboardGroup } from './Keyboard';
import { SearchContext } from './rows';

const GROUPS: {
  id: PrefGroup | 'about' | 'privacy' | 'sync';
  label: string;
  icon: IconName;
  body: () => ReactNode;
  lede: string;
}[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'paint',
    body: AppearanceGroup,
    lede: 'Theme, colour, materials and type.',
  },
  {
    id: 'layout',
    label: 'Layout',
    icon: 'layout',
    body: LayoutGroup,
    lede: 'Density, panels and the status bar.',
  },
  { id: 'reading', label: 'Reading', icon: 'book', body: ReadingGroup, lede: 'How answers read.' },
  { id: 'composer', label: 'Composer', icon: 'edit', body: ComposerGroup, lede: 'Writing and snippets.' },
  {
    id: 'keyboard',
    label: 'Keyboard',
    icon: 'keyboard',
    body: KeyboardGroup,
    lede: 'Every shortcut, changeable.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: 'bell',
    body: NotificationsGroup,
    lede: 'What pops up, where, for how long.',
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    icon: 'eye',
    body: AccessibilityGroup,
    lede: 'Motion, transparency and targets.',
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: 'shield',
    body: PrivacyGroup,
    lede: 'What NVX Ancile may share about how it is used.',
  },
  {
    id: 'sync',
    label: 'Sync',
    icon: 'globe',
    body: () => <ProSurfaceView id="sync" />,
    lede: 'Your workspace on every computer, encrypted before it leaves this one.',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: 'command',
    body: AdvancedGroup,
    lede: 'Effects, hints and your own CSS.',
  },
];

type Diff = { group: PrefGroup; key: string; from: unknown; to: unknown };

function diff(a: Preferences, b: Preferences): Diff[] {
  const out: Diff[] = [];
  for (const g of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
    if (g === 'version') continue;
    const ga = a[g] as Record<string, unknown>;
    const gb = b[g] as Record<string, unknown>;
    for (const k of Object.keys(gb)) {
      if (JSON.stringify(ga[k]) !== JSON.stringify(gb[k]))
        out.push({ group: g, key: k, from: ga[k], to: gb[k] });
    }
  }
  return out;
}

const show = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
};

function ImportPreview({ next, onDone }: { next: Preferences; onDone: () => void }) {
  const prefs = usePrefs((s) => s.prefs);
  const replace = usePrefs((s) => s.replace);
  const changes = diff(prefs, next);
  const groups = [...new Set(changes.map((c) => c.group))];
  const [picked, setPicked] = useState<Set<PrefGroup>>(new Set(groups));
  const apply = () => {
    const merged = { ...prefs };
    for (const g of picked) (merged as Record<string, unknown>)[g] = next[g];
    replace(merged);
    notify({
      level: 'success',
      title: 'Settings imported',
      body: `${picked.size} ${picked.size === 1 ? 'group' : 'groups'} changed.`,
    });
    onDone();
  };
  return (
    <div className="import-preview m-raised">
      <header>
        <h3>Import settings</h3>
        <p className="mute">
          {changes.length === 0
            ? 'This file matches your settings already.'
            : `${changes.length} ${changes.length === 1 ? 'setting' : 'settings'} would change. Untick a group to leave it as it is.`}
        </p>
      </header>
      {groups.map((g) => (
        <fieldset key={g} className="import-preview__group">
          <label className="import-preview__head">
            <input
              type="checkbox"
              checked={picked.has(g)}
              onChange={(e) =>
                setPicked((s) => {
                  const n = new Set(s);
                  if (e.target.checked) n.add(g);
                  else n.delete(g);
                  return n;
                })
              }
            />
            <span>{GROUPS.find((x) => x.id === g)?.label ?? g}</span>
          </label>
          <ul>
            {changes
              .filter((c) => c.group === g)
              .map((c) => (
                <li key={c.key}>
                  <span className="mute">{c.key}</span>
                  <span data-num>{show(c.from)}</span>
                  <Icon name="arrowRight" size={11} />
                  <span data-num>{show(c.to)}</span>
                </li>
              ))}
          </ul>
        </fieldset>
      ))}
      <footer>
        <button type="button" className="btn btn--quiet btn--sm" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={apply}
          disabled={picked.size === 0}
        >
          Apply {picked.size === groups.length ? 'all' : picked.size}
        </button>
      </footer>
    </div>
  );
}

export function SettingsScreen() {
  const { group } = useParams({ strict: false }) as { group?: string };
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [incoming, setIncoming] = useState<Preferences | null>(null);
  const prefs = usePrefs((s) => s.prefs);
  const changedAt = usePrefs((s) => s.changedAt);
  const reset = usePrefs((s) => s.reset);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const current = GROUPS.find((g) => g.id === group) ?? GROUPS[0];
  const opened = useRef(changedAt);

  // Changing anything here ticks "Make it yours" on the checklist.
  useEffect(() => {
    if (changedAt !== opened.current) helpDone('settings');
  }, [changedAt]);

  useEffect(() => {
    // Hints say "Settings → Models"; models live in Admin, so follow the hint there.
    if (group === 'models')
      void navigate({ to: '/admin/$section', params: { section: 'models' }, replace: true });
    else if (!GROUPS.some((g) => g.id === group))
      void navigate({ to: '/settings/$group', params: { group: 'appearance' }, replace: true });
  }, [group, navigate]);

  const exportFile = () => {
    const blob = new Blob([JSON.stringify(prefs, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ancile-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
    notify({
      level: 'success',
      title: 'Settings exported',
      body: 'ancile-settings.json is in your downloads.',
    });
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const parsed = Preferences.safeParse(JSON.parse(await f.text()));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid');
      setIncoming(parsed.data);
    } catch {
      notify({
        level: 'error',
        title: 'That file is not an NVX Ancile settings file',
        body: 'Choose a file made with Export settings (ancile-settings.json).',
      });
    }
  };

  const searching = q.trim().length > 0;

  return (
    <div className="settings page" data-scrollable>
      <aside className="settings__nav" aria-label="Settings groups">
        <h1 className="settings__title" data-display>
          Settings
        </h1>
        <label className="settings__search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a setting"
            aria-label="Find a setting"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q) {
                e.stopPropagation();
                setQ('');
              }
            }}
          />
        </label>
        <nav>
          <ul>
            {GROUPS.map((g) => (
              <li key={g.id}>
                <Link
                  to="/settings/$group"
                  params={{ group: g.id }}
                  className="settings__link"
                  data-active={(!searching && g.id === current?.id) || undefined}
                  onClick={() => setQ('')}
                >
                  <Icon name={g.icon} size={14} />
                  <span>{g.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings__more">
          <Link to="/admin/$section" params={{ section: 'models' }} className="settings__link">
            <Icon name="model" size={14} />
            {/* Named to match "Settings → Models" in every hint and error. */}
            <span>Models</span>
            <Icon name="ext" size={11} className="settings__ext" />
          </Link>
          <Link to="/admin/$section" params={{ section: 'grants' }} className="settings__link">
            <Icon name="shield" size={14} />
            <span>Permissions</span>
            <Icon name="ext" size={11} className="settings__ext" />
          </Link>
          <button
            type="button"
            className="settings__link"
            onClick={() => useUi.getState().setHelp(true, 'settings')}
          >
            <Icon name="book" size={14} />
            <span>About settings</span>
          </button>
        </div>
      </aside>

      <main className="settings__main">
        <header className="settings__head">
          <div>
            <h2 className="settings__group-title" data-display>
              {searching ? `Settings matching “${q}”` : current?.label}
            </h2>
            {!searching ? <p className="mute">{current?.lede}</p> : null}
          </div>
          <div className="settings__actions">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => void onFile(e)}
            />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={13} />
              Import
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={exportFile}>
              <Icon name="download" size={13} />
              Export
            </button>
            {!searching &&
            current &&
            current.id !== 'about' &&
            current.id !== 'privacy' &&
            current.id !== 'sync' ? (
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => {
                  const before = usePrefs.getState().prefs;
                  reset(current.id as PrefGroup);
                  notify({
                    level: 'info',
                    title: `${current.label} reset`,
                    undo: () => usePrefs.getState().replace(before),
                  });
                }}
              >
                Reset {current.label.toLowerCase()}
              </button>
            ) : null}
          </div>
        </header>

        {incoming ? <ImportPreview next={incoming} onDone={() => setIncoming(null)} /> : null}

        <SearchContext.Provider value={q}>
          <div className="settings__body" key={searching ? 'search' : current?.id}>
            {searching ? GROUPS.map((g) => <g.body key={g.id} />) : current ? <current.body /> : null}
          </div>
        </SearchContext.Provider>

        <footer className="settings__foot mute">
          Changes save as you make them and follow you to your other devices. <Kbd keys="mod+," /> opens
          Settings from anywhere.
        </footer>
      </main>
    </div>
  );
}
