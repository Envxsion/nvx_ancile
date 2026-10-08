/**
 * Prefixed, time-sortable identifiers. The prefix says what a thing is in
 * logs and URLs; the ULID body sorts by creation time.
 */
import { z } from 'zod';

export const ID_PREFIX = {
  user: 'usr',
  workspace: 'wsp',
  notebook: 'nbk',
  note: 'not',
  thread: 'thr',
  message: 'msg',
  branch: 'brn',
  summary: 'sum',
  run: 'run',
  step: 'stp',
  grant: 'gnt',
  approval: 'apr',
  decision: 'dec',
  memoryProposal: 'mpr',
  source: 'src',
  chunk: 'chk',
  insight: 'ins',
  factcheck: 'fck',
  claim: 'clm',
  notification: 'ntf',
  node: 'nod',
  operation: 'opn',
  rule: 'rul',
  mcpServer: 'mcp',
  secret: 'sec',
  diagnostic: 'dia',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';

export function idSchema<K extends IdKind>(kind: K) {
  return z.string().regex(new RegExp(`^${ID_PREFIX[kind]}_${ULID}$`), `expected a ${kind} id`);
}

export const Ids = {
  thread: idSchema('thread'),
  message: idSchema('message'),
  run: idSchema('run'),
  notebook: idSchema('notebook'),
  source: idSchema('source'),
  approval: idSchema('approval'),
  grant: idSchema('grant'),
  node: idSchema('node'),
  operation: idSchema('operation'),
};

/** W3C trace id: 32 lowercase hex. */
export const TraceId = z.string().regex(/^[0-9a-f]{32}$/);
