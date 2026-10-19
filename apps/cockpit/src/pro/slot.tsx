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

/** pro/cockpit/index.tsx's export. */
export interface ProUi {
  /** One screen per surface id (PRO_SURFACES[].id). */
  screens: Record<string, ComponentType>;
  /** Pieces that live inside public screens (the Beam dialog opened from the composer). */
  parts?: {
    BeamDialog?: ComponentType<BeamDialogProps>;
    FlowLinkDialog?: ComponentType<FlowLinkDialogProps>;
    /** Attach or detach packs, and make a pack from this thread (ROADMAP CP1). */
    PackMenu?: ComponentType<PackMenuProps>;
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
export function ProUpsell({ feature, build }: { feature: ProFeatureId; build: 'free' | 'pro' | null }) {
  const words = proContract.PRO_FEATURE_WORDS[feature];
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
    unlocked: licence.data?.features.find((f) => f.id === feature)?.unlocked ?? false,
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
  const unlocked = licence.data?.features.find((f) => f.id === surface.feature)?.unlocked ?? false;
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
