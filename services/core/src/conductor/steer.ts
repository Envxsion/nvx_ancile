/**
 * ------------------------------------------------------------------
 *  Title    |  Steering a running answer
 *  Ref      |  ROADMAP.md CH7 (Pro half) · conductor/pipeline.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  While a model is working through a tool loop, the
 *           |  person may add a note. It reaches the model at the
 *           |  next step boundary (before its next call), as a user
 *           |  note it can see, instead of waiting for the answer to
 *           |  end. Free keeps one queued message that sends when the
 *           |  turn ends; steering is Pro (the route is Pro's).
 *  How      |  The conductor tells the bus when a plain model turn
 *           |  begins and ends, and asks it for notes before each
 *           |  round. Pro's route offers a note. A note is pending
 *           |  until a round takes it (applied) or the turn ends
 *           |  first (expired: the Cockpit then sends it as a normal
 *           |  message). A flow answers through its own steps, so a
 *           |  flow turn is not steerable. Claude Code never reaches
 *           |  this pipeline: its sessions cannot take a note
 *           |  mid-turn. Memory only: a restart expires every note,
 *           |  and a note that was applied is already in the
 *           |  checkpoint and the answer's provenance.
 *  Note     |  The text is data from the person. It is framed as a
 *           |  note in the request (noteMessage) and never written to
 *           |  memory or a notebook from here.
 * ------------------------------------------------------------------
 */

import { AncileError } from '@nvx/contracts';
import { ulid } from 'ulid';

export type SteerState = 'pending' | 'applied' | 'expired' | 'cancelled';

export interface SteerNote {
  id: string;
  threadId: string;
  /** The answer being written when the note was offered. */
  messageId: string;
  text: string;
  state: SteerState;
  /** Which model round the note went into (0 is the first), once applied. */
  round?: number;
  at: string;
}

/** Why a running turn cannot take a note, or that nothing is running. */
/** flow: a flow answers through its own steps. engine: Claude Code runs its own loop and takes no note mid-turn. */
export type SteerWhy = 'no_turn' | 'flow' | 'engine';

export interface SteerCapability {
  steerable: boolean;
  why?: SteerWhy;
  /** The answer being written. */
  messageId?: string;
}

export const STEER_LIMITS = { chars: 4_000, pending: 3, kept: 500, staleMs: 6 * 60 * 60 * 1000 } as const;

const fail = (code: string, title: string, hint: string, status: number) =>
  new AncileError({ code, title, hint, status, errorClass: 'permanent' });

export const steerNotRunning = () =>
  fail(
    'steer.not_running',
    'No answer is being written here',
    'The turn has ended, so the message sends as a normal one.',
    409,
  );
export const steerNotSupported = (why: SteerWhy) =>
  fail(
    'steer.not_supported',
    why === 'flow'
      ? 'A flow cannot take a note while it runs'
      : why === 'engine'
        ? 'This model cannot take a note while it works'
        : 'This answer cannot take a note',
    'The message waits and sends when this turn ends.',
    409,
  );
export const steerBranchChanged = () =>
  fail(
    'steer.branch_changed',
    'You moved to another branch',
    'A note goes only to the answer it was written for. Send the message here as a new one instead.',
    409,
  );
export const steerTooMany = () =>
  fail(
    'steer.too_many',
    `Up to ${STEER_LIMITS.pending} notes can wait for the next step`,
    'Wait for the model to take them, or remove one.',
    409,
  );
export const steerTooLong = () =>
  fail(
    'steer.too_long',
    `A note can be up to ${STEER_LIMITS.chars.toLocaleString('en-GB')} characters`,
    'Shorten it, or send it as a message when the turn ends.',
    422,
  );

/** How a note reads to the model. The person's words are quoted data inside it. */
export function noteMessage(text: string): string {
  return [
    'Note from the user, added while you were working on the answer above.',
    'Take it into account from here. Carry on with the task unless the note changes it.',
    '',
    '<user_note>',
    text,
    '</user_note>',
  ].join('\n');
}

