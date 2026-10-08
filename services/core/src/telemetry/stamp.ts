/**
 * ------------------------------------------------------------------
 *  Title    |  Telemetry stamp
 *  Ref      |  docs/telemetry.md · the NVX family's x-nvx-stamp
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A small daily proof of work on every batch, so flooding
 *           |  the statistics endpoint costs the sender real time and
 *           |  no secret has to ship in the app.
 *  How      |  v1.<scope>.<YYYYMMDD>.<subject>.<nonce>, where the
 *           |  SHA-256 of the whole string starts with 16 zero bits.
 *           |  The subject is the install id. About 65,000 hashes on
 *           |  average, made once a day and kept.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';

export const STAMP_BITS = 16;

export function stampDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
}

export function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function stampValid(stamp: string, bits = STAMP_BITS): boolean {
  return leadingZeroBits(createHash('sha256').update(stamp).digest()) >= bits;
}

/** Find a nonce for today. Synchronous and short: about 65k hashes. */
export function makeStamp(scope: string, subject: string, now: number, bits = STAMP_BITS): string {
  const prefix = `v1.${scope}.${stampDay(now)}.${subject}.`;
  for (let nonce = 0; nonce < 50_000_000; nonce++) {
    const stamp = `${prefix}${nonce.toString(36)}`;
    if (stampValid(stamp, bits)) return stamp;
  }
  throw new Error('no stamp found');
}
