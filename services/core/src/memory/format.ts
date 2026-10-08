/**
 * ------------------------------------------------------------------
 *  Title    |  Memory file format
 *  Ref      |  DESIGN.md §6.2
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Memory is markdown a person can read and edit, with just
 *           |  enough structure for a machine to address each entry:
 *           |
 *           |    - Use British spelling. <!-- m:01J9Z3 conf:0.92 src:msg_x at:2026-10-07 -->
 *           |
 *           |  Entries are whole top-level bullets. Trailers are HTML
 *           |  comments, invisible when rendered, safe to hand-edit.
 *  How      |  The file is parsed into blocks that keep their original
 *           |  bytes. render() concatenates them, so an untouched file
 *           |  round-trips byte for byte (CRLF, missing final newline,
 *           |  odd spacing and all). Editing an entry rewrites only that
 *           |  entry's block.
 *  Note     |  An entry without a trailer is still an entry: its key is
 *           |  derived from its text and the file is left alone.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

export interface EntryMeta {
  /** Stable key, from the trailer's m: field. */
  m?: string;
  conf?: number;
  src?: string;
  at?: string;
  superseded_by?: string;
  [k: string]: string | number | undefined;
}

export interface EntryBlock {
  kind: 'entry';
  raw: string;
  key: string;
  /** Entry text without the bullet marker or trailer, continuation lines joined with \n */
  text: string;
  meta: EntryMeta;
  section: string | null;
  superseded: boolean;
}

export interface RawBlock {
  kind: 'raw';
  raw: string;
  /** Set when the block is a heading line. */
  heading?: { level: number; title: string };
}

export type Block = EntryBlock | RawBlock;

export interface MemoryDoc {
  frontMatterRaw: string;
  frontMatter: Record<string, unknown>;
  blocks: Block[];
  /** The line ending this file uses, for new lines we write. */
  eol: '\n' | '\r\n';
}

const BULLET = /^[-*] (.*)$/;
const CONT = /^(?: {2,}|\t)\S/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TRAILER = /\s*<!--\s*(.*?)\s*-->\s*$/;
const SUPERSEDED_SECTION = /^superseded$/i;

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, '');
}

export function parseTrailer(body: string): EntryMeta {
  const meta: EntryMeta = {};
  for (const token of body.split(/\s+/).filter(Boolean)) {
    const i = token.indexOf(':');
    if (i <= 0) continue;
    const k = token.slice(0, i);
    const v = token.slice(i + 1);
    meta[k] = k === 'conf' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
  }
  return meta;
}

export function formatTrailer(meta: EntryMeta): string {
  const order = ['m', 'conf', 'src', 'at', 'superseded_by'];
  const keys = [
    ...order.filter((k) => meta[k] !== undefined),
    ...Object.keys(meta).filter((k) => !order.includes(k) && meta[k] !== undefined),
  ];
  return `<!-- ${keys.map((k) => `${k}:${meta[k]}`).join(' ')} -->`;
}

/** Key for an entry with no trailer: stable across whitespace changes. */
export function derivedKey(text: string): string {
  const norm = text.replace(/~~/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `h:${createHash('sha1').update(norm).digest('hex').slice(0, 10)}`;
}

function makeEntry(lines: string[], section: string | null): EntryBlock {
  const raw = lines.join('');
  const bodyLines = lines.map(stripEol);
  bodyLines[0] = (BULLET.exec(bodyLines[0] as string)?.[1] ?? '') as string;
  const last = bodyLines.length - 1;
  let meta: EntryMeta = {};
  const t = TRAILER.exec(bodyLines[last] as string);
  if (t) {
    meta = parseTrailer(t[1] as string);
    bodyLines[last] = (bodyLines[last] as string).slice(0, t.index);
  }
  const text = bodyLines
    .map((l, i) => (i === 0 ? l : l.trim()))
    .join('\n')
    .trim();
  const struck = /^~~[\s\S]*~~$/.test(text);
  return {
    kind: 'entry',
    raw,
    key: meta.m ?? derivedKey(text),
    text: struck ? text.slice(2, -2) : text,
    meta,
    section,
    superseded:
      struck || (section !== null && SUPERSEDED_SECTION.test(section)) || meta.superseded_by !== undefined,
  };
}

export function parseMemory(source: string): MemoryDoc {
  const eol: MemoryDoc['eol'] = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/(?<=\n)/);
  let i = 0;
  let frontMatterRaw = '';
  let frontMatter: Record<string, unknown> = {};

  if (lines[0] !== undefined && stripEol(lines[0]) === '---') {
    const end = lines.findIndex((l, j) => j > 0 && stripEol(l) === '---');
    if (end > 0) {
      frontMatterRaw = lines.slice(0, end + 1).join('');
      try {
        const parsed = parseYaml(lines.slice(1, end).join(''));
        frontMatter = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        frontMatter = {}; // integrity check reports it; parsing the body still works
      }
      i = end + 1;
    }
  }

  const blocks: Block[] = [];
  let section: string | null = null;
  let entry: string[] | null = null;
  const flush = () => {
    if (entry) blocks.push(makeEntry(entry, section));
    entry = null;
  };

  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    const bare = stripEol(line);
    if (entry && CONT.test(bare)) {
      entry.push(line);
      continue;
    }
    flush();
    if (BULLET.test(bare)) {
      entry = [line];
      continue;
    }
    const h = HEADING.exec(bare);
    if (h) {
      section = h[2] as string;
      blocks.push({ kind: 'raw', raw: line, heading: { level: (h[1] as string).length, title: section } });
      continue;
    }
    blocks.push({ kind: 'raw', raw: line });
  }
  flush();
  return { frontMatterRaw, frontMatter, blocks, eol };
}

