/**
 * ------------------------------------------------------------------
 *  Title    |  Hindsight pass
 *  Ref      |  ROADMAP M9 · DESIGN.md §6.3 · docs/memory.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Look back over a finished session for what it taught:
 *           |  root causes, kept apart as process lessons (how to work)
 *           |  and environment facts (what is true of this machine or
 *           |  project). "Nothing worth keeping" is a valid answer.
 *  How      |  Pure. The session's path is cut into numbered turns, then
 *           |  condensed to a token cap (long sessions are summarised by
 *           |  trimming each turn, then by leaving out the quiet ones).
 *           |  A utility model reviews it; every item it returns must
 *           |  cite a turn it was actually shown, or it is dropped, so a
 *           |  model cannot invent a lesson from nowhere.
 *  Note     |  Proposes only. service.hindsight() files each item in the
 *           |  inbox as a proposal; nothing here or there writes memory.
 *           |  Idea from hindsight (MIT); the code and prompt are ours.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';
import type { MessageRecord } from '../threads/repo';
import { textOf } from '../threads/repo';
import { toolAttempts } from './capture';
import { approxTokens } from './inject';

/** Tokens of session text the review model is shown. Longer sessions are condensed to fit. */
export const HINDSIGHT_INPUT_TOKENS = 6_000;

/** The most proposals one pass will file. */
export const HINDSIGHT_MAX_ITEMS = 6;

const conf = z.coerce.number().min(0).max(1);

export const HindsightReview = z.object({
  nothing_worth_keeping: z.boolean(),
  note: z.string().max(600).default(''),
  items: z
    .array(
      z.object({
        kind: z.enum(['process_lesson', 'environment_fact']),
        topic: z.string().max(60).default('general'),
        root_cause: z.string().max(400).default(''),
        text: z.string().max(500),
        turn: z.coerce.number().int(),
        confidence: conf.default(0.6),
      }),
    )
    .max(20)
    .default([]),
});
export type HindsightReview = z.infer<typeof HindsightReview>;

export const HINDSIGHT_PROMPT = {
  id: 'memory.hindsight',
  output: 'HindsightReview',
  fallback:
    'Review this finished session for what it taught. Find root causes, not symptoms. Fields: nothing_worth_keeping (boolean), note (one or two sentences), items (each: kind "process_lesson" or "environment_fact", topic, root_cause, text, turn, confidence). Every item must cite the number of the turn it came from. If nothing is worth keeping, say so.\n\nSession:\n{{session}}',
} as const;

export interface Turn {
  /** 1-based, in the order of the conversation. */
  n: number;
  /** The message to point at: the answer, or the question when it has no answer. */
  messageId: string;
  user: string;
  assistant: string;
  tools: string[];
}

/** The path root to head, cut into turns: one question and what came back. */
export function turnsOf(path: MessageRecord[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of path) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      turns.push({ n: turns.length + 1, messageId: m.id, user: textOf(m.parts), assistant: '', tools: [] });
      continue;
    }
    const t = turns.at(-1) ?? { n: 1, messageId: m.id, user: '', assistant: '', tools: [] };
    if (!turns.length) turns.push(t);
    t.messageId = m.id;
    const text = textOf(m.parts);
    t.assistant = t.assistant ? `${t.assistant}\n${text}` : text;
    for (const a of toolAttempts(m.parts))
      t.tools.push(
        `${a.tool} ${a.ok ? 'worked' : 'failed'}${a.ok ? '' : `: ${a.result.split('\n')[0]?.slice(0, 160) ?? ''}`}`,
      );
  }
  return turns;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function render(t: Turn, chars: number): string {
  const lines = [`Turn ${t.n}`, `User: ${clip(t.user, chars)}`];
  if (t.assistant) lines.push(`Assistant: ${clip(t.assistant, chars)}`);
  if (t.tools.length) lines.push(`Tools: ${t.tools.slice(0, 6).join('; ')}`);
  return lines.join('\n');
}

const troubled = (t: Turn) =>
  t.tools.some((x) => x.includes(' failed')) || /^\s*(no\b|nope|don'?t|wrong|stop|actually)/i.test(t.user);

export interface Condensed {
  text: string;
  /** Turn numbers the model was shown (and may cite). */
  shown: number[];
  /** The session was too long to show whole. */
  summarised: boolean;
}

/**
 * The session as text under a token cap. Whole if it fits; otherwise each turn is
 * trimmed to the longest length that fits; if even the shortest does not, turns
 * where something went wrong, the first turn and the last two are kept and the
 * quiet ones left out (said so in the text).
 */
export function condense(turns: Turn[], capTokens = HINDSIGHT_INPUT_TOKENS): Condensed {
  const all = turns.map((t) => t.n);
  const whole = turns.map((t) => render(t, 4_000)).join('\n\n');
  if (approxTokens(whole) <= capTokens) return { text: whole, shown: all, summarised: false };

  for (const chars of [1_200, 600, 300, 150]) {
    const text = turns.map((t) => render(t, chars)).join('\n\n');
    if (approxTokens(text) <= capTokens) return { text, shown: all, summarised: true };
  }

  const keep = new Set<number>([turns[0]?.n ?? 1, ...turns.slice(-2).map((t) => t.n)]);
  const chosen = new Set(keep);
  const text = (): { out: string; shown: number[] } => {
    const shown = turns.filter((t) => chosen.has(t.n)).map((t) => t.n);
    const parts: string[] = [];
    let last = 0;
    for (const t of turns.filter((x) => chosen.has(x.n))) {
      if (t.n - last > 1)
        parts.push(`(${t.n - last - 1} quiet turn${t.n - last - 1 === 1 ? '' : 's'} left out)`);
      parts.push(render(t, 150));
      last = t.n;
    }
    return { out: parts.join('\n\n'), shown };
  };
  for (const t of turns) {
    if (!troubled(t) || chosen.has(t.n)) continue;
    chosen.add(t.n);
    if (approxTokens(text().out) > capTokens) {
      chosen.delete(t.n);
      break;
    }
  }
  const { out, shown } = text();
  return { text: out, shown, summarised: true };
}

export type CheckedItem = HindsightReview['items'][number] & {
  /** The message of the cited turn. */
  messageId: string;
  quote: string;
};

/**
 * The model's items, held to the rules: each must cite a turn it was shown,
 * say something, and not repeat another; at most HINDSIGHT_MAX_ITEMS.
 */
export function checkReview(
  out: HindsightReview,
  turns: Turn[],
  shown: number[],
): { items: CheckedItem[]; dropped: number } {
  const byN = new Map(turns.map((t) => [t.n, t] as const));
  const seen = new Set<string>();
  const items: CheckedItem[] = [];
  let dropped = 0;
  for (const it of out.items) {
    const t = byN.get(it.turn);
    const text = it.text.replace(/\s+/g, ' ').trim();
    const key = text.toLowerCase();
    if (!t || !shown.includes(it.turn) || !text || seen.has(key) || items.length >= HINDSIGHT_MAX_ITEMS) {
      dropped++;
      continue;
    }
    seen.add(key);
    items.push({ ...it, text, messageId: t.messageId, quote: clip(t.assistant || t.user, 240) });
  }
  return { items, dropped };
}
