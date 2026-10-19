/**
 * Open core (DESIGN.md §9): the public half of the Pro seam. The free
 * product is complete for one person, and everything built before Pro
 * existed stays free. Pro lives in a private repository mounted at `pro/`;
 * a clone without it builds and runs the free product. This file is the
 * contract both halves share: the closed list of what Pro can unlock, and
 * how each is described. A contract is public; the implementation is not.
 */
import { z } from 'zod';

export const PRO_FEATURES = [
  'beam',
  'team',
  'sync',
  'fleet',
  'flow_lab',
  'insights',
  'context_packs',
  'desktop',
] as const;
export const ProFeature = z.enum(PRO_FEATURES);
export type ProFeature = z.infer<typeof ProFeature>;

/**
 * Pro routes the free build still answers, under /api/v1/pro: with 402
 * `pro.feature_required` naming the feature, so a Cockpit (or a script)
 * asking for one learns it is Pro rather than meeting a 404. In a Pro build
 * Pro's own route of the same path answers instead.
 */
export const PRO_SEAM_ROUTES: readonly { method: 'GET' | 'POST'; path: string; feature: ProFeature }[] = [
  { method: 'GET', path: '/insights', feature: 'insights' },
  { method: 'GET', path: '/insights/engines', feature: 'insights' },
  // FL1: the shadow flow's answer to a message (Pro: Flow lab). TODO(phase-0.1.1): Pro serves it from pro.shadow_results.
  { method: 'GET', path: '/messages/:id/shadow', feature: 'flow_lab' },
];

/** How each feature is named and described wherever Pro is shown. */
export const PRO_FEATURE_WORDS: Record<ProFeature, { title: string; body: string }> = {
  beam: {
    title: 'Ask several models at once',
    body: 'Fan one question out to several models and fuse their answers into one.',
  },
  team: {
    title: 'Teams',
    body: 'Invite people into a workspace, with sign-in through your identity provider.',
  },
  sync: {
    title: 'Encrypted sync',
    body: 'Your notebooks, threads, notes, flows and preferences on every computer, encrypted before they leave this one. What you keep on this computer stays here.',
  },
  fleet: {
    title: 'GPU fleet',
    body: 'More than one GPU node, new RunPod pods from the app, and schedules that start and stop them.',
  },
  flow_lab: {
    title: 'Flow lab',
    body: 'Test a flow against your past threads, run a new flow in the shadow of the live one, and a router that learns from your choices.',
  },
  insights: {
    title: 'Insights',
    body: 'Where your time, money and models go, from your own history, on this computer.',
  },
  context_packs: {
    title: 'Context packs',
    body: 'Save sources, notes, a summary, memory and instructions as one pack, attach it anywhere in one click, and share it as a signed file.',
  },
  desktop: {
    title: 'Desktop extras',
    body: 'Scheduled automations keep running with the window hidden, Approve and Deny on a notification for ordinary requests, links that start a flow, a Beta update channel and a way back to the previous version.',
  },
};
