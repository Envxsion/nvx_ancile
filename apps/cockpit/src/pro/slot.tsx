/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: the Cockpit side
 *  Ref      |  DESIGN.md §9
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Show a Pro feature's own screen where the build has
 *           |  Pro and the licence unlocks it, and a plain "this is
 *           |  part of Pro" card everywhere else. The free product
 *           |  never breaks for want of Pro.
 *  How      |  pro/cockpit/index.tsx (a private submodule, empty in a
 *           |  public clone) is found with import.meta.glob, loaded
 *           |  on first use and handed a small kit: the API, the
 *           |  query hooks, notices and the shared UI pieces. Pro
 *           |  imports nothing from the Cockpit but React itself.
 *           |  Where each feature appears is public (PRO_SURFACES);
 *           |  what it shows is Pro's. What is unlocked is what this
 *           |  person may use (/license/details answers for them): in
 *           |  a team, someone without a Pro seat sees the card, with
 *           |  the way to ask for a seat.
 * ------------------------------------------------------------------
 */

import * as proContract from '@nvx/contracts/pro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ComponentType, Suspense, useEffect, useState } from 'react';
import { CodeDiff } from '../code/CodeView';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { attachRun, useLiveTurn } from '../lib/run';
import { createThread, sendMessage } from '../lib/turns';
import { notify } from '../state/notify';
import { Parts } from '../thread/Parts';
import { Check, Segmented, Switch } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';
import { LoadFailed, StaleNotice } from '../ui/LoadFailed';
import { EmptyState, Kbd, Skeleton, StatusDot, Tip } from '../ui/primitives';
import { ContextPacksLocked } from './ContextPacksLocked';
import { EngineInsightsLocked } from './EngineInsightsLocked';

export type ProFeatureId = proContract.ProFeature;

/** Where each Pro feature lives in the Cockpit. Public: the free build shows the card here. */
export interface ProSurface {
  id: string;
  feature: ProFeatureId;
  /** admin and settings sections; gate: shown instead of the shell (sign-in). */
  place: 'admin' | 'settings' | 'gate';
  label: string;
  icon: IconName;
  /** Where it sits in Admin's list; absent: decided by feature. */
  group?: 'System' | 'Trust' | 'Models' | 'Extend';
  /** Its own locked state (public): what it would show, instead of the plain card. */
  locked?: ComponentType<{ build: 'free' | 'pro' | null }>;
}

export const PRO_SURFACES: ProSurface[] = [
  { id: 'fleet', feature: 'fleet', place: 'admin', label: 'GPU fleet', icon: 'zap' },
  { id: 'team', feature: 'team', place: 'admin', label: 'Team', icon: 'user' },
  { id: 'sync', feature: 'sync', place: 'settings', label: 'Sync', icon: 'globe' },
  { id: 'signin', feature: 'team', place: 'gate', label: 'Sign in', icon: 'lock' },
  { id: 'insights', feature: 'insights', place: 'admin', label: 'Insights', icon: 'pulse', group: 'System' },
  {
    id: 'flow-lab',
    feature: 'flow_lab',
    place: 'admin',
    label: 'Flow lab',
    icon: 'compare',
    group: 'Models',
  },
  {
    id: 'engine-insights',
    feature: 'insights',
    place: 'admin',
    label: 'Engine insights',
    icon: 'sparkle',
    group: 'Models',
    locked: EngineInsightsLocked,
  },
  {
    id: 'context-packs',
    feature: 'context_packs',
    place: 'admin',
    label: 'Context packs',
    icon: 'archive',
    group: 'Extend',
    locked: ContextPacksLocked,
  },
];

/** What the Cockpit lends Pro's screens. */
export const proKit = {
  api,
  queryClient,
  useQuery,
  useMutation,
  notify,
  Link,
  /** Follow answers as they are written (the same live store the thread uses). */
  runs: { attach: attachRun, useLive: useLiveTurn },
  /**
   * Send one message through a flow in a new thread, the way the composer does.
   * Resolves with the thread's id, or null when nothing was sent. Pro calls it
   * only from a button the person pressed (a link never runs a flow).
   */
  flows: {
    async run(flowId: string, text: string): Promise<string | null> {
      const threadId = await createThread(null, null);
      if (!threadId) return null;
      const ok = await sendMessage({ threadId, parentId: null, text, flowId });
      return ok ? threadId : null;
    },
  },
  /** LoadFailed and StaleNotice: a failed read in its own words with Try again (ui/LoadFailed.tsx). */
  ui: {
    Icon,
    EmptyState,
    Kbd,
    Skeleton,
    StatusDot,
    Tip,
    Switch,
    Check,
    Segmented,
    Parts,
    /** Before and after, side by side (the lab's diff view). Loads CodeMirror when first drawn. */
    CodeDiff,
    LoadFailed,
    StaleNotice,
  },
};
export type ProKit = typeof proKit;

