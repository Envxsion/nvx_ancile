/**
 * ------------------------------------------------------------------
 *  Title    |  A message with its live run laid over it
 *  Ref      |  ROADMAP P2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A message being written is the saved one (empty or
 *           |  old) plus its run: the text so far, which model is
 *           |  writing, whether it failed or was stopped.
 *  How      |  Two layers. `overlay` is the whole message, text and
 *           |  all, and changes with every token: only the row being
 *           |  written subscribes to it. `headOf` is what the rest of
 *           |  the screen needs (status, model, error), which changes
 *           |  a few times per answer, never per token.
 * ------------------------------------------------------------------
 */

import type { LiveTurn } from '../lib/run';
import type { MessageView } from '../lib/types';

export interface LiveHead {
  /** none: no run; writing; error; cancelled; done: finished, the saved text is on its way. */
  code: 'none' | 'writing' | 'error' | 'cancelled' | 'done';
  error: LiveTurn['error'];
  modelId: string | null;
  fallback: LiveTurn['fallback'];
}

export const NO_HEAD: LiveHead = { code: 'none', error: null, modelId: null, fallback: null };

/** The parts of a run that change a few times per answer. Compare the result shallowly. */
export function headOf(live: LiveTurn | undefined): LiveHead {
  if (!live) return NO_HEAD;
  return {
    code: !live.done ? 'writing' : live.error ? 'error' : live.status === 'cancelled' ? 'cancelled' : 'done',
    error: live.error,
    modelId: live.modelId,
    fallback: live.fallback,
  };
}

/** The message with its run's status, model and error, but not its text. */
export function withHead(m: MessageView, h: LiveHead): MessageView {
  if (h.code === 'none') return m;
  return {
    ...m,
    status:
      h.code === 'writing'
        ? 'streaming'
        : h.code === 'error'
          ? 'error'
          : h.code === 'cancelled'
            ? 'stopped'
            : (m.status ?? 'complete'),
    modelId: h.modelId ?? m.modelId,
    ...(h.fallback && { fallback: { from: h.fallback.from, reason: h.fallback.reason } }),
    error: h.error,
  };
}

/** The message as it is now, text included. */
export function overlay(m: MessageView, live: LiveTurn | undefined): MessageView {
  if (!live) return m;
  return {
    ...withHead(m, headOf(live)),
    parts: live.parts.length || !live.done ? live.parts : m.parts,
  };
}
