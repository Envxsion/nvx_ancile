/**
 * ------------------------------------------------------------------
 *  Title    |  Memory importers
 *  Ref      |  docs/memory.md (Import and export) · DESIGN.md §6.3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Turn what another tool remembered into candidate
 *           |  entries: an NVX Ancile export (its own paths and
 *           |  sections), a CLAUDE.md or other Markdown notes, and
 *           |  ChatGPT's saved memories (a pasted list, or JSON).
 *  How      |  Pure functions, text in, candidates out. Headings become
 *           |  sections; bullets and paragraphs become entries; code,
 *           |  tables, front matter, HTML comments and Claude Code's
 *           |  @imports are left out and counted. The memory service
 *           |  then marks duplicates and makes proposals.
 *  Note     |  Nothing here decides anything is remembered: every
 *           |  candidate becomes a proposal that waits for a yes.
 *           |  ChatGPT publishes no format for memory in its data
 *           |  export, so only a paste or a plain JSON list is read.
 * ------------------------------------------------------------------
 */

import type { MemoryImportOrigin } from '@nvx/contracts';
import type { ArchiveFile } from './archive';
import { parseMemory } from './format';
import { isGuideFile } from './index';
import { safeMemoryPath } from './repo';

/** Entries are at most this long (cleanEntry's limit); longer ones are cut and flagged. */
export const ENTRY_MAX = 600;

export interface ImportCandidate {
  target_path: string;
  section: string;
  text: string;
  /** The line as it was in the source, for the proposal's evidence. */
  quote: string;
  clipped: boolean;
}

export interface ParsedImport {
  label: string;
  candidates: ImportCandidate[];
  skipped: number;
  notes: string[];
}

export const ORIGIN_LABEL: Record<MemoryImportOrigin, string> = {
  ancile: 'NVX Ancile export',
  claude_code: 'Claude Code memory',
  chatgpt: 'ChatGPT memory',
  markdown: 'Markdown notes',
};

/** One line, no comment markers, at most ENTRY_MAX characters. */
export function entryText(raw: string): { text: string; clipped: boolean } {
  const one = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (one.length <= ENTRY_MAX) return { text: one, clipped: false };
  return { text: `${one.slice(0, ENTRY_MAX - 1).trimEnd()}…`, clipped: true };
}

/** For finding the same entry twice: case, spacing and a final full stop do not count. */
export const sameText = (t: string) =>
  t
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!;:,\s]+$/, '')
    .trim();