/** What the Beam dialog is opened with: where the question goes, and its text so far. */
export interface BeamDialogProps {
  threadId: string | null;
  notebookId: string | null;
  /** The message the question replies to; undefined: the thread's latest answer. */
  parentId: string | null | undefined;
  text: string;
  /** A question already in the thread (Beam this question): shown as asked, sent as question_id. */
  questionId?: string | null;
  /** Called once the beam has started. */
  onStarted?: () => void;
  onClose: () => void;
}

/** What the flow link dialog is opened with (ancile://flow/<id>/run, Pro). */
export interface FlowLinkDialogProps {
  flowId: string;
  onClose: () => void;
  /** The flow was run (a button was pressed) and this thread holds the answer. */
  onStarted: (threadId: string) => void;
}

/** What the context pack picker is opened with: the thread or notebook it works on. */
export interface PackMenuProps {
  target: { kind: 'thread' | 'notebook'; id: string };
  /** Its title, for the words around the list. */
  title: string;
  onClose: () => void;
}

/** One answer's receipt as plain figures (WY1). Pro compares and exports these; it reads nothing else. */
export interface ReceiptRow {
  id: string;
  threadId: string;
  at: string;
  model: string;
  /** Plan or Key badge, when the answer has one. */
  badge: string | null;
  /** How it was paid for: null when unknown. */
  pay: 'key' | 'plan' | 'free' | null;
  costUsd: number | null;
  /** Null: not recorded or not reported (never a made-up 0). */
  tokens: { fresh: number | null; cached: number | null; written: number | null; output: number };
  cacheSavedUsd: number | null;
  ms: number | null;
  calls: number | null;
}

/** What the receipt hands Pro's tools: this answer, and the other answers in its thread. */
export interface ReceiptToolsProps {
  row: ReceiptRow;
  others: ReceiptRow[];
}

/** What the side card (Ask another model about this, AN2) is opened with: the highlighted words and where they are. */
export interface SideAskProps {
  threadId: string;
  messageId: string;
  /** The highlighted words: data, quoted, never run. */
  text: string;
  onClose: () => void;
}

/** One of the person's own palette commands (ROADMAP KP1, Pro: flow_lab). Public: the Cockpit runs it. */
export interface UserCommandView {
  id: string;
  name: string;
  /** Offered only in this notebook; null: everywhere. */
  notebook_id: string | null;
  kind: 'chain' | 'flow';
  /** chain: palette command ids, run in order. */
  steps: string[];
  /** flow: the flow to run, and on what. */
  flow_id: string | null;
  flow_target: 'selection' | 'thread' | null;
}

/** What the "Your commands" dialog is opened with: the lists it picks from, and how it says it changed. */
export interface CommandEditorProps {
  commands: UserCommandView[];
  /** The palette actions a chain may use, in the order the palette lists them. */
  actions: { id: string; label: string; destructive: boolean }[];
  flows: { id: string; name: string }[];
  notebooks: { id: string; title: string }[];
  /** The notebook the person is in, so a new command can start scoped to it. */
  notebookId: string | null;
  /** The commands changed: read the list again. */
  onChanged: () => void;
  onClose: () => void;
}

/** A notebook's effort default (ROADMAP EN1, Pro: flow_lab). null level with auto false: the model's own. */
export interface EffortDefault {
  level: 'low' | 'medium' | 'high' | null;
  auto: boolean;
}

/** What the local model presets screen is opened with (ROADMAP LM1, Pro: fleet). */
export interface LocalPresetsProps {
  /** Ollama models NVX Ancile lists, with whether each is in memory now. */
  models: { id: string; name: string; loaded: boolean }[];
  notebooks: { id: string; title: string }[];
}

/** The Ctrl+K filters, as the palette holds them (lib/searchFilter.ts). */
export interface SearchProFilter {
  who?: 'mine' | 'answers';
  notebook?: string;
  model?: string;
  from?: string;
  to?: string;
}

