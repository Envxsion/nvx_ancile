/**
 * ------------------------------------------------------------------
 *  Title    |  Branch suggestions
 *  Ref      |  DESIGN.md §8.5, prompts/threads/branch-suggest.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Notice when a new message starts a different topic and
 *           |  offer, quietly, to branch. It never branches by itself.
 *  How      |  Two stages. A cheap lexical drift check compares the new
 *           |  message's content words with the recent questions on its
 *           |  path; only when that fires does the utility model judge
 *           |  whether it is really a new topic. A `suggestion` event
 *           |  carries the result to the Cockpit as a chip.
 *  Note     |  TODO(phase-5): embedding drift (centroid of the recent
 *           |  path) once Core has an embedder; the lexical check is a
 *           |  deliberately conservative stand-in.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import { ancestorPath } from './path';
import { asTree, type ThreadRecord, type ThreadRepo, textOf } from './repo';
import { readJson, runUtility, type UtilityDeps } from './utility';

const log = logFor('threads.suggest');

const STOP = new Set(
  'about above after again also always another because been before being below between both could does doing down during each from further have having here into itself just more most much must never only other over same should some such than that their them then there these they this those through under until very want what when where which while will with would your yours please thanks thank tell make like need know think help using used'.split(
    ' ',
  ),
);

/** Content words: lower case, four letters or more, no stop words. */
export function contentWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{3,}/gu) ?? []).filter((w) => !STOP.has(w)),
  );
}

/**
 * Lexical drift: how much of the new message's vocabulary the recent
 * questions share. Fires only with enough history and enough words to judge.
 */
export function topicDrift(recent: string[], next: string): { fired: boolean; overlap: number } {
  const words = contentWords(next);
  if (recent.length < 3 || words.size < 5) return { fired: false, overlap: 1 };
  const seen = new Set(recent.flatMap((r) => [...contentWords(r)]));
  let shared = 0;
  for (const w of words) if (seen.has(w)) shared++;
  const overlap = shared / words.size;
  return { fired: overlap < 0.1, overlap };
}

const Shift = z.object({
  shift: z.boolean(),
  confidence: z.number().min(0).max(1),
  new_topic: z.string().max(80),
  reason: z.string().max(400),
});

const FALLBACK =
  'Recent topics:\n{{recent_topics}}\n\nNew message:\n{{new_message}}\n\nIs the new message a different topic? Return JSON: {"shift": true|false, "confidence": 0..1, "new_topic": "2-5 words", "reason": "one sentence"}';

/** Build the afterSend hook for startTurn. */
export function branchSuggester(deps: UtilityDeps & { repo: ThreadRepo; bus?: EventBus }) {
  return async (thread: ThreadRecord, userMessageId: string) => {
    const all = await deps.repo.messages(thread.id);
    const byId = new Map(asTree(all).map((m) => [m.id, m] as const));
    if (!byId.has(userMessageId)) return;
    const path = ancestorPath(byId, userMessageId);
    const questions = path.filter((m) => m.role === 'user').map((m) => textOf(m.parts));
    const next = questions.pop() ?? '';
    const recent = questions.slice(-6);
    const drift = topicDrift(recent, next);
    if (!drift.fired) return;
    const res = await runUtility(deps, {
      promptId: 'threads.branch-suggest',
      fallback: FALLBACK,
      vars: {
        recent_topics: recent.map((q) => `- ${q.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n'),
        new_message: next.slice(0, 2_000),
      },
      maxOutputTokens: 200,
    }).catch(() => null);
    const verdict = res ? readJson(res.text, Shift) : null;
    if (!verdict?.shift || verdict.confidence < 0.5) return;
    log.info({ thread_id: thread.id, overlap: drift.overlap }, 'suggesting a branch for a new topic');
    await deps.bus
      ?.publish({
        type: 'suggestion',
        kind: 'branch',
        ref: userMessageId,
        thread_id: thread.id,
        title: verdict.new_topic,
        message: `This looks like a new topic: ${verdict.new_topic}`,
      })
      .catch(() => undefined);
  };
}
