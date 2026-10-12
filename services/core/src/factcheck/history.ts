/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check history: the score before a re-run
 *  Ref      |  ROADMAP.md track G ("keep the old fact-check score next
 *           |  to the new one") · DESIGN.md §10 · docs/factcheck.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  When an answer is checked again, show the earlier score
 *           |  beside the new one, and say plainly when the sources
 *           |  behind the earlier score have since been removed or
 *           |  changed, so a drop is explained rather than alarming.
 *  How      |  The earlier check's evidence names the passages it used.
 *           |  Each is checked through source integrity (tombstones
 *           |  plus the knowledge service). Counts are of sources, not
 *           |  passages: one removed PDF is "1 removed".
 * ------------------------------------------------------------------
 */

import type { Factcheck } from '@nvx/contracts';
import type { SourceIntegrity } from '../knowledge/integrity';
import { countVerdicts, summarise } from './pipeline';
import type { FactcheckRecord } from './store';

export async function previousView(
  prev: FactcheckRecord,
  integrity: SourceIntegrity | undefined,
): Promise<NonNullable<Factcheck['previous']>> {
  const seen = new Set<string>();
  const refs = prev.claims.flatMap((c) =>
    c.evidence.flatMap((e) => {
      if (e.kind === 'url' || !e.source_id || seen.has(e.ref)) return [];
      seen.add(e.ref);
      return [{ ref: e.ref, source_id: e.source_id, text_sha256: null }];
    }),
  );
  const checks = integrity && refs.length ? await integrity.check(refs) : [];
  const removed = new Set(checks.filter((c) => c.state === 'removed').map((c) => c.source_id));
  const changed = new Set(
    checks.filter((c) => c.state === 'changed' && !removed.has(c.source_id)).map((c) => c.source_id),
  );
  const parts = [
    removed.size ? `${removed.size} removed` : null,
    changed.size ? `${changed.size} changed` : null,
  ].filter(Boolean);
  return {
    id: prev.id,
    confidence: prev.confidence,
    summary: summarise({
      status: prev.status,
      confidence: prev.confidence,
      counts: countVerdicts(prev.claims),
    }),
    finished_at: prev.finished_at,
    sources_changed: parts.length > 0,
    removed: removed.size,
    changed: changed.size,
    note: parts.length ? `Sources changed since: ${parts.join(', ')}.` : null,
  };
}
