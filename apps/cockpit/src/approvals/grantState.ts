/**
 * ------------------------------------------------------------------
 *  Title    |  A saved permission's state
 *  Ref      |  docs/permissions.md (Admin views)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Whether a saved permission still counts, and when it
 *           |  stops, in words, for Admin → Permissions: its Expired
 *           |  badge, its filter and its Expires column.
 *  Note     |  Core's gate never uses an expired one; it stays listed
 *           |  until you remove it or give it a new expiry.
 * ------------------------------------------------------------------
 */

import type { Grant } from '@nvx/contracts';

export type GrantFilter = 'all' | 'active' | 'expired';

export const isExpired = (g: Pick<Grant, 'expires_at'>, now = Date.now()): boolean =>
  g.expires_at !== null && Date.parse(g.expires_at) <= now;

/** "Never", "In 40 min", "In 3 h", "In 2 days", "Expired 5 h ago". */
export function expiryWords(g: Pick<Grant, 'expires_at'>, now = Date.now()): string {
  if (!g.expires_at) return 'Never';
  const ms = Date.parse(g.expires_at) - now;
  const span = Math.abs(ms);
  const words =
    span < 60_000
      ? 'a moment'
      : span < 3_600_000
        ? `${Math.round(span / 60_000)} min`
        : span < 86_400_000
          ? `${Math.round(span / 3_600_000)} h`
          : `${Math.round(span / 86_400_000)} ${Math.round(span / 86_400_000) === 1 ? 'day' : 'days'}`;
  if (ms > 0) return words === 'a moment' ? 'In a moment' : `In ${words}`;
  return words === 'a moment' ? 'Expired just now' : `Expired ${words} ago`;
}

export function filterGrants<T extends Pick<Grant, 'expires_at'>>(
  items: T[],
  filter: GrantFilter,
  now = Date.now(),
): T[] {
  if (filter === 'all') return items;
  return items.filter((g) => isExpired(g, now) === (filter === 'expired'));
}
