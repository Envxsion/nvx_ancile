/**
 * ------------------------------------------------------------------
 *  Title    |  Source tags
 *  Ref      |  ROADMAP S6 · contracts/knowledge.ts PatchSourceRequest
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The small rules for tags on sources, kept apart from
 *           |  the screens so they can be tested: reading what was
 *           |  typed, adding and removing in bulk, counting, and
 *           |  filtering by tag.
 *  How      |  Tags are short free words. Case is kept as typed but
 *           |  two tags that differ only in case are one. Knowledge
 *           |  takes up to 40 tags of up to 60 characters.
 * ------------------------------------------------------------------
 */

import type { SourceView } from '../lib/types';

export const MAX_TAGS = 40;
export const MAX_TAG_LENGTH = 60;

/** "energy, sea\nTides" into ["energy", "sea", "Tides"]: trimmed, no blanks, no repeats. */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const t = raw.trim().slice(0, MAX_TAG_LENGTH);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

/** `tags` with `add` joined on and `remove` taken off (matched without regard to case). */
export function editTags(
  tags: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const gone = new Set(remove.map((t) => t.toLowerCase()));
  const kept = tags.filter((t) => !gone.has(t.toLowerCase()));
  return parseTags([...kept, ...add.filter((t) => !gone.has(t.toLowerCase()))].join(','));
}

/** How many sources carry each tag, most used first, then alphabetical. */
export function tagCounts(sources: readonly Pick<SourceView, 'tags'>[]): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const s of sources)
    for (const t of s.tags) {
      const key = t.toLowerCase();
      const cur = counts.get(key);
      if (cur) cur.count++;
      else counts.set(key, { tag: t, count: 1 });
    }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'en-GB'));
}

/** True when the source carries the tag (any case). */
export const hasTag = (s: Pick<SourceView, 'tags'>, tag: string): boolean =>
  s.tags.some((t) => t.toLowerCase() === tag.toLowerCase());

/** The languages offered when setting one by hand: ISO 639-1 code and its name in English. */
export const LANGUAGES: readonly { code: string; name: string }[] = [
  ['ar', 'Arabic'],
  ['zh', 'Chinese'],
  ['nl', 'Dutch'],
  ['en', 'English'],
  ['fr', 'French'],
  ['de', 'German'],
  ['hi', 'Hindi'],
  ['id', 'Indonesian'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['pl', 'Polish'],
  ['pt', 'Portuguese'],
  ['ru', 'Russian'],
  ['es', 'Spanish'],
  ['sv', 'Swedish'],
  ['tr', 'Turkish'],
  ['uk', 'Ukrainian'],
  ['vi', 'Vietnamese'],
].map(([code, name]) => ({ code: code as string, name: name as string }));
