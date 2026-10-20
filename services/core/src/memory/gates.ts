/**
 * ------------------------------------------------------------------
 *  Title    |  Memory gates: abstain, and proved or suggested
 *  Ref      |  ROADMAP M8 · DESIGN.md §6.3, §6.5 · docs/memory.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Two cheap gates that keep memory small and trustworthy.
 *           |  Abstain: when no remembered note is relevant enough to
 *           |  the question, inject none, rather than spend the budget
 *           |  on weak word-overlap matches. Proved or suggested: a
 *           |  lesson learned from a run needs two sightings, or checked
 *           |  evidence, before it becomes a rule; seen once it waits as
 *           |  a watch item with its uncertainty written in.
 *  How      |  Pure. RELEVANCE_BAR is compared with memory/index.ts
 *           |  similarity() (cosine over word sets, 0 to 1). Watch items
 *           |  live in core.memory_proposals with status "watching".
 *  Note     |  Ideas from rta-smriti-brain and hindsight (both MIT);
 *           |  the code is ours. A rule the person states themselves
 *           |  (a correction, "remember that...") skips the second gate.
 * ------------------------------------------------------------------
 */

import type { MemoryProposal, Part } from '@nvx/contracts';
import { type CaptureCandidate, type FailureEpisode, toolAttempts } from './capture';
import { similarity } from './index';

/**
 * Abstain gate. A ranked note (FAILURES) is injected only when its similarity to
 * the question reaches this. Cosine over word sets: one shared word between a
 * four-word question and a twelve-word note scores about 0.14 and is dropped;
 * two shared words score about 0.29 and are kept. Raised from 0.08, which
 * let almost any single shared word through. Tune on the eval set before changing
 * (docs/memory.md, "Relevance bar").
 */
export const RELEVANCE_BAR = 0.2;

/** Days a watch item waits for a second sighting before it lapses. */
export const WATCH_DAYS = 90;

/** Sightings a lesson needs before it is more than a suggestion. */
export const SIGHTINGS_NEEDED = 2;

/** Two lessons about the same thing, in different words. */
export const SAME_LESSON = 0.6;

const DAY_MS = 86_400_000;

/** Does a note clear the relevance bar for this question? */
export const clearsBar = (score: number) => score >= RELEVANCE_BAR;

/**
 * Lessons learned from runs go through the second gate. What the person said
 * themselves (a correction, an explicit "remember that") does not.
 */
export function needsSightings(c: Pick<CaptureCandidate, 'kind' | 'explicit' | 'verified' | 'passive'>) {
  // Passive captures keep their own count (the mention ledger in passive.ts).
  if (c.explicit || c.verified || c.passive) return false;
  // A preference is a rule about the person: stated by them, or proposed for their yes.
  return c.kind !== 'preference';
}

export const watchExpiry = (now: Date) => new Date(now.getTime() + WATCH_DAYS * DAY_MS).toISOString();

/** What is not yet known, in words, written into a watch item. */
export function uncertaintyFor(c: Pick<CaptureCandidate, 'kind' | 'text'>): string {
  const subject = c.kind === 'failure_lesson' ? 'lesson' : c.kind === 'model_quirk' ? 'quirk' : 'finding';
  const cause = /\bCause:\s*unclear/i.test(c.text)
    ? 'The cause is not clear, so it may be a coincidence.'
    : 'Nothing has confirmed it yet.';
  return `Seen once. ${cause} This ${subject} becomes a rule if it is seen again, and is dropped if it is not seen again within ${WATCH_DAYS} days.`;
}

/** The watch item that is the same lesson as this candidate, if any. */
export function findWatch(watches: MemoryProposal[], path: string, text: string): MemoryProposal | undefined {
  let best: { p: MemoryProposal; s: number } | undefined;
  for (const p of watches) {
    if (p.status !== 'watching' || p.target_path !== path) continue;
    const s = similarity(text, p.text);
    if (s >= SAME_LESSON && (!best || s > best.s)) best = { p, s };
  }
  return best?.p;
}

/** A watch item that was not seen again in time. */
export const lapsed = (p: Pick<MemoryProposal, 'status' | 'expires_at'>, now: Date) =>
  p.status === 'watching' && !!p.expires_at && Date.parse(p.expires_at) <= now.getTime();

/**
 * Checked evidence for a failure lesson: the tool worked again after the failure,
 * at least twice in the turn, and the cause is stated rather than "Unclear".
 * One lucky retry is not proof; a second success of the same fix is.
 */
export function episodeVerified(
  e: FailureEpisode,
  laterSuccesses: number,
  lesson: { cause: string },
): boolean {
  return (
    e.failed.length > 0 &&
    laterSuccesses >= 2 &&
    lesson.cause.trim() !== '' &&
    !/^unclear/i.test(lesson.cause.trim())
  );
}

/** Successful calls of the episode's tool after its first failure, in the same turn. */
export function laterSuccesses(parts: Part[], e: FailureEpisode): number {
  const all = toolAttempts(parts);
  const first = all.findIndex((a) => a.callId === e.failed[0]?.callId);
  if (first < 0) return 0;
  return all.slice(first + 1).filter((a) => a.tool === e.tool && a.ok).length;
}
