/**
 * ------------------------------------------------------------------
 *  Title    |  "Why did the AI say this?"
 *  Ref      |  DESIGN.md §11.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Everything behind one answer in one document: the model
 *           |  that answered and what was tried before it, the memory
 *           |  it was given, the passages retrieved and which it cited,
 *           |  each tool call and the decision that let it run (or
 *           |  not), compaction, tokens and cost, the latest fact-check,
 *           |  and where the full trace is.
 *  How      |  Pure assembly over what is already recorded: the
 *           |  message's provenance (written by the conductor, the
 *           |  memory module and compaction), its parts, the run's
 *           |  permission decisions and the fact-check store. Missing
 *           |  pieces are null, never invented.
 * ------------------------------------------------------------------
 */

import {
  type Decision,
  type Explain,
  ExplainCompaction,
  ExplainMemory,
  type ExplainTool,
  type Factcheck,
  FlowProvenance,
  type Part,
  RetrievalTrace,
} from '@nvx/contracts';
import type { MessageRecord } from '../threads/repo';

type Call = Extract<Part, { type: 'tool_call' }>;
type Result = Extract<Part, { type: 'tool_result' }>;

const preview = (v: unknown, max = 400) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * Pair each tool call with the decision that settled it. Decisions carry the
 * action, not the call, so they are taken in order among those with the
 * call's action (calls are settled one at a time, in order).
 */
export function pairTools(
  parts: Part[],
  decisions: Decision[],
  actionOf: (tool: string) => string | undefined,
): ExplainTool[] {
  const results = new Map(parts.flatMap((p) => (p.type === 'tool_result' ? [[p.call_id, p] as const] : [])));
  const left = [...decisions];
  return parts
    .filter((p): p is Call => p.type === 'tool_call')
    .map((call) => {
      const r: Result | undefined = results.get(call.call_id);
      const action = actionOf(call.tool);
      // One decision per settled call: the gate's, or the person's answer to an approval.
      let decision: Decision | undefined;
      const i = left.findIndex((d) => (action ? d.action === action : true));
      if (i >= 0) {
        decision = left[i];
        left.splice(i, 1);
      }
      return {
        call_id: call.call_id,
        tool: call.tool,
        args: call.args,
        ok: r ? r.ok && r.declined_reason === undefined : null,
        result: r ? preview(r.result) : null,
        declined_reason: r?.declined_reason ?? null,
        decision: decision
          ? {
              outcome: decision.outcome,
              tier: decision.tier,
              action: decision.action,
              resource: decision.resource,
              at: decision.at,
            }
          : null,
      };
    });
}

export function assembleExplain(input: {
  message: MessageRecord;
  decisions: Decision[];
  factcheck: Factcheck | null;
  actionOf: (tool: string) => string | undefined;
  modelName: (id: string | null) => string | null;
}): Explain {
  const m = input.message;
  const p = (m.provenance ?? {}) as Record<string, unknown>;
  const retrieval = RetrievalTrace.safeParse(p.retrieval);
  const memory = ExplainMemory.safeParse(p.memory);
  const compaction = ExplainCompaction.safeParse(p.compaction);
  const flow = FlowProvenance.safeParse(p.flow);
  const attempts = Array.isArray(p.attempts)
    ? (p.attempts as { model?: unknown; reason?: unknown; detail?: unknown }[]).map((a) => ({
        model: String(a.model ?? ''),
        reason: String(a.reason ?? ''),
        detail: String(a.detail ?? ''),
      }))
    : [];
  const re = p.retrieval_error as { code?: unknown; title?: unknown } | undefined;
  const err = p.error as { code?: unknown; title?: unknown; hint?: unknown } | undefined;
  return {
    message_id: m.id,
    thread_id: m.thread_id,
    status: m.status,
    trace_id: m.trace_id,
    run_id: m.run_id,
    model: {
      id: m.model_id,
      name: (typeof p.model_name === 'string' ? p.model_name : null) ?? input.modelName(m.model_id),
      requested: m.requested_model_id,
      chain: Array.isArray(p.chain) ? p.chain.map(String) : [],
    },
    attempts,
    memory: memory.success ? memory.data : null,
    retrieval: retrieval.success ? retrieval.data : null,
    retrieval_error: re?.code ? { code: String(re.code), title: String(re.title ?? '') } : null,
    tools: pairTools(m.parts, input.decisions, input.actionOf),
    compaction: compaction.success ? compaction.data : null,
    usage: m.usage,
    factcheck: input.factcheck,
    error: err?.code
      ? { code: String(err.code), title: String(err.title ?? ''), hint: String(err.hint ?? '') }
      : null,
    flow: flow.success ? flow.data : null,
    trace_url: `/admin/traces?trace=${encodeURIComponent(m.trace_id)}`,
  };
}