export function renderMemory(doc: MemoryDoc): string {
  return doc.frontMatterRaw + doc.blocks.map((b) => b.raw).join('');
}

export function entries(doc: MemoryDoc, opts: { includeSuperseded?: boolean } = {}): EntryBlock[] {
  return doc.blocks.filter(
    (b): b is EntryBlock => b.kind === 'entry' && (opts.includeSuperseded || !b.superseded),
  );
}

function entryRaw(text: string, meta: EntryMeta, eol: string, struck = false): string {
  const lines = text.split('\n');
  const first = struck ? `~~${lines.join(' ')}~~` : (lines[0] as string);
  const rest = struck ? [] : lines.slice(1).map((l) => `  ${l}`);
  const body = [first, ...rest];
  body[body.length - 1] = `${body[body.length - 1]} ${formatTrailer(meta)}`;
  return `- ${body.join(eol)}${eol}`;
}

function ensureTrailingEol(doc: MemoryDoc): void {
  const last = doc.blocks.at(-1);
  if (last && !last.raw.endsWith('\n')) last.raw += doc.eol;
  else if (!last && doc.frontMatterRaw && !doc.frontMatterRaw.endsWith('\n')) doc.frontMatterRaw += doc.eol;
}

/**
 * Add an entry at the end of a section (created if missing). Returns a new
 * doc; blocks outside the touched region keep their bytes.
 */
export function addEntry(
  doc: MemoryDoc,
  sectionTitle: string,
  text: string,
  meta: EntryMeta & { m: string },
): MemoryDoc {
  const next: MemoryDoc = { ...doc, blocks: doc.blocks.map((b) => ({ ...b })) };
  const block = makeEntry([entryRaw(text, meta, doc.eol)], sectionTitle);
  const hIdx = next.blocks.findIndex(
    (b) => b.kind === 'raw' && b.heading?.title.toLowerCase() === sectionTitle.toLowerCase(),
  );
  if (hIdx < 0) {
    ensureTrailingEol(next);
    const needsGap = next.blocks.length > 0 && next.blocks.at(-1)?.raw.trim() !== '';
    if (needsGap) next.blocks.push({ kind: 'raw', raw: doc.eol });
    next.blocks.push({
      kind: 'raw',
      raw: `## ${sectionTitle}${doc.eol}`,
      heading: { level: 2, title: sectionTitle },
    });
    next.blocks.push({ kind: 'raw', raw: doc.eol });
    next.blocks.push(block);
    return next;
  }
  // After the last entry of this section, or right after the heading's blank line.
  let insertAt = hIdx + 1;
  for (let j = hIdx + 1; j < next.blocks.length; j++) {
    const b = next.blocks[j] as Block;
    if (b.kind === 'raw' && b.heading) break;
    if (b.kind === 'entry') insertAt = j + 1;
    else if (insertAt === hIdx + 1 && b.raw.trim() === '') insertAt = j + 1;
  }
  const prev = next.blocks[insertAt - 1];
  if (prev && !prev.raw.endsWith('\n')) prev.raw += doc.eol;
  next.blocks.splice(insertAt, 0, block);
  return next;
}

export function updateEntry(doc: MemoryDoc, key: string, text: string, meta: Partial<EntryMeta>): MemoryDoc {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => {
      if (b.kind !== 'entry' || b.key !== key) return b;
      const merged: EntryMeta = { ...b.meta, ...meta, m: b.meta.m ?? key };
      const raw = entryRaw(text, merged, doc.eol);
      // Keep the file's last-line convention: no final newline stays no final newline.
      return makeEntry([b.raw.endsWith('\n') ? raw : raw.slice(0, -doc.eol.length)], b.section);
    }),
  };
}

/**
 * Supersede: keep the old belief, struck through, in "## Superseded", and
 * point it at what replaced it (temporal validity, DESIGN.md §6.2).
 */
export function supersedeEntry(doc: MemoryDoc, key: string, byKey: string, at: string): MemoryDoc {
  const old = entries(doc).find((e) => e.key === key);
  if (!old) return doc;
  const without: MemoryDoc = {
    ...doc,
    blocks: doc.blocks.filter((b) => !(b.kind === 'entry' && b.key === key)),
  };
  const meta: EntryMeta & { m: string } = { ...old.meta, m: old.meta.m ?? key, superseded_by: byKey, at };
  delete meta.conf;
  delete meta.src;
  const added = addEntry(without, 'Superseded', old.text, meta);
  // Rewrite the just-added block struck through.
  return {
    ...added,
    blocks: added.blocks.map((b) =>
      b.kind === 'entry' && b.key === meta.m && b.section?.toLowerCase() === 'superseded'
        ? makeEntry([entryRaw(old.text, meta, doc.eol, true)], 'Superseded')
        : b,
    ),
  };
}