/** Where a Pro search result opens: a thread at a message, or a notebook. */
export interface SearchProTarget {
  threadId: string | null;
  messageId: string | null;
  notebookId: string | null;
}

/** What the Ctrl+K Pro search (TS1) is opened with: the words typed, the filters, and the ways to act on them. */
export interface SearchProProps {
  /** What is typed in the palette now. */
  query: string;
  filter: SearchProFilter;
  /** Put a saved search back: the filters, then the words. */
  apply: (query: string, filter: SearchProFilter) => void;
  /** Open a result. The palette closes. */
  open: (target: SearchProTarget) => void;
}

/** Which words matched in a message, as the find bar tells them apart (lib/threadFind.ts). */
export type FindBranchWhere = 'text' | 'thinking' | 'tool';

/** One hit on another branch, ready for the find bar to jump to. */
export interface FindBranchPick {
  /** The last message of that branch: the thread shows this path. */
  leafId: string;
  messageId: string;
  where: FindBranchWhere;
  callId?: string;
}

/** What "All branches" in the find bar (TS2) is opened with. */
export interface FindBranchesProps {
  threadId: string;
  query: string;
  /** The last message of the branch on screen, so its own hits are left to the plain find. */
  currentId: string | null;
  /** Switch to that branch, then scroll to the hit. */
  pick: (p: FindBranchPick) => void;
}

/**
 * What "Apply to repo" (ROADMAP AN3) is opened with: one code block of an answer, and the repository
 * the thread is linked to. The Cockpit draws the dialog; Pro fills it. Nothing is written until the
 * person approves the diff, and every write is PUT /files, which runs permissions/decide.
 */
export interface ApplyToRepoProps {
  threadId: string;
  /** The code block: data, never run. */
  code: string;
  /** Its fence language, when it had one. */
  lang: string | null;
  /** The repository the thread is linked to. `root` is its absolute path on this computer. */
  repo: { id: string; name: string; root: string };
  /** When the answer was written (ISO): a file changed since then gets a note. */
  answeredAt: string;
  onClose: () => void;
}

/**
 * What the rail's saved smart sections (ROADMAP TC4, Pro) are drawn with: the thread open now and the
 * notebooks a filter can pick. Pro draws the sections, their editor and their empty states, and reads
 * each section's threads (id and title) from Core, so a match the rail has not loaded still shows.
 */
export interface SmartSectionsProps {
  activeId: string | null;
  notebooks: { id: string; title: string }[];
}

/** Where a queued message stands as a note to the running answer (ROADMAP CH7, Pro: steer). */
export interface SteerView {
  /** Core's id for the note; empty while it is being offered. */
  id: string;
  /** sending: being offered. pending: waits for the model's next step. applied: the model has read it. */
  state: 'sending' | 'pending' | 'applied';
  /** The model step it went into, once applied. */
  round?: number;
}

/** What the queued message's steer control is given. It says what happens to the message and may offer it as a note. */
export interface SteerQueueProps {
  threadId: string;
  /** The queued words: data, sent only if a button is pressed. */
  text: string;
  /** The answer the message was written under. */
  after: string | null;
  /** Only words can go as a note: a message with files, images or a flow waits for the turn to end. */
  plain: boolean;
  steer: SteerView | null;
  onSteer: (s: SteerView | null) => void;
  /** Core refused because you moved to another branch. */
  onBranchChanged: () => void;
}

/** What the export dialog's Pro formats are given (ROADMAP EX3, Pro: export_docs). */
export interface ExportToolsProps {
  threadId: string;
  /** The message the branch on screen ends at; null: the thread's current branch. */
  headId: string | null;
  title: string;
  /** What the dialog's checkboxes say to include. */
  options: { sources: boolean; steps: boolean; thinking: boolean; receipts: boolean };
  /** A file was saved. */
  onDone: () => void;
}

/** pro/cockpit/index.tsx's export. */
/** "Join my synced computers" in the setup step, with a pairing code (ROADMAP SU1, Pro: sync). */
export interface SetupSyncJoinProps {
  /** Called once this computer has joined and syncs. */
  onJoined?: () => void;
}

/**
 * A team invite code field in the setup step (ROADMAP SU1, Pro: team).
 * TODO(phase-0.2.0): Core has no API for this computer to join a team on another server yet (the
 * invitation link is accepted by the team's own server). The seam is here; Pro draws nothing for it
 * until that API exists, and setup says so instead of showing a field that does nothing.
 */
