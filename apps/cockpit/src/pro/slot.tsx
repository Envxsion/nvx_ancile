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
 *           |  what it shows is Pro's.
 * ------------------------------------------------------------------
 */

import { pro as proContract } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ComponentType, Suspense, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { attachRun, useLiveTurn } from '../lib/run';
import { notify } from '../state/notify';
import { Parts } from '../thread/Parts';
import { Check, Segmented, Switch } from '../ui/controls';
import { Icon, type IconName } from '../ui/Icon';
import { EmptyState, Kbd, Skeleton, StatusDot, Tip } from '../ui/primitives';

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
  ui: { Icon, EmptyState, Kbd, Skeleton, StatusDot, Tip, Switch, Check, Segmented, Parts },
};
export type ProKit = typeof proKit;

/** What the Beam dialog is opened with: where the question goes, and its text so far. */
export interface BeamDialogProps {
  threadId: string | null;
  notebookId: string | null;
  /** The message the question replies to; undefined: the thread's latest answer. */
  parentId: string | null | undefined;
  text: string;
  onClose: () => void;
}

/** pro/cockpit/index.tsx's export. */
export interface ProUi {
  /** One screen per surface id (PRO_SURFACES[].id). */
  screens: Record<string, ComponentType>;
  /** Pieces that live inside public screens (the Beam dialog opened from the composer). */
  parts?: { BeamDialog?: ComponentType<BeamDialogProps> };
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
  features: { id: ProFeatureId; unlocked: boolean }[];
}

/** "This is part of Pro", with the words for the feature and the way to turn it on. */
export function ProUpsell({ feature, build }: { feature: ProFeatureId; build: 'free' | 'pro' | null }) {
  const words = proContract.PRO_FEATURE_WORDS[feature];
  return (
    <div className="pro-upsell">
      <EmptyState
        icon="seal"
        title={words.title}
        body={
          <>
            {words.body}{' '}
            {build === 'pro'
              ? 'It is part of NVX Ancile Pro: turn Pro on with your key to use it.'
              : 'It is part of NVX Ancile Pro, which this build does not include. Everything else here is free and complete.'}
          </>
        }
        secondary={
          <Link to="/admin/$section" params={{ section: 'license' }} className="btn btn--ghost btn--sm">
            {build === 'pro' ? 'Turn on Pro' : 'About Pro'}
          </Link>
        }
      />
    </div>
  );
}

/** Pro's UI module (null in a free build), and whether a feature is unlocked now. */
export function useProFeature(feature: ProFeatureId): {
  ui: ProUi | null | undefined;
  unlocked: boolean;
  build: 'free' | 'pro' | null;
  loading: boolean;
} {
  const ui = useProUi();
  const licence = useQuery({
    queryKey: ['license', 'details'],
    queryFn: () => api.get<LicenceView>('/license/details'),
    staleTime: 30_000,
  });
  return {
    ui,
    unlocked: licence.data?.features.find((f) => f.id === feature)?.unlocked ?? false,
    build: licence.data?.build ?? null,
    loading: licence.isLoading || ui === undefined,
  };
}

/** A Pro feature's screen, or the card that explains it. */
export function ProSurfaceView({ id }: { id: string }) {
  const surface = PRO_SURFACES.find((s) => s.id === id);
  const ui = useProUi();
  const licence = useQuery({
    queryKey: ['license', 'details'],
    queryFn: () => api.get<LicenceView>('/license/details'),
    staleTime: 30_000,
  });
  if (!surface) return null;
  const unlocked = licence.data?.features.find((f) => f.id === surface.feature)?.unlocked ?? false;
  const Screen = ui?.screens[surface.id];
  if (licence.isLoading || ui === undefined) return <Skeleton lines={4} label={`Loading ${surface.label}`} />;
  if (!Screen || !unlocked)
    return <ProUpsell feature={surface.feature} build={licence.data?.build ?? null} />;
  return (
    <Suspense fallback={<Skeleton lines={4} label={`Loading ${surface.label}`} />}>
      <Screen />
    </Suspense>
  );
}
