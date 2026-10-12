/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: NVX Ancile's settings for every engine
 *  Ref      |  docs/engines.md (Instructions and persona) · docs/claude-code.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A thread's and its notebook's instructions and persona
 *           |  apply whichever engine answers: the gateway reads them
 *           |  in its system prompt, Claude Code in the note appended
 *           |  to its own system prompt.
 *  How      |  The thread's own value wins over the notebook's, field
 *           |  by field. The note is built from the same inputs in the
 *           |  same order every time, and nothing in it changes from
 *           |  turn to turn (no time, no counts), so Claude Code's
 *           |  prompt cache holds across turns; a session is reopened
 *           |  only when the note itself changes.
 * ------------------------------------------------------------------
 */

import type { AncileInstructions } from '@nvx/contracts';

/** The note's instruction part, at most (the whole appended note stays short). */
export const NOTE_MAX_CHARS = 2_400;

const clean = (s: string | undefined) => (s ?? '').replace(/\r\n/g, '\n').trim();

/** The thread's own value wins over the notebook's, field by field. */
export function effective(
  thread: Partial<AncileInstructions> | null | undefined,
  notebook: Partial<AncileInstructions> | null | undefined,
): AncileInstructions {
  return {
    instructions: clean(thread?.instructions) || clean(notebook?.instructions),
    persona: clean(thread?.persona) || clean(notebook?.persona),
  };
}

/** The instructions and persona as a model reads them; '' when there are none. */
export function instructionsNote(i: AncileInstructions, where: 'thread' | 'notebook' = 'thread'): string {
  const parts: string[] = [];
  if (i.persona) parts.push(`Persona for this ${where}, set by the person in NVX Ancile: ${i.persona}`);
  if (i.instructions)
    parts.push(`Instructions for this ${where}, set by the person in NVX Ancile:\n${i.instructions}`);
  const text = parts.join('\n\n');
  return text.length > NOTE_MAX_CHARS ? `${text.slice(0, NOTE_MAX_CHARS - 1)}…` : text;
}

/**
 * Claude Code's appended system note: NVX Ancile's base note (where it runs,
 * how to use and cite the sources), then the instructions and persona.
 */
export function claudeSystemNote(base: string, i: AncileInstructions): string {
  const extra = instructionsNote(i);
  return extra ? `${base}\n\n${extra}` : base;
}
