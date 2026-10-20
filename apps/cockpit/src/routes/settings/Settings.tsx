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

import type { PrefGroup } from '@nvx/contracts';
import { DEFAULT_PREFERENCES, keepDevicePrefs, Preferences, withoutDevicePrefs } from '@nvx/contracts/prefs';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { CheckReviewers } from '../../auto/CheckReviewers';
import { ClaudeCodeGroup } from '../../claudecode/ClaudeCodeGroup';
import { ApiKeysGroup } from '../../credentials/ApiKeys';
import { DesktopGroup } from '../../desktop/DesktopGroup';
import { helpDone } from '../../help/store';
import { LabGroup } from '../../lab/LabGroup';
import { isDesktop } from '../../lib/runtime';
import { PrivateNotebooksGroup } from '../../privacy/PrivateNotebooksGroup';
import { ProSurfaceView } from '../../pro/slot';
import { SourcesGroup } from '../../sources/SourcesGroup';
import { notify } from '../../state/notify';
import { usePrefs } from '../../state/prefs';
import { useUi } from '../../state/ui';
import { PrivacyGroup } from '../../telemetry/ShareStats';
import { Icon, type IconName } from '../../ui/Icon';
import { Kbd } from '../../ui/primitives';
import { UsageGroup } from '../../usage/UsageView';
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
import { TrashGroup } from './TrashGroup';

const ALL_GROUPS: {
  id:
    | PrefGroup
    | 'about'
    | 'privacy'
    | 'private-notebooks'
    | 'sync'
    | 'keys'
    | 'claude-code'
    | 'usage'
    | 'desktop'
    | 'auto'
    | 'lab'
    | 'sources'
    | 'trash';
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
    id: 'keys',
    label: 'API keys',
    icon: 'key',
    body: ApiKeysGroup,
    lede: 'Keys and tokens for models, compute and GitHub, encrypted on this computer.',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    icon: 'command',
    body: ClaudeCodeGroup,
    lede: 'Use the Claude Code on this computer, and keep its sessions here as threads.',
  },
  {
    id: 'auto',
    label: 'Auto mode',
    icon: 'shield',
    body: CheckReviewers,
    lede: 'See how your Auto mode reviewers do on the built-in safety cases.',
  },
  {
    id: 'lab',
    label: 'Coding lab',
    icon: 'command',
    body: LabGroup,
    lede: 'How the lab treats the files it edits.',
  },
  {
    id: 'sources',
    label: 'Sources',
    icon: 'sources',
    body: SourcesGroup,
    lede: 'How scanned PDFs are read.',
  },
  {
    id: 'usage',
    label: 'Usage',
    icon: 'pulse',
    body: UsageGroup,
    lede: 'Claude Code plan limits, and what NVX Ancile has used today, this week and this month.',
  },
  {
    id: 'desktop',
    label: 'Desktop',
    icon: 'monitor',
    body: DesktopGroup,
    lede: 'What closing the window does, and updates.',
  },
  {
    id: 'private-notebooks',
    label: 'Private notebooks',
    icon: 'lock',
    body: PrivateNotebooksGroup,
    lede: 'What a private notebook may use. Nothing leaves this computer unless you allow it.',
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: 'shield',
    body: PrivacyGroup,
    lede: 'What NVX Ancile may share about how it is used.',
  },
  {
    id: 'trash',
    label: 'Trash',
    icon: 'trash',
    body: TrashGroup,
    lede: 'Deleted threads wait here for 30 days. Restore one, or empty the Trash.',
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

/** Desktop settings exist only inside the desktop app. */
const GROUPS = ALL_GROUPS.filter((g) => g.id !== 'desktop' || isDesktop());

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
  const mainRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);

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

  // SE2: the open section is in view when Settings opens (a short window, a deep link), and each
  // section or search starts at the top of the panel instead of wherever the last one was left.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the open section changes
  useEffect(() => {
    navRef.current?.querySelector('[data-active]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [group]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the top when the section or the search changes
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [group, q]);

  const exportFile = () => {
    // Device-only settings (custom CSS, zoom, panel widths, effects) stay on this device.
    const blob = new Blob([JSON.stringify(withoutDevicePrefs(prefs), null, 2)], {
      type: 'application/json',
    });
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
      // A file never brings device-only settings: this device keeps its own.
      setIncoming(keepDevicePrefs(parsed.data, usePrefs.getState().prefs));
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
    <div className="settings page">
      <aside ref={navRef} className="settings__nav" aria-label="Settings groups" data-scrollable>
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
          <Link to="/admin/$section" params={{ section: 'permissions' }} className="settings__link">
            <Icon name="shield" size={14} />
            <span>Permissions</span>
            <Icon name="ext" size={11} className="settings__ext" />
          </Link>
          {/* Your preferences as a file, for another computer: they belong to Settings as a whole, not to one group. */}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void onFile(e)}
          />
          <button type="button" className="settings__link" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={14} />
            <span>Import settings</span>
          </button>
          <button type="button" className="settings__link" onClick={exportFile}>
            <Icon name="download" size={14} />
            <span>Export settings</span>
          </button>
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

      {/* A section, not a second main landmark: the shell already has one. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling panel must take focus so the keyboard can scroll it (WCAG 2.1.1) */}
      <section ref={mainRef} className="settings__main" aria-label="Settings" tabIndex={0} data-scrollable>
        <header className="settings__head">
          <div>
            <h2 className="settings__group-title" data-display>
              {searching ? `Settings matching “${q}”` : current?.label}
            </h2>
            {!searching ? <p className="mute">{current?.lede}</p> : null}
          </div>
          <div className="settings__actions">
            {!searching &&
            current &&
            current.id !== 'about' &&
            current.id !== 'privacy' &&
            current.id !== 'sync' &&
            current.id !== 'keys' &&
            current.id !== 'claude-code' &&
            current.id !== 'desktop' &&
            current.id !== 'usage' &&
            current.id !== 'auto' &&
            current.id !== 'lab' &&
            current.id !== 'sources' ? (
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
          Changes save as you make them and follow you to other devices, except zoom, widths, Effects and
          custom CSS. <Kbd keys="mod+," /> opens Settings from anywhere.
        </footer>
      </section>
    </div>
  );
}
