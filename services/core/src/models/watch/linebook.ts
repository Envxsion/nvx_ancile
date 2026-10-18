/**
 * ------------------------------------------------------------------
 *  Title    |  Line book: which model a line answers with
 *  Ref      |  roadmap MD4, MD5 · guard rail GR16
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Work out, from the models Core knows and the little
 *           |  state saved per line, each line's current model, its
 *           |  newest stable model, and what is waiting.
 *  How      |  Pure. Members come from the registry's models (they can
 *           |  answer) and from the watch (offered, not yet added).
 *           |  A line's current model is the saved one when it is still
 *           |  a model you have; otherwise the newest stable model you
 *           |  have, which is what makes `anthropic/opus:latest` work
 *           |  offline before any check.
 *  Note     |  A preview is never "latest" and never the seed.
 * ------------------------------------------------------------------
 */
import { lineAlias, type ModelLine, type ModelTier } from '@nvx/contracts';
import { compareModels } from './lines';

export interface Member {
  id: string;
  provider: string;
  line_id: string;
  name: string;
  tier: ModelTier;
  version: string | null;
  date: string | null;
  created: string | null;
  preview: boolean;
  retired: boolean;
  /** You have it (models.yaml, added, or added from the watch). */
  have: boolean;
}

export interface LineState {
  follow: boolean;
  current_id: string | null;
  previous_id: string | null;
  pending: {
    model_id: string;
    state: 'offered' | 'testing' | 'failed';
    detail: string | null;
    at: string;
  } | null;
}

export const emptyState = (): LineState => ({
  follow: false,
  current_id: null,
  previous_id: null,
  pending: null,
});

/** The newest model that is neither a preview nor retired; null when there is none. */
export function newestStable<T extends Member>(members: T[]): T | null {
  let best: T | null = null;
  for (const m of members) {
    if (m.preview || m.retired) continue;
    if (!best || compareModels(m, best) > 0) best = m;
  }
  return best;
}

export interface LineGroup {
  id: string;
  provider: string;
  name: string;
  tier: ModelTier;
  members: Member[];
}

export function groupLines(members: Member[]): Map<string, LineGroup> {
  const out = new Map<string, LineGroup>();
  for (const m of members) {
    const g = out.get(m.line_id) ?? {
      id: m.line_id,
      provider: m.provider,
      name: m.name,
      tier: m.tier,
      members: [],
    };
    // The same model can be known twice (you have it and the watch lists it): keep the one you have.
    const at = g.members.findIndex((x) => x.id === m.id);
    if (at < 0) g.members.push(m);
    else if (m.have && !(g.members[at] as Member).have) g.members[at] = m;
    out.set(m.line_id, g);
  }
  return out;
}

/** What the alias answers with: the saved model if you still have it, else the newest stable one you have. */
export function currentOf(g: LineGroup, state: LineState | undefined): string | null {
  const have = g.members.filter((m) => m.have);
  const saved = state?.current_id ? have.find((m) => m.id === state.current_id) : undefined;
  if (saved) return saved.id;
  const stable = newestStable(have);
  if (stable) return stable.id;
  // Only retired models are left: the alias keeps answering with the newest of them until a replacement is found.
  let last: Member | null = null;
  for (const m of have) if (!m.preview && (!last || compareModels(m, last) > 0)) last = m;
  return last?.id ?? null;
}

export function lineReport(g: LineGroup, state: LineState | undefined): ModelLine {
  const s = state ?? emptyState();
  return {
    id: g.id,
    provider: g.provider,
    name: g.name,
    tier: g.tier,
    latest_id: newestStable(g.members)?.id ?? null,
    current_id: currentOf(g, state),
    follow: s.follow,
    previous_id:
      s.previous_id && g.members.some((m) => m.id === s.previous_id && m.have) ? s.previous_id : null,
    pending: s.pending,
  };
}

export { lineAlias };
