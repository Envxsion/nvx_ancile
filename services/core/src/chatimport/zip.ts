/**
 * ------------------------------------------------------------------
 *  Title    |  One file out of an export zip
 *  Ref      |  ROADMAP SU1
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  ChatGPT and Claude send their export as a .zip that
 *           |  holds conversations.json beside other files. This
 *           |  opens the zip far enough to read that one file.
 *  How      |  The central directory is read by hand (stored and
 *           |  deflated entries; zlib inflates). Only the entry asked
 *           |  for is opened, and only up to a cap, so a hostile
 *           |  archive cannot fill memory. Nothing is written to disk.
 *  Note     |  Zip64 archives (over 4 GB) are not read; the message
 *           |  says to pick conversations.json out of the zip.
 * ------------------------------------------------------------------
 */

import { inflateRawSync } from 'node:zlib';

export const isZip = (buf: Buffer) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

export class ZipError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreadable' | 'too_large' | 'unsupported',
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

/** The bytes of the first entry whose path (forward slashes) passes `want`, or null when none does. */
export function zipEntry(buf: Buffer, want: (path: string) => boolean, maxBytes: number): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ZipError('no end of central directory', 'unreadable');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new ZipError('zip64', 'unsupported');
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50)
      throw new ZipError('bad central directory', 'unreadable');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen).replace(/\\/g, '/');
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !want(name)) continue;
    if (usize > maxBytes) throw new ZipError('entry too large', 'too_large');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50)
      throw new ZipError('bad local header', 'unreadable');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) return raw;
    if (method === 8) {
      try {
        return inflateRawSync(raw, { maxOutputLength: maxBytes });
      } catch (err) {
        throw new ZipError((err as Error).message, 'too_large');
      }
    }
    throw new ZipError(`compression method ${method}`, 'unsupported');
  }
  return null;
}
