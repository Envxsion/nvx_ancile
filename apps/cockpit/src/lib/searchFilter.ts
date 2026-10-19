/**
 * ------------------------------------------------------------------
 *  Title    |  Message search filters
 *  Ref      |  roadmap TS1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The shape of the filters in Ctrl+K and how they become
 *           |  query parameters for GET /threads/search.
 *  How      |  Plain data, so the palette can use it without loading
 *           |  the filter controls (palette/SearchFilters.tsx).
 * ------------------------------------------------------------------
 */

export interface SearchFilter {
  who?: 'mine' | 'answers';
  notebook?: string;
  model?: string;
  from?: string;
  to?: string;
}

/** The filters as query parameters, each one only when set. */
export function filterQuery(f: SearchFilter): string {
  return (Object.entries(f) as [string, string | undefined][])
    .filter(([, v]) => !!v)
    .map(([k, v]) => `&${k}=${encodeURIComponent(v as string)}`)
    .join('');
}