export interface SetupTeamInviteProps {
  onJoined?: () => void;
}

export interface ProUi {
  /** One screen per surface id (PRO_SURFACES[].id). */
  screens: Record<string, ComponentType>;
  /** Pieces that live inside public screens (the Beam dialog opened from the composer). */
  parts?: {
    BeamDialog?: ComponentType<BeamDialogProps>;
    FlowLinkDialog?: ComponentType<FlowLinkDialogProps>;
    /** Attach or detach packs, and make a pack from this thread (ROADMAP CP1). */
    PackMenu?: ComponentType<PackMenuProps>;
    /** Compare this receipt with another and export receipts (ROADMAP WY1). */
    ReceiptTools?: ComponentType<ReceiptToolsProps>;
    /** A model of another family answers about the highlighted words, as a costed side card (ROADMAP AN2). */
    SideAsk?: ComponentType<SideAskProps>;
    /** A code block turned into a proposed patch, reviewed as a diff, written only when approved (ROADMAP AN3). */
    ApplyToRepo?: ComponentType<ApplyToRepoProps>;
    /** Saved filters drawn as sections in the rail (ROADMAP TC4). */
    SmartSections?: ComponentType<SmartSectionsProps>;
    /** Search tool outputs, notes and fact-check claims, and keep searches by name (ROADMAP TS1). */
    SearchPro?: ComponentType<SearchProProps>;
    /** "All branches" in the thread's find bar: hits on the other branches, grouped (ROADMAP TS2). */
    FindBranches?: ComponentType<FindBranchesProps>;
    /** Create, edit and delete your own palette commands (ROADMAP KP1). */
    CommandEditor?: ComponentType<CommandEditorProps>;
    /** Your commands, as the palette lists them (ROADMAP KP1). Reads only. */
    userCommands?: { list(): Promise<UserCommandView[]> };
    /** A notebook's effort default and Auto, read and saved (ROADMAP EN1). */
    effortDefaults?: {
      get(notebookId: string): Promise<EffortDefault>;
      set(notebookId: string, v: EffortDefault): Promise<EffortDefault>;
    };
    /** Per-notebook keep-alive and context length for local models, with the memory forecast (ROADMAP LM1). */
    LocalPresets?: ComponentType<LocalPresetsProps>;
    /** Offer a queued message to the running answer as a note it reads at its next step (ROADMAP CH7). */
    SteerQueue?: ComponentType<SteerQueueProps>;
    /** Word and PDF export with an evidence appendix, and a comparison of two branches (ROADMAP EX3). */
    ExportTools?: ComponentType<ExportToolsProps>;
    /** Join this computer to your synced computers with a pairing code, from setup (ROADMAP SU1). */
    SetupSyncJoin?: ComponentType<SetupSyncJoinProps>;
    /** A team invite code field, from setup (ROADMAP SU1). Absent until Core can join a team. */
    SetupTeamInvite?: ComponentType<SetupTeamInviteProps>;
  };
}
type CreateProUi = (kit: ProKit) => ProUi;

/**
 * False in a free build (NVX_TIER=free when it was built), so the bundler
 * drops the import below and no Pro screen can reach a free build, even one
 * built from a checkout that has pro/. Set in vite.config.ts.
 */
declare const __ANCILE_PRO_UI__: boolean;

// Relative to this file: apps/cockpit/src/pro → the repository's pro/cockpit.
const entries: Record<string, () => Promise<{ createProUi?: CreateProUi }>> = __ANCILE_PRO_UI__
  ? import.meta.glob<{ createProUi?: CreateProUi }>('../../../../pro/cockpit/index.tsx')
  : {};

export const proUiPresent = Object.keys(entries).length > 0;

let loading: Promise<ProUi | null> | null = null;
function loadProUi(): Promise<ProUi | null> {
  if (!loading) {
    const load = Object.values(entries)[0];
    loading = load
      ? load()
          .then((m) => (m.createProUi ? m.createProUi(proKit) : null))
          .catch(() => null)
      : Promise.resolve(null);
  }
  return loading;
}

function useProUi(): ProUi | null | undefined {
  const [ui, setUi] = useState<ProUi | null | undefined>(proUiPresent ? undefined : null);
  useEffect(() => {
    if (!proUiPresent) return;
    let live = true;
    void loadProUi().then((u) => {
      if (live) setUi(u);
    });
    return () => {
      live = false;
    };
  }, []);
  return ui;
}

