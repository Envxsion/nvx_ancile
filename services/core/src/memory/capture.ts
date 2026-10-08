/**
 * ------------------------------------------------------------------
 *  Title    |  Memory capture and reconciliation
 *  Ref      |  DESIGN.md §6.3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Learn from use: corrections become preferences, a
 *           |  failure followed by a fix becomes a lesson, durable
 *           |  conclusions become project findings, repeated model
 *           |  trouble becomes a model quirk.
 *  How      |  Detectors run after a turn (utility task class, never
 *           |  blocking). Cheap heuristics decide whether a model is
 *           |  asked at all. Candidates are reconciled against the
 *           |  nearest existing entries (ADD / UPDATE / SUPERSEDE /
 *           |  NOOP), then auto-applied above the type's threshold or
 *           |  proposed. Anything that came from tool or source content
 *           |  is only ever proposed: memory cannot be poisoned by a
 *           |  web page.
 *  Note     |  This file is pure: the model calls and the writing live
 *           |  in service.ts. reconcileLocally() is the fallback when
 *           |  no model answers, and the reference the prompt is held to.
 *           |  TODO(phase-5): project findings when a notebook thread goes
 *           |  idle, and model quirks from model_stats thresholds.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';
import { z } from 'zod';
import { similarity, words } from './index';

export type CaptureKind = 'preference' | 'failure_lesson' | 'project_finding' | 'model_quirk';
export type ReconcileOp = 'add' | 'update' | 'supersede' | 'noop';
export type Provenance = 'user_message' | 'run_outcome' | 'tool_output' | 'source_content';

export interface CaptureCandidate {
  kind: CaptureKind;
  targetPath: string;
  section: string;
  text: string;
  confidence: number;
  evidence: { threadId?: string; messageId?: string; runId?: string; quote?: string }[];
  provenance: Provenance;
}

export interface ReconcileDecision {
  op: ReconcileOp;
  /** Entry key being updated or superseded. */
  targetKey?: string;
  text: string;
  rationale: string;
}

/**
 * Auto-apply or propose. The poisoning rule is enforced here, not in the
 * prompt: content the user did not write themselves never auto-applies.
 */
export function applyPolicy(
  c: CaptureCandidate,
  d: ReconcileDecision,
  autoApplyThreshold: number | null,
  mode: 'propose_all' | 'auto_confident' | 'off',
): 'skip' | 'propose' | 'auto_apply' {
  if (mode === 'off' || d.op === 'noop') return 'skip';
  if (c.provenance === 'tool_output' || c.provenance === 'source_content') return 'propose';
  if (mode === 'propose_all' || autoApplyThreshold === null) return 'propose';
  return c.confidence >= autoApplyThreshold ? 'auto_apply' : 'propose';
}

/* ---- What the utility model returns (prompts/memory/*) ----------------------- */

const conf = z.coerce.number().min(0).max(1);

export const CorrectionDetection = z.object({
  is_correction: z.boolean(),
  durable: z.boolean(),
  scope: z.enum(['user', 'notebook', 'none']),
  statement: z.string().max(400),
  confidence: conf,
});
export type CorrectionDetection = z.infer<typeof CorrectionDetection>;

export const ReconcileOutput = z.object({
  op: z.enum(['add', 'update', 'supersede', 'noop']),
  target_key: z.string().nullable().optional(),
  text: z.string().max(600),
  reason: z.string().max(600).default(''),
});

export const FailureLesson = z.object({
  topic: z.string().max(60),
  title: z.string().max(160),
  symptom: z.string().max(500),
  cause: z.string().max(500),
  fix: z.string().max(500),
  recognise: z.string().max(300),
  confidence: conf,
});
export type FailureLesson = z.infer<typeof FailureLesson>;

