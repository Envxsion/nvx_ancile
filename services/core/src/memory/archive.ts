/**
 * ------------------------------------------------------------------
 *  Title    |  Memory archives: reading an export back
 *  Ref      |  docs/memory.md (Import and export)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Open what NVX Ancile's export wrote, so it can be
 *           |  imported (as suggestions) on another install: a zip of
 *           |  the files, a git bundle of the whole repository, or the
 *           |  one-file Markdown export.
 *  How      |  Zip: the central directory is read by hand (stored and
 *           |  deflated entries; zlib inflates), with caps on files and
 *           |  bytes so a hostile archive cannot fill memory. Bundle:
 *           |  `git clone` into a temporary folder, read, then removed.
 *           |  Markdown: the file markers the export writes.
 *  Note     |  Only .md files are read, and only by their path inside
 *           |  the archive; nothing is ever written outside a temporary
 *           |  folder this module makes and removes.
 * ------------------------------------------------------------------
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { AncileError } from '@nvx/contracts';

const run = promisify(execFile);

export interface ArchiveFile {
  /** Forward slashes, relative ("USER.md", "PROJECTS/grant.md"). */
  path: string;
  content: string;
}

/** An archive holds at most this many files, and this many bytes once opened. */
export const ARCHIVE_MAX_FILES = 5_000;
export const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

export const unreadable = (what: string, detail?: string) =>
  new AncileError({
    code: 'memory.import_unreadable',
    title: `That file is not ${what}`,
    hint: 'Pick the file NVX Ancile exported (a .zip, a .bundle or a .md), or paste the text instead.',
    status: 422,
    errorClass: 'permanent',
    ...(detail && { detail: detail.slice(0, 200) }),
  });

const tooBig = () =>
  new AncileError({
    code: 'memory.import_too_large',
    title: 'That archive is too large to import',
    hint: `Memory imports hold up to ${ARCHIVE_MAX_FILES.toLocaleString('en-GB')} files and 64 MB once opened. Import the files you need on their own.`,
    status: 413,
    errorClass: 'permanent',
  });

const isMarkdown = (p: string) => /\.md$/i.test(p) && !p.split('/').some((s) => s.startsWith('.'));

/** The .md files in a zip. Directories, other files and anything outside the archive's own paths are skipped. */
export function readZip(buf: Buffer): ArchiveFile[] {
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw unreadable('a zip file');
    const count = buf.readUInt16LE(eocd + 10);
    if (count > ARCHIVE_MAX_FILES) throw tooBig();
    let off = buf.readUInt32LE(eocd + 16);
    const out: ArchiveFile[] = [];
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) throw unreadable('a zip file', 'bad central directory');
      const method = buf.readUInt16LE(off + 10);
      const csize = buf.readUInt32LE(off + 20);
      const usize = buf.readUInt32LE(off + 24);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const local = buf.readUInt32LE(off + 42);
      const name = buf.toString('utf8', off + 46, off + 46 + nameLen).replace(/\\/g, '/');
      off += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/') || !isMarkdown(name)) continue;
      if (buf.readUInt32LE(local) !== 0x04034b50) throw unreadable('a zip file', 'bad local header');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      total += usize;
      if (total > ARCHIVE_MAX_BYTES) throw tooBig();
      let data: Buffer;
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: ARCHIVE_MAX_BYTES });
      else throw unreadable('a zip file NVX Ancile can open', `compression method ${method}`);
      out.push({ path: name.replace(/^\/+/, ''), content: data.toString('utf8') });
    }
    return out;
  } catch (err) {
    if (err instanceof AncileError) throw err;
    throw unreadable('a zip file', (err as Error).message);
  }
}

/** A git bundle starts with this line (v2 or v3). */
export const isBundle = (buf: Buffer) => /^# v[23] git bundle\n/.test(buf.subarray(0, 20).toString('latin1'));
export const isZip = (buf: Buffer) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) await walk(root, full, out);
    else if (ent.isFile() && /\.md$/i.test(ent.name)) out.push(relative(root, full).split(sep).join('/'));
    if (out.length > ARCHIVE_MAX_FILES) throw tooBig();
  }
}

/** The .md files at the tip of a git bundle's default branch. */
export async function readBundle(buf: Buffer): Promise<ArchiveFile[]> {
  if (!isBundle(buf)) throw unreadable('a git bundle');
  const dir = await mkdtemp(join(tmpdir(), 'ancile-import-'));
  try {
    const file = join(dir, 'in.bundle');
    const tree = join(dir, 'tree');
    await writeFile(file, buf);
    try {
      // An empty template: no hooks are installed, so a bundle is only ever data.
      await run('git', ['clone', '--quiet', '--template=', file, tree], {
        timeout: 60_000,
      });
    } catch (err) {
      throw unreadable('a git bundle NVX Ancile can open', (err as Error).message);
    }
    const paths: string[] = [];
    await walk(tree, tree, paths);
    const out: ArchiveFile[] = [];
    let total = 0;
    for (const p of paths.sort()) {
      const content = await readFile(join(tree, p), 'utf8');
      total += Buffer.byteLength(content);
      if (total > ARCHIVE_MAX_BYTES) throw tooBig();
      out.push({ path: p, content });
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ---- the one-file Markdown export ------------------------------------------------ */

export const MARKDOWN_EXPORT_MARK = '<!-- ancile-memory-export v1';
const FILE_OPEN = /^<!-- ancile-file: (.+?) -->\r?$/;
const FILE_CLOSE = /^<!-- \/ancile-file -->\r?$/;

/** Every file, readable top to bottom, with markers so it can be imported back. */
export function writeMarkdownExport(
  files: ArchiveFile[],
  meta: { head: string; date: string; note: string },
): string {
  const out = [
    '# NVX Ancile memory',
    '',
    `${MARKDOWN_EXPORT_MARK} head:${meta.head} exported:${meta.date} -->`,
    '',
    meta.note,
    '',
  ];
  for (const f of files) {
    out.push('---', '', `## ${f.path}`, '', `<!-- ancile-file: ${f.path} -->`);
    out.push(f.content.replace(/\r?\n$/, ''));
    out.push('<!-- /ancile-file -->', '');
  }
  return `${out.join('\n')}\n`;
}

export const isMarkdownExport = (text: string) => text.slice(0, 4_000).includes(MARKDOWN_EXPORT_MARK);

/** The files inside a Markdown export. */
export function readMarkdownExport(text: string): ArchiveFile[] {
  const out: ArchiveFile[] = [];
  let cur: { path: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const open = FILE_OPEN.exec(line);
    if (!cur && open?.[1]) {
      cur = { path: open[1].trim(), lines: [] };
      continue;
    }
    if (cur && FILE_CLOSE.test(line)) {
      out.push({ path: cur.path, content: `${cur.lines.join('\n')}\n` });
      cur = null;
      continue;
    }
    cur?.lines.push(line);
  }
  if (!out.length) throw unreadable('an NVX Ancile memory export');
  return out;
}
