/**
 * ------------------------------------------------------------------
 *  Title    |  Drawer
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The contextual right panel: Sources, Notes, Tree, Why,
 *           |  Evidence, and Repo when a repository is linked or added.
 *           |  What you need beside the conversation, never a
 *           |  separate page.
 *  How      |  Radix Tabs with an underline that slides between tabs.
 *           |  `]` toggles it, Alt 1 to 4 jump to a tab, its left edge
 *           |  drags to resize. Under 1100 px it becomes a modal sheet
 *           |  (Radix Dialog): focus stays inside, Esc and the scrim
 *           |  close it.
 * ------------------------------------------------------------------
 */

import { spring } from '@nvx/aperture';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { motion } from 'motion/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { EvidencePanel } from '../drawer/EvidencePanel';
import { NotesPanel } from '../drawer/NotesPanel';
import { SourcesPanel } from '../drawer/SourcesPanel';
import { LiveTree, TreePanel } from '../drawer/TreePanel';
import { WhyPanel } from '../drawer/WhyPanel';
import { useBinding } from '../keys/dispatch';
import { useThreadIdFromRoute } from '../lib/models';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useLinkedRepo, useRepoScope, useRepos } from '../repos/data';
import { RepoPanel } from '../repos/RepoPanel';
import { notify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { type DrawerTab, useUi } from '../state/ui';
import { useBranchLayer } from '../tree/store';
import { Icon, type IconName } from '../ui/Icon';
import { Tip } from '../ui/primitives';

const TABS: { id: DrawerTab; label: string; icon: IconName; binding?: string }[] = [
  { id: 'sources', label: 'Sources', icon: 'sources', binding: 'drawer.sources' },
  { id: 'notes', label: 'Notes', icon: 'note', binding: 'drawer.notes' },
  { id: 'tree', label: 'Tree', icon: 'tree', binding: 'drawer.tree' },
  { id: 'why', label: 'Why', icon: 'why', binding: 'drawer.why' },
  { id: 'evidence', label: 'Evidence', icon: 'evidence' },
  { id: 'repo', label: 'Repo', icon: 'branch' },
];

function Body({ onHide }: { onHide: () => void }) {
  const demo = useUi((s) => s.demo);
  const tab = useUi((s) => s.drawerTab);
  const openDrawer = useUi((s) => s.openDrawer);
  // The Repo tab appears once you have a repository, or this place is linked to one.
  const repos = useRepos();
  const linked = useLinkedRepo(useRepoScope());
  const showRepo = !demo && ((repos.data?.length ?? 0) > 0 || !!linked.data || tab === 'repo');
  const tabs = showRepo ? TABS : TABS.filter((t) => t.id !== 'repo');
  return (
    <Tabs.Root value={tab} onValueChange={(v) => openDrawer(v as DrawerTab)} className="drawer__tabs">
      <div className="drawer__head">
        <Tabs.List className="tabs" aria-label="Panel">
          {tabs.map((t) => (
            <Tabs.Trigger key={t.id} value={t.id} className="tabs__tab" title={t.label}>
              <Icon name={t.icon} size={14} />
              <span className="tabs__label">{t.label}</span>
              {tab === t.id ? (
                <motion.span className="tabs__line" layoutId="drawer-tab-line" transition={spring.snappy} />
              ) : null}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tip label="Hide panel" binding="drawer.toggle" side="left">
          <button type="button" className="icon-btn icon-btn--sm" onClick={onHide} aria-label="Hide panel">
            <Icon name="panelRight" size={14} />
          </button>
        </Tip>
      </div>
      <div className="drawer__body" data-scrollable>
        <Tabs.Content value="sources" className="drawer__pane">
          <SourcesPanel />
        </Tabs.Content>
        <Tabs.Content value="notes" className="drawer__pane">
          <NotesPanel />
        </Tabs.Content>
        <Tabs.Content value="tree" className="drawer__pane">
          {demo ? <TreePanel /> : <LiveTree />}
        </Tabs.Content>
        <Tabs.Content value="why" className="drawer__pane">
          <WhyPanel />
        </Tabs.Content>
        <Tabs.Content value="repo" className="drawer__pane">
          <RepoPanel />
        </Tabs.Content>
        <Tabs.Content value="evidence" className="drawer__pane">
          {/* Live and demo alike: the panel reads the fact-check itself. */}
          <EvidencePanel />
        </Tabs.Content>
      </div>
    </Tabs.Root>
  );
}

export function Drawer() {
  const sheet = useMediaQuery('(max-width: 1100px)');
  const demo = useUi((s) => s.demo);
  const columnOpen = useUi((s) => s.drawerOpen);
  const sheetOpen = useUi((s) => s.sheetOpen);
  const open = sheet ? sheetOpen : columnOpen;
  const toggleColumn = useUi((s) => s.toggleDrawer);
  const toggleSheet = useUi((s) => s.toggleSheet);
  const toggle = sheet ? toggleSheet : toggleColumn;
  const openDrawer = useUi((s) => s.openDrawer);
  const width = usePrefs((s) => s.prefs.layout.drawerWidth);
  const setPref = usePrefs((s) => s.set);

  useBinding('drawer.toggle', toggle);
  // g b: the open thread's tree, full screen; elsewhere, say why nothing opens.
  const threadId = useThreadIdFromRoute();
  useBinding('go.tree', () =>
    threadId && !demo
      ? useBranchLayer.getState().setFull(true)
      : notify({
          level: 'info',
          title: 'Open a thread to see its branch tree',
          body: 'The tree shows one thread at a time.',
        }),
  );
  useBinding('drawer.sources', () => openDrawer('sources'));
  useBinding('drawer.notes', () => openDrawer('notes'));
  useBinding('drawer.tree', () => openDrawer('tree'));
  useBinding('drawer.why', () => openDrawer('why'));

  const onResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const el = e.currentTarget;
    const shell = document.querySelector<HTMLElement>('.shell');
    el.setPointerCapture(e.pointerId);
    document.documentElement.dataset.resizing = '';
    const clamp = (x: number) => Math.round(Math.min(560, Math.max(280, width - (x - startX))));
    const move = (ev: PointerEvent) => shell?.style.setProperty('--drawer-w', `${clamp(ev.clientX)}px`);
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      delete document.documentElement.dataset.resizing;
      setPref('layout', { drawerWidth: clamp(ev.clientX) });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  };

  if (sheet)
    return (
      <Dialog.Root open={open} onOpenChange={(o) => o !== open && toggle()}>
        <Dialog.Portal>
          <Dialog.Overlay className="sheet-scrim" />
          <Dialog.Content
            className="drawer drawer--sheet m-glass-thick"
            data-open
            aria-describedby={undefined}
          >
            <Dialog.Title className="sr-only">Context panel</Dialog.Title>
            <Body onHide={toggle} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );

  return (
    <aside className="drawer" data-open={open} aria-label="Context panel">
      <div
        className="drawer__resize"
        aria-hidden="true"
        onPointerDown={onResize}
        onDoubleClick={() => setPref('layout', { drawerWidth: 380 })}
      />
      <Body onHide={toggle} />
    </aside>
  );
}