/** Built-in prompt text, used when prompts/ is not on disk (tests, a bare build). */
export const PROMPTS = {
  detect: {
    id: 'memory.detect-correction',
    output: 'CorrectionDetection',
    fallback:
      'Decide whether the user corrects the assistant in a way worth remembering for future conversations. Fields: is_correction, durable, scope ("user"|"notebook"|"none"), statement (one short general third-person instruction), confidence.\n\nAssistant said:\n{{assistant_message}}\n\nUser replied:\n{{user_message}}\n{{#edited_from}}\n(The user edited an earlier message. It originally said: {{edited_from}})\n{{/edited_from}}',
  },
  reconcile: {
    id: 'memory.reconcile',
    output: 'ReconcileDecision',
    fallback:
      'Choose add, update, supersede or noop for the candidate memory entry against the closest existing entries. Give target_key for update and supersede.\n\nCandidate:\n{{candidate}}\n\nClosest existing entries:\n{{neighbours}}',
  },
  lesson: {
    id: 'memory.failure-lesson',
    output: 'FailureLesson',
    fallback:
      'A task failed, then succeeded. Write the lesson. Fields: topic (slug), title, symptom, cause ("Unclear" if not clear), fix, recognise, confidence.\n\nGoal: {{goal}}\n\nWhat failed:\n{{failed_steps}}\n\nWhat worked:\n{{successful_steps}}\n\nWhat the user said:\n{{user_remarks}}',
  },
} as const;

/* ---- Heuristics: is a model worth asking? ------------------------------------- */

/** The user's own words: quoted lines, code and pasted blocks removed. */
export function ownWords(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/"[^"\n]{60,}"/g, ' ')
    .trim();
}

const OPENERS =
  /^(no\b|nope\b|not\b|wrong\b|actually\b|stop\b|don'?t\b|do not\b|never\b|always\b|please (use|don'?t|do not|stop|always|never)\b|use\b|i (prefer|want|asked|said|meant|told you)\b|that'?s (not|wrong)\b|instead\b)/i;
const ANYWHERE =
  /\b(always|never|from now on|in future|in the future|going forward|next time|every time|instead of|i prefer|i'?d prefer|i'?d rather|please don'?t|stop (using|adding|doing)|don'?t (use|add|ever)|do not (use|add))\b/i;

/**
 * Cheap and generous: true when the reply could be a correction worth
 * asking a model about. Only ever about the user's own words.
 */
export function correctionSignal(input: {
  userText: string;
  /** The assistant message being replied to (or the edited one's answer). */
  assistantText: string | null;
  editedFrom: string | null;
}): boolean {
  const own = ownWords(input.userText);
  if (!own || own.length > 1_500) return false;
  if (input.editedFrom !== null) return true;
  if (!input.assistantText) return false;
  return OPENERS.test(own) || ANYWHERE.test(own);
}

/* ---- Fail, then succeed ------------------------------------------------------- */

export interface ToolAttempt {
  callId: string;
  tool: string;
  args: unknown;
  ok: boolean;
  result: string;
}

export interface FailureEpisode {
  tool: string;
  failed: ToolAttempt[];
  succeeded: ToolAttempt;
}

const brief = (v: unknown, max = 400) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Tool calls of a turn paired with their results, in order. Declined calls are not failures. */
export function toolAttempts(parts: Part[]): ToolAttempt[] {
  const calls = new Map<string, Extract<Part, { type: 'tool_call' }>>();
  const out: ToolAttempt[] = [];
  for (const p of parts) {
    if (p.type === 'tool_call') calls.set(p.call_id, p);
    else if (p.type === 'tool_result' && p.declined_reason === undefined) {
      const c = calls.get(p.call_id);
      if (c) out.push({ callId: c.call_id, tool: c.tool, args: c.args, ok: p.ok, result: brief(p.result) });
    }
  }
  return out;
}

/** Each tool that failed and later succeeded within the turn: one episode per tool. */
export function failureEpisodes(parts: Part[]): FailureEpisode[] {
  const attempts = toolAttempts(parts);
  const out: FailureEpisode[] = [];
  const done = new Set<string>();
  attempts.forEach((a, i) => {
    if (a.ok || done.has(a.tool)) return;
    const fix = attempts.slice(i + 1).find((b) => b.tool === a.tool && b.ok);
    if (!fix) return;
    done.add(a.tool);
    out.push({
      tool: a.tool,
      failed: attempts.slice(i, attempts.indexOf(fix)).filter((b) => b.tool === a.tool && !b.ok),
      succeeded: fix,
    });
  });
  return out;
}

