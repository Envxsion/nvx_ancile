/**
 * Open core (DESIGN.md §9): the public half of the Pro seam. The free
 * product is complete for one person, and everything built before Pro
 * existed stays free. Pro lives in a private repository mounted at `pro/`;
 * a clone without it builds and runs the free product. This file is the
 * contract both halves share: the closed list of what Pro can unlock, and
 * how each is described. A contract is public; the implementation is not.
 */
import { z } from 'zod';

export const PRO_FEATURES = ['beam', 'team', 'sync', 'fleet', 'flow_lab', 'insights'] as const;
export const ProFeature = z.enum(PRO_FEATURES);
export type ProFeature = z.infer<typeof ProFeature>;

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
    body: 'Your notebooks, threads and memory on every computer, encrypted before they leave this one.',
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
};
