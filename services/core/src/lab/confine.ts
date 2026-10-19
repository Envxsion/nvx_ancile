/**
 * ------------------------------------------------------------------
 *  Title    |  Lab path confinement
 *  Ref      |  ROADMAP SC1 · files/confine.ts · docs/errors.md (fs.path_escape)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A lab's engine writes files itself, in its own folder
 *           |  (<workspace>/labs/<thread>). Before Core lets one of
 *           |  its file writes go ahead, the real path is resolved
 *           |  and must still be that folder. A link or junction in
 *           |  a lab that points into another lab, or anywhere else
 *           |  in the workspace, is refused here, before the person
 *           |  is asked, because Core's workspace check alone would
 *           |  count another lab as "inside".
 *  How      |  Edits, writes and patches: the real path must be
 *           |  inside this lab's folder and not a link. A request to
 *           |  leave the folder (external_directory) is the person's
 *           |  to decide, except when it lands in a different lab.
 *  Note     |  Shell commands cannot be inspected this way; they stay
 *           |  CRITICAL and are decided by the person on the command.
 * ------------------------------------------------------------------
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import { AncileError } from '@nvx/contracts';
import { confineEntry, escapeNote, isInside, PATH_ESCAPE, resolveReal } from '../files/confine';
import type { LabAsk, LabPlace } from './permission-map';

const WRITES = new Set(['edit', 'write', 'apply_patch']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Every path an ask names, as absolute paths on this machine. */
export function askPaths(ask: LabAsk, place: LabPlace): string[] {
  const m = ask.metadata;
  const raw = [str(m.filepath), str(m.filePath), str(m.parentDir), ...ask.patterns].filter(
    (x): x is string => !!x && !x.includes('*'),
  );
  const abs = (raw.length ? raw : ['.']).map((p) => (isAbsolute(p) ? resolve(p) : resolve(place.realDir, p)));
  return [...new Set(abs)];
}

/**
 * A reason (for the engine and the model) when this ask would write outside
 * the lab through a link or into another lab; null when it may go on to the
 * permission check.
 */
export async function labRefusal(ask: LabAsk, place: LabPlace): Promise<string | null> {
  const writes = WRITES.has(ask.permission);
  if (!writes && ask.permission !== 'external_directory') return null;
  const labsRoot = dirname(place.realDir);
  for (const p of askPaths(ask, place)) {
    try {
      if (writes) {
        await confineEntry(p, [place.realDir]);
      } else {
        const real = await resolveReal(p, p);
        if (isInside(real, labsRoot) && !isInside(real, place.realDir))
          throw new AncileError({
            code: PATH_ESCAPE,
            title: "That path is in another notebook's folder",
            detail: `${p} is in a different lab`,
            hint: 'Work inside this lab folder. Another lab is not reachable from here.',
            status: 403,
            errorClass: 'policy',
          });
      }
    } catch (err) {
      if (err instanceof AncileError && err.code === PATH_ESCAPE) return escapeNote(err);
      throw err;
    }
  }
  return null;
}