function candidate(path: string, section: string, raw: string): ImportCandidate | null {
  const { text, clipped } = entryText(raw);
  if (!text || text.length < 2) return null;
  return { target_path: path, section, text, quote: raw.trim().slice(0, 300), clipped };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---- NVX Ancile's own export ------------------------------------------------------ */

/** Every live entry of every memory file, kept at its own path and section. */
export function fromAncileFiles(files: ArchiveFile[]): ParsedImport {
  const candidates: ImportCandidate[] = [];
  const notes: string[] = [];
  let skipped = 0;
  let badPaths = 0;
  let superseded = 0;
  for (const f of files) {
    let path: string;
    try {
      path = safeMemoryPath(f.path);
    } catch {
      badPaths++;
      continue;
    }
    if (isGuideFile(path)) continue;
    const doc = parseMemory(f.content);
    for (const b of doc.blocks) {
      if (b.kind !== 'entry') continue;
      if (b.superseded) {
        superseded++;
        continue;
      }
      const c = candidate(path, b.section ?? defaultSection(path), b.text);
      if (c) candidates.push(c);
      else skipped++;
    }
  }
  if (badPaths)
    notes.push(
      `${plural(badPaths, 'file')} with a name memory cannot use ${badPaths === 1 ? 'was' : 'were'} left out.`,
    );
  if (superseded)
    notes.push(
      `${plural(superseded, 'superseded entry', 'superseded entries')} ${superseded === 1 ? 'was' : 'were'} left out: only what the export still believed comes in.`,
    );
  return { label: ORIGIN_LABEL.ancile, candidates, skipped, notes };
}

/** Where an entry goes in a file when the source names no section. */
export function defaultSection(path: string): string {
  if (path === 'AGENTS.md') return 'House rules';
  if (path === 'USER.md') return 'Preferences';
  if (path.startsWith('PROJECTS/')) return 'Decisions';
  if (path.startsWith('FAILURES/')) return 'Lessons';
  if (path.startsWith('MODELS/')) return 'Quirks';
  return 'Imported';
}

/* ---- Markdown notes and CLAUDE.md -------------------------------------------------- */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE = /^\s*\|.*\|\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
/** Claude Code's file imports: "@path/to/file" on a line of its own. */
const AT_IMPORT = /^\s*@[^\s]+\s*$/;

/**
 * Bullets and paragraphs, each one entry, under the heading it sits under.
 * Front matter, code, tables, rules, HTML comments and @imports are left out.
 */
export function fromNotes(
  text: string,
  opts: { path: string; label: string; claudeCode?: boolean },
): ParsedImport {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const candidates: ImportCandidate[] = [];
  const fallback = defaultSection(opts.path);
  let section = fallback;
  let skipped = 0;
  let atImports = 0;
  let code = 0;
  let i = 0;

  // Front matter.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---');
    if (end > 0) {
      skipped += end + 1;
      i = end + 1;
    }
  }

  let para: string[] = [];
  let bullet: string[] | null = null;
  const flush = () => {
    for (const raw of [bullet?.join(' '), para.join(' ')]) {
      if (!raw?.trim()) continue;
      const c = candidate(opts.path, section, raw);
      if (c) candidates.push(c);
    }
    para = [];
    bullet = null;
  };

  let inComment = false;
  for (; i < lines.length; i++) {
    let line = lines[i] as string;
    // HTML comments, which may span lines.
    if (inComment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const open = line.indexOf('<!--');
    if (open >= 0) {
      line = line.slice(0, open);
      inComment = true;
    }

    if (FENCE.test(line)) {
      flush();
      const fence = (FENCE.exec(line)?.[1] ?? '```') as string;
      let n = i + 1;
      while (n < lines.length && !(lines[n] as string).trim().startsWith(fence)) n++;
      code++;
      skipped += n - i + 1;
      i = n;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const title = (h[2] ?? '').replace(/[*_`]/g, '').trim();
      // The document's own title (a single #) is not a section.
      section = h[1] === '#' ? fallback : title || fallback;
      if (/^superseded$/i.test(title)) section = '';
      continue;
    }
    if (TABLE.test(line) || RULE.test(line)) {
      flush();
      skipped++;
      continue;
    }
    if (opts.claudeCode && AT_IMPORT.test(line)) {
      flush();
      atImports++;
      skipped++;
      continue;
    }
    if (!section) {
      // Under "Superseded": what the notes no longer hold.
      skipped++;
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      flush();
      bullet = [(b[2] ?? '').replace(/^\[[ xX]\]\s+/, '')];
      continue;
    }
    if (bullet && /^\s{2,}\S/.test(line)) {
      bullet.push(line.trim());
      continue;
    }
    if (bullet) flush();
    para.push(line.trim());
  }
  flush();

  const notes: string[] = [];
  if (code)
    notes.push(
      `${plural(code, 'code block')} ${code === 1 ? 'was' : 'were'} left out: memory holds sentences, not code.`,
    );
  if (atImports)
    notes.push(
      `${plural(atImports, '@import')} ${atImports === 1 ? 'was' : 'were'} left out. NVX Ancile never opens files on its own: pick ${atImports === 1 ? 'that file' : 'those files'} too if you want ${atImports === 1 ? 'it' : 'them'}.`,
    );
  return { label: opts.label, candidates, skipped, notes };
}

/* ---- ChatGPT's saved memories ------------------------------------------------------ */

const MEMORY_KEYS = ['content', 'text', 'memory', 'value'] as const;

function fromJson(value: unknown): string[] | null {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { memories?: unknown }).memories)
      ? ((value as { memories: unknown[] }).memories as unknown[])
      : null;
  if (!list) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object')
      for (const k of MEMORY_KEYS) {
        const v = (item as Record<string, unknown>)[k];
        if (typeof v === 'string') {
          out.push(v);
          break;
        }
      }
  }
  return out;
}

/**
 * ChatGPT: Settings → Personalization → Memory → Manage shows each saved
 * memory on its own line; a paste of that list, one per line (bullets and
 * numbers are fine), or a JSON list of strings or of {content|text|memory}.
 */
export function fromChatGpt(text: string, opts: { path: string }): ParsedImport {
  const trimmed = text.trim();
  let lines: string[] | null = null;
  const notes: string[] = [];
  if (/^[[{]/.test(trimmed)) {
    try {
      lines = fromJson(JSON.parse(trimmed));
    } catch {
      lines = null;
    }
    if (!lines)
      notes.push('That looked like JSON but is not a list of memories, so it was read line by line.');
  }
  lines ??= trimmed.split(/\r?\n/);
  const section = defaultSection(opts.path);
  const candidates: ImportCandidate[] = [];
  let skipped = 0;
  for (const raw of lines) {
    const line = raw
      .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, '')
      .replace(/^["“]|["”]$/g, '')
      .trim();
    // The page's own words, if they came along with the copy.
    if (!line || /^(manage memories|memory|saved memories|delete|delete all)$/i.test(line)) {
      if (raw.trim()) skipped++;
      continue;
    }
    const c = candidate(opts.path, section, line);
    if (c) candidates.push({ ...c, quote: raw.trim().slice(0, 300) });
    else skipped++;
  }
  return { label: ORIGIN_LABEL.chatgpt, candidates, skipped, notes };
}
