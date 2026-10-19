/**
 * ------------------------------------------------------------------
 *  Title    |  Notes you added while an answer was written
 *  Ref      |  ROADMAP.md CH7 (Pro half) · conductor/steer.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Under an answer the model was steered through, say so
 *           |  and show the words, so the thread still reads true
 *           |  later: "You added a note at step 2".
 *  How      |  Core records each note on the answer's provenance
 *           |  (`steered`: text, round, time). This only reads it; the
 *           |  words are shown as plain text, never as Markdown.
 * ------------------------------------------------------------------
 */

import { Icon } from '../ui/Icon';

interface Steered {
  text: string;
  round: number;
}

/** The notes Core recorded on an answer, in the order the model took them. */
export function steeredOf(provenance: unknown): Steered[] {
  const raw = (provenance as { steered?: unknown } | undefined)?.steered;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((n) => {
    const o = n as { text?: unknown; round?: unknown };
    return typeof o.text === 'string' && o.text
      ? [{ text: o.text, round: typeof o.round === 'number' ? o.round : 0 }]
      : [];
  });
}

export function SteerNotes({ provenance }: { provenance: unknown }) {
  const notes = steeredOf(provenance);
  if (!notes.length) return null;
  return (
    <>
      {notes.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list read from the answer; two notes may match
        <p key={i} className="msg__saved">
          <Icon name="edit" size={12} />
          <span>{`You added a note at step ${n.round + 1}`}</span>
          <span className="msg__saved-text mute" title={n.text}>
            {n.text}
          </span>
        </p>
      ))}
    </>
  );
}
