/**
 * ------------------------------------------------------------------
 *  Title    |  What the engine was given, in words
 *  Ref      |  docs/engines.md (Context for each engine)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  In a thread more than one engine answers, say what this
 *           |  answer's engine read: the window and what was kept back
 *           |  for the answer, messages sent as they were, tool steps
 *           |  digested to one line, older messages recalled because
 *           |  they bear on the question, what was left out, and
 *           |  whether a Claude Code session was started afresh from
 *           |  NVX Ancile's summary.
 *  How      |  Reads provenance.engine_context (EngineContextReport)
 *           |  from the message itself. Recalled messages link to
 *           |  their place in the thread. Also: a decision's rule and
 *           |  the scope level behind it, in words.
 * ------------------------------------------------------------------
 */

import type { EngineContextReport } from '@nvx/contracts';
import { LEVEL_WORDS } from '../scopes/api';

const n = (v: number) => v.toLocaleString('en-GB');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** The facts, as lines; pure, so the tests read the same words the panel shows. */
export function engineContextLines(r: EngineContextReport): string[] {
  const lines: string[] = [];
  if (r.engine === 'claude_code') {
    lines.push(
      r.seeded_from_summary
        ? "A fresh Claude Code session, started from this thread's summary"
        : 'Claude Code carried its own session on; its history was not sent again',
    );
    if (r.foreign_turns)
      lines.push(`${plural(r.foreign_turns, 'turn')} by other models given to it as a short digest`);
    if (r.source_notes) lines.push("A note on the notebook's sources that changed since its last turn");
  } else if (r.window) {
    lines.push(
      `About ${n(r.tokens)} tokens of a ${n(r.window)}-token window, with ${n(r.reserve)} kept back for the answer`,
    );
  }
  if (r.summary_id && !r.seeded_from_summary) lines.push("Older turns came from the thread's summary");
  if (r.verbatim) lines.push(`${plural(r.verbatim, 'message')} sent as they were`);
  if (r.digested) lines.push(`${plural(r.digested, 'tool step')} digested to one line each`);
  if (r.recalled.length)
    lines.push(`${plural(r.recalled.length, 'earlier message')} recalled because they bear on the question`);
  if (r.dropped) lines.push(`${plural(r.dropped, 'message')} left out to fit`);
  return lines;
}

/** A decision's rule in words: "Scope: network", "Floor: recursive delete". */
export function ruleWords(rule: string | null | undefined): string | null {
  if (!rule) return null;
  const [kind, ...rest] = rule.split('.');
  const what = rest.join(' ').replaceAll('_', ' ');
  if (kind === 'scope') return `Scope: ${what}`;
  if (kind === 'floor') return `Floor: ${what}`;
  if (kind === 'tier') return `Tier: ${what}`;
  return rule;
}

export function DecisionRule({
  rule,
  scope,
}: {
  rule: string | null | undefined;
  scope: { field: string; level: string; note: string | null } | null | undefined;
}) {
  const words = ruleWords(rule);
  if (!words) return null;
  const level = scope ? (LEVEL_WORDS[scope.level as keyof typeof LEVEL_WORDS] ?? scope.level) : null;
  return (
    <p className="why__rule">
      <code>{words}</code>
      {level ? (
        <span className="mute">
          {' '}
          · {level}
          {scope?.note ? `: ${scope.note}` : ''}
        </span>
      ) : null}
    </p>
  );
}
