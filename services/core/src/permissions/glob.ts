/**
 * ------------------------------------------------------------------
 *  Title    |  Grant patterns
 *  Ref      |  DESIGN.md §5.4 · docs/permissions.md#patterns
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  `*` is one segment, `**` is any depth (including none).
 *           |  Actions use "." as the separator, resources use "/".
 *           |  Shell wildcards never cross ; & | ` $ < >, and web:
 *           |  patterns are site rules covering searches and fetches.
 *  How      |  The matcher lives in @nvx/contracts (grant-patterns.ts)
 *           |  so the cockpit's live "does it match?" check and Core's
 *           |  decision are the same code.
 * ------------------------------------------------------------------
 */

export {
  compileGlob,
  grantActionFor,
  isWebPattern,
  matchAction,
  matchGlob,
  matchResource,
  matchWeb,
  specificity,
  webPatternNarrows,
} from '@nvx/contracts';