export class SteerBus {
  private readonly runs = new Map<
    string,
    { messageId: string; steerable: boolean; why: SteerWhy | undefined; since: number }
  >();
  private readonly notes = new Map<string, SteerNote>();
  constructor(private readonly now: () => number = Date.now) {}

  /** A plain model turn started (or resumed after an approval or a restart) in this thread. */
  begin(threadId: string, messageId: string, opts: { steerable: boolean; why?: SteerWhy }): void {
    const had = this.runs.get(threadId);
    this.runs.set(threadId, {
      messageId,
      steerable: opts.steerable,
      why: opts.steerable ? undefined : (opts.why ?? 'flow'),
      since: had?.messageId === messageId ? had.since : this.now(),
    });
  }

  /** The turn is over, however it ended. A note still waiting did not get in. */
  end(threadId: string, messageId: string): void {
    if (this.runs.get(threadId)?.messageId !== messageId) return;
    this.runs.delete(threadId);
    for (const n of this.notes.values())
      if (n.threadId === threadId && n.messageId === messageId && n.state === 'pending') n.state = 'expired';
  }

  private live(threadId: string) {
    const r = this.runs.get(threadId);
    if (r && this.now() - r.since > STEER_LIMITS.staleMs) {
      this.end(threadId, r.messageId);
      return undefined;
    }
    return r;
  }

  capability(threadId: string): SteerCapability {
    const r = this.live(threadId);
    if (!r) return { steerable: false, why: 'no_turn' };
    return r.steerable
      ? { steerable: true, messageId: r.messageId }
      : { steerable: false, why: r.why ?? 'flow', messageId: r.messageId };
  }

  /**
   * Offer a note to the running turn. `forMessageId` is the answer the person wrote it under: if the
   * thread is now writing another one, the person moved branches and the note is refused.
   */
  offer(threadId: string, text: string, forMessageId?: string | null): SteerNote {
    const clean = text.trim();
    // An empty note is Pro's route to refuse (pro.bad_request); here it would only be a no-op.
    if (clean.length > STEER_LIMITS.chars) throw steerTooLong();
    const r = this.live(threadId);
    if (!r) throw steerNotRunning();
    if (!r.steerable) throw steerNotSupported(r.why ?? 'flow');
    if (forMessageId && !forMessageId.startsWith('pending-') && forMessageId !== r.messageId)
      throw steerBranchChanged();
    const waiting = [...this.notes.values()].filter((n) => n.threadId === threadId && n.state === 'pending');
    if (waiting.length >= STEER_LIMITS.pending) throw steerTooMany();
    const note: SteerNote = {
      id: `stn_${ulid()}`,
      threadId,
      messageId: r.messageId,
      text: clean,
      state: 'pending',
      at: new Date(this.now()).toISOString(),
    };
    this.notes.set(note.id, note);
    while (this.notes.size > STEER_LIMITS.kept) {
      const oldest = this.notes.keys().next().value;
      if (oldest === undefined) break;
      this.notes.delete(oldest);
    }
    return note;
  }

  /** The notes waiting for this answer, taken now (before model round `round`). Oldest first. */
  take(threadId: string, messageId: string, round: number): SteerNote[] {
    const taken: SteerNote[] = [];
    for (const n of this.notes.values()) {
      if (n.threadId === threadId && n.messageId === messageId && n.state === 'pending') {
        n.state = 'applied';
        n.round = round;
        taken.push(n);
      }
    }
    return taken;
  }

  get(id: string): SteerNote | undefined {
    return this.notes.get(id);
  }

  /** Take a waiting note back. False when it is already in, or gone. */
  cancel(id: string): boolean {
    const n = this.notes.get(id);
    if (n?.state !== 'pending') return false;
    n.state = 'cancelled';
    return true;
  }
}
