/**
 * ------------------------------------------------------------------
 *  Title    |  Memory
 *  Ref      |  DESIGN.md §6 · ROADMAP Phase 4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything NVX Ancile remembers, in one place: the
 *           |  files, what waits for your yes, and the history of every
 *           |  change. And the one choice that governs it: how freely
 *           |  it learns.
 *  How      |  Admin → Memory. Three tabs (1, 2, 3 switch them when the
 *           |  page has focus). The inbox tab carries its count.
 * ------------------------------------------------------------------
 */

import type { MemorySettings } from '@nvx/contracts';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { Segmented } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';
import { type MemoryTab, useMemorySettings, useMemoryUi, usePendingProposals, useSetCapture } from './api';
import { Timeline } from './History';
import { Inbox } from './Inbox';
import { MemoryBrowser } from './MemoryBrowser';

export const CAPTURE_OPTIONS: { value: MemorySettings['capture']; label: string; desc: string }[] = [
  {
    value: 'auto_confident',
    label: 'Learn when sure',
    desc: 'Keeps what it is confident about, with Undo; asks about the rest.',
  },
  { value: 'propose_all', label: 'Always ask', desc: 'Every suggestion waits in the inbox for you.' },
  { value: 'off', label: 'Do not learn', desc: 'Memory is only what you write yourself.' },
];

export function CaptureControl({ size }: { size?: 'sm' }) {
  const settings = useMemorySettings();
  const set = useSetCapture();
  const value = settings.data?.capture ?? 'auto_confident';
  return (
    <Segmented
      label="How memory learns"
      value={value}
      size={size}
      onChange={(v) => set.mutate(v)}
      options={CAPTURE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
    />
  );
}

const TABS: { id: MemoryTab; label: string; icon: IconName }[] = [
  { id: 'files', label: 'Files', icon: 'memory' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'history', label: 'History', icon: 'clock' },
];

export function MemoryScreen() {
  const tab = useMemoryUi((s) => s.tab);
  const setTab = useMemoryUi((s) => s.setTab);
  const pending = usePendingProposals();
  const settings = useMemorySettings();
  const tabs = useRef<HTMLDivElement>(null);
  const lastPending = useRef(pending);

  // A new suggestion arriving while you are here makes the count chime, once.
  useEffect(() => {
    if (pending > lastPending.current)
      tabs.current
        ?.querySelector('[data-tab="inbox"] .mem-tab__count')
        ?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], {
          duration: 420,
          easing: 'cubic-bezier(.2,.9,.3,1.3)',
        });
    lastPending.current = pending;
  }, [pending]);

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
      t.isContentEditable
    )
      return;
    const i = ['1', '2', '3'].indexOf(e.key);
    if (i < 0) return;
    e.preventDefault();
    setTab((TABS[i] as (typeof TABS)[number]).id);
  };

  const capture = CAPTURE_OPTIONS.find((o) => o.value === (settings.data?.capture ?? 'auto_confident'));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 1, 2, 3 switch tabs while the page has focus
    <div className="mem" onKeyDown={onKey}>
      <div className="mem__intro">
        <p className="mute admin__lede">
          Plain markdown in its own git repository. Every change is a commit you can read and undo, and
          nothing from a web page or a tool is kept without your yes.
        </p>
        <div className="mem__capture">
          <CaptureControl size="sm" />
          <span className="mute mem__capture-desc">{capture?.desc}</span>
        </div>
      </div>

      <div className="mem-tabs" role="tablist" aria-label="Memory" ref={tabs}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab={t.id}
            aria-selected={tab === t.id}
            className="mem-tab"
            onClick={() => setTab(t.id)}
            title={`${t.label} (${i + 1})`}
          >
            <Icon name={t.icon} size={14} />
            {t.label}
            {t.id === 'inbox' && pending > 0 ? (
              <span className="mem-tab__count" data-num>
                {pending}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="mem__body" role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {tab === 'files' ? <MemoryBrowser /> : tab === 'inbox' ? <Inbox /> : <Timeline path={null} />}
      </div>
    </div>
  );
}