/** A file-name-friendly topic. */
export function topicSlug(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'general';
}

/** One bullet, in the shape FAILURES/README.md describes. */
export function lessonText(l: FailureLesson): string {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return `**${clean(l.title)}.** Symptom: ${clean(l.symptom)}. Cause: ${clean(l.cause)}. Fix: ${clean(l.fix)}. Recognise: ${clean(l.recognise)}.`;
}

/** Without a model: a plain lesson from the attempts themselves. */
export function lessonLocally(e: FailureEpisode): FailureLesson {
  const first = e.failed[0] as ToolAttempt;
  return {
    topic: topicSlug(e.tool.replace(/^fs_/, 'files-')),
    title: `${e.tool} failed before it worked`,
    symptom: first.result.split('\n')[0]?.slice(0, 200) ?? 'It failed',
    cause: 'Unclear',
    fix: `Called again with ${brief(e.succeeded.args, 160)}`,
    recognise: `The same error from ${e.tool}`,
    confidence: 0.6,
  };
}

/* ---- Reconcile ---------------------------------------------------------------- */

export interface Neighbour {
  key: string;
  text: string;
}

const NEGATION = /\b(not|never|no|don'?t|doesn'?t|avoid|without|stop)\b/i;

/**
 * The deterministic fallback, after mem0's rules: an entry that already says
 * it is a no-op; the same subject said better is an update; the same subject
 * with the opposite stance is a supersede; anything else is an add.
 */
export function reconcileLocally(candidate: string, neighbours: Neighbour[]): ReconcileDecision {
  const cw = words(candidate);
  let best: { n: Neighbour; s: number } | null = null;
  for (const n of neighbours) {
    const s = similarity(cw, n.text);
    if (!best || s > best.s) best = { n, s };
  }
  if (!best || best.s < 0.5)
    return { op: 'add', text: candidate, rationale: 'Nothing similar is remembered.' };
  const flips = NEGATION.test(candidate) !== NEGATION.test(best.n.text);
  if (flips)
    return {
      op: 'supersede',
      targetKey: best.n.key,
      text: candidate,
      rationale: 'This replaces an entry that said the opposite.',
    };
  if (best.s >= 0.9 || candidate.trim().toLowerCase() === best.n.text.trim().toLowerCase())
    return { op: 'noop', targetKey: best.n.key, text: best.n.text, rationale: 'Already remembered.' };
  return {
    op: 'update',
    targetKey: best.n.key,
    text: candidate.length >= best.n.text.length ? candidate : best.n.text,
    rationale: 'Says the same thing as an existing entry.',
  };
}

/** A model's decision, held to the rules: unknown keys and empty text fall back. */
export function checkDecision(
  out: z.infer<typeof ReconcileOutput> | null,
  candidate: string,
  neighbours: Neighbour[],
): ReconcileDecision {
  if (!out) return reconcileLocally(candidate, neighbours);
  const key = out.target_key ?? undefined;
  const known = key !== undefined && neighbours.some((n) => n.key === key);
  if ((out.op === 'update' || out.op === 'supersede') && !known)
    return reconcileLocally(candidate, neighbours);
  const text = out.text.trim() || candidate;
  return { op: out.op, ...(known && { targetKey: key }), text, rationale: out.reason || 'Model decision.' };
}

/** Neighbours as the reconcile prompt shows them. */
export const formatNeighbours = (ns: Neighbour[]) =>
  ns.length ? ns.map((n) => `- [${n.key}] ${n.text}`).join('\n') : '(none)';

/** One sentence, capitalised, ending in a full stop. */
export function asEntry(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return t;
  const cap = t[0]?.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}
