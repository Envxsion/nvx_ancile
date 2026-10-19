/**
 * ------------------------------------------------------------------
 *  Title    |  Your own commands: what runs
 *  Ref      |  ROADMAP KP1 (Pro: flow_lab) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A command of your own is a name plus a chain of
 *           |  palette actions, run in order, or a flow run on the
 *           |  selection or the thread. This runs them and says, in
 *           |  words, which step stopped a chain and why.
 *  How      |  Pure: the palette hands in the actions it already has
 *           |  and the few calls a flow run needs, so it is tested
 *           |  without a screen. A chain is checked whole before its
 *           |  first step runs (a step that is gone, or not available
 *           |  here, stops it with nothing done). Each step is the
 *           |  palette's own function, so Undo, the Trash, scope and
 *           |  permissions are the ones that action always has.
 *  Note     |  A destructive action (archive, delete) may only end a
 *           |  chain: nothing after it would have a thread to act on.
 *           |  The selection is data: it is sent as the words of a
 *           |  message, never run.
 * ------------------------------------------------------------------
 */

import type { UserCommandView } from '../pro/slot';

/** The words cut from a thread or a selection sent to a flow. */
export const FLOW_INPUT_MAX = 12_000;

export interface ChainAction {
  id: string;
  label: string;
  /** Takes something away (archive, delete); Undo or the Trash brings it back. */
  destructive?: boolean;
  /** Why it cannot run here, when it cannot. */
  unavailable?: string;
  run: () => unknown;
}

export type ChainResult =
  | { ok: true; done: number }
  | { ok: false; done: number; step: number; label: string; reason: string };

const stepWords = (n: number, label: string) => `Step ${n}, "${label}"`;

/** Why a chain cannot run as it stands, or null. Nothing has run when this answers. */
export function chainProblem(
  ids: readonly string[],
  find: (id: string) => ChainAction | undefined,
): { step: number; label: string; reason: string } | null {
  for (const [i, id] of ids.entries()) {
    const a = find(id);
    if (!a)
      return {
        step: i + 1,
        label: id,
        reason: 'is no longer a palette command. Edit the command to replace it.',
      };
    if (a.unavailable)
      return { step: i + 1, label: a.label, reason: `is not available here: ${a.unavailable}.` };
    if (a.destructive && i < ids.length - 1)
      return {
        step: i + 1,
        label: a.label,
        reason: 'takes something away, so it can only be the last step.',
      };
  }
  return null;
}

/** Run the steps in order. The first one that fails stops the chain; the result names it. */
export async function runChain(
  ids: readonly string[],
  find: (id: string) => ChainAction | undefined,
): Promise<ChainResult> {
  const bad = chainProblem(ids, find);
  if (bad) return { ok: false, done: 0, ...bad };
  let done = 0;
  for (const [i, id] of ids.entries()) {
    const a = find(id) as ChainAction;
    try {
      await a.run();
    } catch (err) {
      return {
        ok: false,
        done,
        step: i + 1,
        label: a.label,
        reason: `failed${err instanceof Error && err.message ? `: ${err.message}` : '.'}`,
      };
    }
    done += 1;
  }
  return { ok: true, done };
}

/** What to tell the person once a chain has run: for a toast, and for a screen reader. */
export function chainSaid(name: string, r: ChainResult, total: number): { title: string; body?: string } {
  if (r.ok)
    return { title: `${name} done`, body: `${r.done} of ${total} ${total === 1 ? 'step' : 'steps'} ran.` };
  const ran = r.done === 0 ? 'Nothing ran.' : `${r.done} ${r.done === 1 ? 'step' : 'steps'} ran before it.`;
  return {
    title: `${name} stopped at step ${r.step}`,
    body: `${stepWords(r.step, r.label)} ${r.reason} ${ran}`,
  };
}

/** Whether a command is offered here: one tied to a notebook shows only inside it. */
export const commandInScope = (
  c: Pick<UserCommandView, 'notebook_id'>,
  notebookId: string | null | undefined,
) => !c.notebook_id || c.notebook_id === (notebookId ?? null);

/** A line of what it does, for beside its name in the palette. */
export function describeCommand(
  c: UserCommandView,
  label: (id: string) => string | undefined,
  flowName: (id: string) => string | undefined | null,
): string {
  if (c.kind === 'flow') {
    const name = flowName(c.flow_id ?? '');
    const on = c.flow_target === 'selection' ? 'the selection' : 'this thread';
    return name === null ? `Flow missing, was run on ${on}` : `Runs ${name ?? 'a flow'} on ${on}`;
  }
  const n = c.steps.length;
  return `${n} ${n === 1 ? 'step' : 'steps'}: ${c.steps.map((s) => label(s) ?? s).join(', then ')}`;
}

export type FlowRunProblem = 'flow_missing' | 'no_selection' | 'no_thread' | 'empty';

/** What a flow command needs before it can send anything, or why it cannot. */
export function flowInput(
  c: Pick<UserCommandView, 'flow_target'>,
  have: { selection: string; thread: string | null },
): { text: string } | { problem: FlowRunProblem } {
  const raw = c.flow_target === 'selection' ? have.selection : have.thread;
  if (c.flow_target !== 'selection' && raw === null) return { problem: 'no_thread' };
  const text = (raw ?? '').replace(/\r/g, '').trim();
  if (!text) return { problem: c.flow_target === 'selection' ? 'no_selection' : 'empty' };
  return { text: text.length > FLOW_INPUT_MAX ? `${text.slice(0, FLOW_INPUT_MAX)} …` : text };
}

export const FLOW_PROBLEM_WORDS: Record<
  FlowRunProblem,
  (name: string, flow: string) => { title: string; body: string }
> = {
  flow_missing: (name, flow) => ({
    title: `${name} cannot run: its flow is gone`,
    body: `${flow ? `"${flow}" was` : 'The flow was'} deleted or is not visible here. Edit the command to pick another flow.`,
  }),
  no_selection: (name) => ({
    title: `${name} needs some selected text`,
    body: 'Highlight the words in a thread, then open the palette and run it again.',
  }),
  no_thread: (name) => ({
    title: `${name} needs a thread`,
    body: 'Open a thread first, then run it again.',
  }),
  empty: (name) => ({
    title: `${name} has nothing to send`,
    body: 'This thread has no text yet.',
  }),
};

/** A thread as plain text for a flow: who said what, in order. */
export function threadTranscript(
  title: string,
  messages: { role: 'user' | 'assistant'; text: string }[],
): string {
  const body = messages
    .filter((m) => m.text.trim())
    .map((m) => `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.text.trim()}`)
    .join('\n\n');
  return body ? `${title}\n\n${body}` : '';
}
