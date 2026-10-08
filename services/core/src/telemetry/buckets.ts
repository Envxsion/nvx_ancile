/**
 * ------------------------------------------------------------------
 *  Title    |  Telemetry buckets
 *  Ref      |  packages/contracts/src/telemetry.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Turn exact numbers into the ranges that are sent, so no
 *           |  count or time ever leaves this computer exactly.
 *  How      |  Counts go into COUNT_BUCKETS or WIDE_BUCKETS; times into
 *           |  MS_BUCKETS, kept as a per-day histogram whose p50 and
 *           |  p95 are read back as a bucket.
 * ------------------------------------------------------------------
 */

import { telemetry } from '@nvx/contracts';

type CountBucket = (typeof telemetry.COUNT_BUCKETS)[number];
type WideBucket = (typeof telemetry.WIDE_BUCKETS)[number];
type MsBucket = (typeof telemetry.MS_BUCKETS)[number];

export function count(n: number): CountBucket {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 3) return '2-3';
  if (n <= 6) return '4-6';
  if (n <= 12) return '7-12';
  return '13+';
}

export function wide(n: number): WideBucket {
  if (n <= 0) return '0';
  if (n < 10) return '1-9';
  if (n < 50) return '10-49';
  if (n < 100) return '50-99';
  if (n < 500) return '100-499';
  return '500+';
}

const MS_EDGES = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000];

/** Index into MS_BUCKETS for a duration. */
export function msIndex(ms: number): number {
  const i = MS_EDGES.findIndex((edge) => ms < edge);
  return i === -1 ? MS_EDGES.length : i;
}

export function ms(ms: number): MsBucket {
  return telemetry.MS_BUCKETS[msIndex(ms)] as MsBucket;
}

/** The bucket holding a given quantile of a histogram (counts per MS_BUCKETS index). */
export function quantile(hist: number[], q: number): MsBucket | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = Math.ceil(total * q);
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i] ?? 0;
    if (seen >= target) return telemetry.MS_BUCKETS[i] as MsBucket;
  }
  return telemetry.MS_BUCKETS[telemetry.MS_BUCKETS.length - 1] as MsBucket;
}

/** Days since the rolled-up day: 1 is yesterday. */
export function lag(days: number): '1' | '2' | '3-7' | '8+' {
  if (days <= 1) return '1';
  if (days === 2) return '2';
  if (days <= 7) return '3-7';
  return '8+';
}

export function days28(n: number): '0' | '1-3' | '4-7' | '8-14' | '15-21' | '22-28' {
  if (n <= 0) return '0';
  if (n <= 3) return '1-3';
  if (n <= 7) return '4-7';
  if (n <= 14) return '8-14';
  if (n <= 21) return '15-21';
  return '22-28';
}

export function weeks(n: number): '0' | '1' | '2-3' | '4-8' | '9-26' | '27+' {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 3) return '2-3';
  if (n <= 8) return '4-8';
  if (n <= 26) return '9-26';
  return '27+';
}

export function ramBucket(bytes: number): 'lt8' | '8-15' | '16-31' | '32-63' | '64+' {
  const gb = bytes / 1024 ** 3;
  if (gb < 7.5) return 'lt8';
  if (gb < 15.5) return '8-15';
  if (gb < 31.5) return '16-31';
  if (gb < 63.5) return '32-63';
  return '64+';
}

export function coresBucket(n: number): '1-2' | '3-4' | '5-8' | '9-16' | '17+' {
  if (n <= 2) return '1-2';
  if (n <= 4) return '3-4';
  if (n <= 8) return '5-8';
  if (n <= 16) return '9-16';
  return '17+';
}
