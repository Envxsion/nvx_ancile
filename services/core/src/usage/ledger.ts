/**
 * ------------------------------------------------------------------
 *  Title    |  Call ledger: every model call that is not a chat answer
 *  Ref      |  docs/api.md (Usage) · migration 0042
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Count the model calls that carry no message of their own
 *           |  (a fact-check, a memory pass, a title, a decision, a web
 *           |  lookup, a comparison) in Settings → Usage and in the
 *           |  spend caps, each with the purpose it was made for.
 *  How      |  The gateway records one row when a call finishes
 *           |  (gateway.ts), so no caller can forget to. A chat answer
 *           |  already counts through its message and is not recorded
 *           |  here (COUNTED_ON_MESSAGE), or it would count twice. The
 *           |  usage report reads these rows beside the messages.
 *  Note     |  A call that is stopped before the provider reports its
 *           |  usage leaves no row: the ledger never invents figures.
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';

/** The purposes Ancile names; anything else is recorded as given, and a call with none is "other". */
export const PURPOSES = [
  'chat',
  'factcheck',
  'memory',
  'decision',
  'permission',
  'title',
  'compare',
  'thread',
  'web',
  'knowledge',
  'other',
] as const;

/** Purposes whose cost already lives on a message: the ledger skips them so nothing counts twice. */
export const COUNTED_ON_MESSAGE: ReadonlySet<string> = new Set(['chat', 'flow']);

/** The purpose of a prompt file run as a utility call (`factcheck.verify-claim`, `threads.title`…). */
export function purposeOfPrompt(promptId: string): string {
  if (promptId === 'threads.title') return 'title';
  if (promptId === 'threads.compare') return 'compare';
  const head = promptId.split('.')[0] ?? '';
  if (head === 'threads') return 'thread';
  if (head === 'factcheck' || head === 'memory' || head === 'knowledge') return head;
  return 'other';
}

export interface CallRecord {
  purpose: string;
  /** 'claude_code' for Claude Code's models (their cost is an estimate), else 'gateway'. */
  engine: 'gateway' | 'claude_code';
  modelId: string | null;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  at: Date;
  traceId?: string | null;
  runId?: string | null;
}

export interface StoredCall extends CallRecord {
  workspaceId: string;
}

export interface CallLedger {
  record(call: CallRecord): Promise<void>;
}

export class PgCallLedger implements CallLedger {
  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
  ) {}

  async record(c: CallRecord): Promise<void> {
    await this.sql`
      insert into core.model_calls
        (workspace_id, at, purpose, engine, model_id, provider, input_tokens, cached_tokens, output_tokens, cost_usd, trace_id, run_id)
      values
        (${this.workspaceId}, ${c.at}, ${c.purpose}, ${c.engine}, ${c.modelId}, ${c.provider},
         ${c.inputTokens}, ${c.cachedTokens}, ${c.outputTokens}, ${c.costUsd}, ${c.traceId ?? null}, ${c.runId ?? null})`;
  }
}

/** In memory: tests, and the offline harness. */
export class MemoryCallLedger implements CallLedger {
  readonly calls: StoredCall[] = [];

  constructor(private readonly workspaceId = 'wsp_01TESTWORKSPACE000000000000') {}

  async record(c: CallRecord): Promise<void> {
    this.calls.push({ ...c, workspaceId: this.workspaceId });
  }
}