interface LicenceView {
  build: 'free' | 'pro';
  /** This person has a Pro seat (false: a team member without one). Absent from an older Core: yes. */
  seat?: boolean;
  status?: { features: ProFeatureId[] };
  features: { id: ProFeatureId; unlocked: boolean }[];
}

const useLicence = () =>
  useQuery({
    queryKey: ['license', 'details'],
    queryFn: () => api.get<LicenceView>('/license/details'),
    staleTime: 30_000,
  });

/** Pro is on here and includes the feature, but this person has no Pro seat. */
export const seatMissing = (d: LicenceView | undefined, feature: ProFeatureId) =>
  d?.seat === false && (d.status?.features ?? []).includes(feature);

/** "This is part of Pro", with the words for the feature and the way to turn it on (or to ask for a seat). */
export function ProUpsell({
  feature,
  build,
  words: own,
}: {
  feature: ProFeatureId;
  build: 'free' | 'pro' | null;
  /** The words for one piece of the feature (its title and what it does), instead of the whole feature's. */
  words?: { title: string; body: string };
}) {
  const words = own ?? proContract.PRO_FEATURE_WORDS[feature];
  const noSeat = seatMissing(useLicence().data, feature);
  return (
    <div className="pro-upsell">
      <div className="pro-upsell__card pro-card gilt-frame gilt-frame--quiet">
        <EmptyState
          icon="seal"
          title={words.title}
          body={
            <>
              {words.body}{' '}
              {noSeat
                ? "Pro is on in this workspace, but your account has no Pro seat. Ask the workspace's owner for one."
                : build === 'pro'
                  ? 'It is part of NVX Ancile Pro: turn Pro on with your key to use it.'
                  : 'It is part of NVX Ancile Pro, which this build does not include. Everything else here is free and complete.'}
            </>
          }
          secondary={
            noSeat ? (
              <Link to="/admin/$section" params={{ section: 'team' }} className="btn btn--ghost btn--sm">
                See who has a seat
              </Link>
            ) : (
              <Link to="/admin/$section" params={{ section: 'license' }} className="btn btn--ghost btn--sm">
                {build === 'pro' ? 'Turn on Pro' : 'About Pro'}
              </Link>
            )
          }
        />
      </div>
    </div>
  );
}

/** Pro's UI module (null in a free build), and whether this person may use a feature now. */
export function useProFeature(feature: ProFeatureId): {
  ui: ProUi | null | undefined;
  unlocked: boolean;
  build: 'free' | 'pro' | null;
  loading: boolean;
  /** Pro is on here, but this person has no Pro seat. */
  noSeat: boolean;
} {
  const ui = useProUi();
  const licence = useLicence();
  return {
    ui,
    unlocked: licence.data?.features?.find((f) => f.id === feature)?.unlocked ?? false,
    build: licence.data?.build ?? null,
    loading: licence.isLoading || ui === undefined,
    noSeat: seatMissing(licence.data, feature),
  };
}

/** A Pro feature's screen, or the card that explains it. */
export function ProSurfaceView({ id }: { id: string }) {
  const surface = PRO_SURFACES.find((s) => s.id === id);
  const ui = useProUi();
  const licence = useLicence();
  if (!surface) return null;
  const unlocked = licence.data?.features?.find((f) => f.id === surface.feature)?.unlocked ?? false;
  const Screen = ui?.screens[surface.id];
  if (licence.isLoading || ui === undefined) return <Skeleton lines={4} label={`Loading ${surface.label}`} />;
  // Not knowing the licence is not the same as being locked: say what failed, not "this is part of Pro".
  if (licence.isError && !licence.data)
    return <LoadFailed error={licence.error} what={surface.label} onRetry={() => licence.refetch()} />;
  if (!Screen || !unlocked) {
    const Locked = surface.locked;
    // Without a seat, the plain card says how to get one (a locked preview would say "turn on Pro").
    return Locked && !seatMissing(licence.data, surface.feature) ? (
      <Locked build={licence.data?.build ?? null} />
    ) : (
      <ProUpsell feature={surface.feature} build={licence.data?.build ?? null} />
    );
  }
  return (
    <Suspense fallback={<Skeleton lines={4} label={`Loading ${surface.label}`} />}>
      <Screen />
    </Suspense>
  );
}
