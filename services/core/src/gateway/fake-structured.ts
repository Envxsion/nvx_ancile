/**
 * ------------------------------------------------------------------
 *  Title    |  Offline answers to structured prompts
 *  Ref      |  gateway/fake.ts, memory/llm.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let memory capture (and, via fake-factcheck.ts, fact-
 *           |  checking) work with no provider key: when the
 *           |  offline test model is asked for "JSON matching <Name>",
 *           |  it answers with a plausible object worked out by plain
 *           |  rules instead of chatting.
 *  How      |  One small function per output name. Each reads the
 *           |  variables back out of the rendered prompt.
 *  Note     |  Deliberately simple. "no, use British spelling" gives a
 *           |  durable user preference at 0.9; "the second number is
 *           |  wrong" gives a one-off at low confidence.
 * ------------------------------------------------------------------
 */

import { asEntry, ownWords, reconcileLocally, topicSlug } from '../memory/capture';
import { factcheckReply } from './fake-factcheck';
import { flowReply } from './fake-flows';

export { contentTerms, fakeClaims, fakeVerdict } from './fake-factcheck';

const after = (text: string, label: string, stops: RegExp): string => {
  const i = text.indexOf(label);
  if (i < 0) return '';
  const rest = text.slice(i + label.length);
  const m = stops.exec(rest);
  return (m ? rest.slice(0, m.index) : rest).trim();
};

const ONE_OFF =
  /\b(this (answer|one|reply|response)|that (answer|one)|the (first|second|third|last|next) (number|line|paragraph|item|point|bit)|typo|make (it|this|that) (shorter|longer|simpler)|try again|you missed)\b/i;
const STRONG =
  /\b(always|never|from now on|in future|going forward|every time|use|prefer|don'?t|do not|stop)\b/i;

/** The user's correction as one general instruction. */
export function statementFrom(reply: string): string {
  let s = ownWords(reply).split(/(?<=[.!?])\s|\n/)[0] ?? '';
  s = s
    .replace(/^\s*(no|nope|not quite|actually|wrong|hmm|ok|okay)\b[\s,.!:;-]*/i, '')
    .replace(/^\s*please\s+/i, '')
    .replace(/[\s,]*(please|thanks|thank you)[.!]*$/i, '')
    .trim();
  const rules: [RegExp, string][] = [
    [/^i(?:'d| would)? prefer\s+/i, 'Prefers '],
    [/^i want\s+/i, 'Wants '],
    [/^i (?:use|work with)\s+/i, 'Uses '],
    [/^use\s+/i, 'Uses '],
    [/^(?:don'?t|do not)\s+/i, 'Do not '],
    [/^(?:stop)\s+/i, 'Do not keep '],
    [/^always\s+/i, 'Always '],
    [/^never\s+/i, 'Never '],
  ];
  for (const [re, to] of rules) if (re.test(s)) return asEntry(s.replace(re, to));
  return asEntry(s);
}

function correction(prompt: string): object {
  const reply = after(prompt, 'User replied:\n', /\n\n(\(The user edited|Return JSON)/);
  const own = ownWords(reply);
  const durable = !!own && !ONE_OFF.test(own) && STRONG.test(own);
  const statement = durable ? statementFrom(own) : '';
  const notebook = /\b(in|for) this (notebook|project)\b/i.test(own);
  return {
    is_correction: !!own,
    durable,
    scope: durable ? (notebook ? 'notebook' : 'user') : 'none',
    statement,
    confidence: durable ? (/\b(always|never|from now on|use|prefer)\b/i.test(own) ? 0.9 : 0.75) : 0.3,
  };
}

function reconcile(prompt: string): object {
  const candidate = after(prompt, 'Candidate:\n', /\n\n/);
  const block = after(prompt, 'Closest existing entries:\n', /\n\nReturn JSON|$/);
  const neighbours = [...block.matchAll(/^- \[([^\]]+)\] (.*)$/gm)].map((m) => ({
    key: m[1] as string,
    text: m[2] as string,
  }));
  const d = reconcileLocally(candidate, neighbours);
  return { op: d.op, target_key: d.targetKey ?? null, text: d.text, reason: d.rationale };
}

function lesson(prompt: string): object {
  const failed = after(prompt, 'What failed:\n', /\n\nWhat worked:/);
  const worked = after(prompt, 'What worked:\n', /\n\nWhat the user said:|\n\nReturn JSON|$/);
  const tool = /^- ([\w.:-]+)/m.exec(failed)?.[1] ?? 'tool';
  const error = /: (.*)$/m.exec(failed)?.[1] ?? 'It failed';
  const fix = /^- [\w.:-]+(\(.*\))?/m.exec(worked)?.[1] ?? '';
  return {
    topic: topicSlug(tool.replace(/^fs_/, 'files-')),
    title: `${tool} failed, then worked`,
    symptom: error.slice(0, 200),
    cause: 'Unclear',
    fix: fix ? `Called ${tool} again with ${fix.slice(1, -1).slice(0, 160)}` : `Called ${tool} again`,
    recognise: `The same error from ${tool}`,
    confidence: 0.8,
  };
}

const ANSWERS: Record<string, (prompt: string) => object> = {
  CorrectionDetection: correction,
  ReconcileDecision: reconcile,
  FailureLesson: lesson,
};

/** JSON text when the prompt asks for a shape we know (memory or fact-check), otherwise null. */
export function structuredReply(prompt: string): string | null {
  const name = /Return JSON matching (\w+)/.exec(prompt)?.[1];
  const answer = name ? ANSWERS[name] : undefined;
  if (answer) return JSON.stringify(answer(prompt));
  return factcheckReply(prompt) ?? flowReply(prompt) ?? null;
}
