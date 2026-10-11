/**
 * ------------------------------------------------------------------
 *  Title    |  Minimal tarball reader
 *  Ref      |  docs/claude-code.md (how the Agent SDK is fetched)
 *  ID       |  claude-bridge
 * ------------------------------------------------------------------
 *  Purpose  |  Unpack one npm package tarball (.tgz) into a folder,
 *           |  without a tar dependency.
 *  How      |  gunzip with node:zlib, then walk the 512-byte ustar
 *           |  headers. Regular files and folders only; pax and GNU
 *           |  long names are honoured; links, devices and anything
 *           |  that would land outside the target folder are refused.
 *  Note     |  npm tarballs put everything under "package/"; strip
 *           |  drops that first segment.
 * ------------------------------------------------------------------
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Largest unpacked size accepted (the SDK is a few MB). */
const MAX_UNPACKED = 200 * 1024 * 1024;

export interface TarEntry {
  path: string;
  type: 'file' | 'dir';
  data: Buffer;
  mode: number;
}

function str(buf: Buffer, start: number, len: number): string {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul < 0 ? s.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, len: number): number {
  const s = str(buf, start, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

/** Parse "len key=value\n" pax records. */
function paxPath(data: Buffer): string | undefined {
  let i = 0;
  const text = data.toString('utf8');
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = Number.parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0 && rec.slice(0, eq) === 'path') return rec.slice(eq + 1);
    i += len;
  }
  return undefined;
}

/** Read every entry of a gzipped tarball. */
export function readTgz(tgz: Buffer): TarEntry[] {
  const tar = gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED });
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const flag = String.fromCharCode(header[156] ?? 0);
    const prefix = str(header, 345, 155);
    const name = str(header, 0, 100);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;

    if (flag === 'x') {
      longName = paxPath(body) ?? longName;
      continue;
    }
    if (flag === 'L') {
      longName = str(body, 0, body.length);
      continue;
    }
    if (flag === 'g') continue;
    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;
    if (flag === '0' || flag === '\0' || flag === '7') {
      out.push({ path, type: 'file', data: Buffer.from(body), mode: octal(header, 100, 8) });
    } else if (flag === '5') {
      out.push({ path, type: 'dir', data: Buffer.alloc(0), mode: 0o755 });
    }
    // Links, devices and fifos are never needed from a package: skipped.
  }
  return out;
}

/** A tarball path made safe under `root`, or null when it would escape. */
export function safeJoin(root: string, path: string, strip: number): string | null {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean).slice(strip);
  if (!parts.length) return null;
  const rel = parts.join('/');
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const full = normalize(join(root, rel));
  const back = relative(root, full);
  if (!back || back.startsWith('..') || isAbsolute(back) || back.split(sep).includes('..')) return null;
  return full;
}

/** Unpack a .tgz into `dest`, dropping the first `strip` path segments. */
export async function extractTgz(tgz: Buffer, dest: string, strip = 1): Promise<number> {
  let files = 0;
  for (const e of readTgz(tgz)) {
    const target = safeJoin(dest, e.path, strip);
    if (!target) {
      if (e.path.replace(/\\/g, '/').split('/').filter(Boolean).length <= strip) continue;
      throw new Error(`The package contains a path outside its folder: ${e.path.slice(0, 120)}`);
    }
    if (e.type === 'dir') {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, e.data, { mode: (e.mode & 0o777) | 0o600 });
    files++;
  }
  return files;
}
