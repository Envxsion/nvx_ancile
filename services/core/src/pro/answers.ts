/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: answers
 *  Ref      |  DESIGN.md §9 · services/core/src/pro/types.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Lend Pro's answer features (Beam, Insights, the Flow
 *           |  lab) Core's threads, turns, models and flows, through
 *           |  the same paths every answer takes.
 *  How      |  A thin adapter: no feature logic lives here. Turns go
 *           |  through startTurn, model calls through the Gateway
 *           |  (fallbacks, breakers, cost), flows through runFlowOnce.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { ulid } from 'ulid';
import type { FlowStore } from '../flows/store';
import { runFlowOnce } from '../flows/try';
import type { FlowsService } from '../flows/turn';
import type { Gateway } from '../gateway/gateway';
import { canChat, type ModelRegistry } from '../gateway/registry';
import type { MemoryService } from '../memory/service';
import type { NotebookRepo } from '../notebooks/repo';
import type { RunStore } from '../runs/engine';
import { TERMINAL } from '../runs/machine';
import type { RunWorker } from '../runs/worker';
import type { BranchStore } from '../threads/branches';
import { type MessageRecord, type ThreadRepo, textOf } from '../threads/repo';
import { startTurn } from '../threads/service';
import type { ProAnswers, ProMessage } from './types';

const view = (m: MessageRecord): ProMessage => ({
  id: m.id,
  thread_id: m.thread_id,
  parent_id: m.parent_id,
  role: m.role,
  text: textOf(m.parts),
  status: m.status,
  model_id: m.model_id,
  edit_of_id: m.edit_of_id ?? null,
  usage: m.usage
    ? {
        input_tokens: Number(m.usage.input_tokens ?? 0),
        output_tokens: Number(m.usage.output_tokens ?? 0),
        cost_usd: Number(m.usage.cost_usd ?? 0),
      }
    : null,
  provenance: (m.provenance ?? {}) as Record<string, unknown>,
  created_at: typeof m.created_at === 'string' ? m.created_at : new Date(m.created_at).toISOString(),
});

export function proAnswers(deps: {
  workspaceId: string;
  repo: ThreadRepo;
  runs: RunStore;
  worker: Pick<RunWorker, 'kick'>;
  registry: ModelRegistry;
  gateway: Gateway;
  branches?: BranchStore;
  flows: FlowsService;
  flowStore: FlowStore;
  notebooks: Pick<NotebookRepo, 'list'>;
  memory?: Pick<MemoryService, 'log'>;
  pollMs?: number;
}): ProAnswers {
  const { repo, registry } = deps;
  const turnDeps = {
    repo,
    runs: deps.runs,
    worker: deps.worker,
    registry,
    ...(deps.branches && { branches: deps.branches }),
  };
  const ownThread = async (id: string) => {
    const t = await repo.getThread(id);
    return t && t.workspace_id === deps.workspaceId ? t : undefined;
  };

  return {
    threads: {
      async get(id) {
        const t = await ownThread(id);
        return t
          ? { id: t.id, title: t.title, notebook_id: t.notebook_id, active_head_id: t.active_head_id }
          : null;
      },
      async create(opts) {
        const t = await repo.createThread({
          id: `thr_${ulid()}`,
          workspace_id: deps.workspaceId,
          ...(opts.title && { title: opts.title }),
          notebook_id: opts.notebookId,
        });
        return { id: t.id };
      },
      async message(id) {
        const m = await repo.getMessage(id);
        if (!m || m.deleted_at || !(await ownThread(m.thread_id))) return null;
        return view(m);
      },
      async path(messageId) {
        const m = await repo.getMessage(messageId);
        if (!m || !(await ownThread(m.thread_id))) return [];
        const byId = new Map((await repo.messages(m.thread_id)).map((x) => [x.id, x]));
        const out: ProMessage[] = [];
        for (
          let cur: MessageRecord | undefined = m;
          cur;
          cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
        )
          out.unshift(view(cur));
        return out;
      },
      async busy(threadId) {
        return (await deps.runs.activeForThread(threadId)).length > 0;
      },
      async setHead(threadId, messageId) {
        await repo.patchThread(threadId, { active_head_id: messageId });
      },
    },
    turns: {
      async start(req) {
        const thread = await ownThread(req.threadId);
        if (!thread) throw new Error(`no thread ${req.threadId}`);
        return startTurn(turnDeps, {
          thread,
          user:
            'existingId' in req.user
              ? { existingId: req.user.existingId }
              : { parentId: req.user.parentId, parts: [{ type: 'text', text: req.user.text }] },
          ...(req.model !== undefined && { model: req.model }),
          ...(req.flowId && { flowId: req.flowId }),
          ...(req.detached && { detached: true }),
          ...(req.instructions && { instructions: req.instructions }),
          ...(req.provenanceExtra && { provenanceExtra: req.provenanceExtra }),
        });
      },
      async wait(runId, signal) {
        for (;;) {
          const r = await deps.runs.get(runId);
          if (!r) return { status: 'missing' };
          if (TERMINAL.has(r.status)) return { status: r.status };
          if (signal?.aborted) return { status: r.status };
          await new Promise((res) => setTimeout(res, deps.pollMs ?? 250));
        }
      },
    },
    models: {
      list() {
        return registry
          .all()
          .filter(canChat)
          .map((m) => {
            const status = registry.status(m);
            return {
              id: m.id,
              name: m.display_name,
              provider: m.provider,
              ready: status === 'ready',
              problem: status === 'ready' ? null : status === 'needs_key' ? 'needs its key' : 'switched off',
              price: { input_per_mtok: m.price.input_per_mtok, output_per_mtok: m.price.output_per_mtok },
            };
          });
      },
      defaultChat() {
        try {
          return registry.chain('chat.default', null)[0]?.id ?? null;
        } catch {
          return null;
        }
      },
      async complete(model, req, signal) {
        const chain = registry.chain('chat.default', model);
        if (!chain.length) throw new Error('No model can answer: add a key in Settings → Models.');
        const started = Date.now();
        let text = '';
        let used: ModelConfig | undefined = chain[0];
        let input = 0;
        let output = 0;
        for await (const ev of deps.gateway.stream(
          chain,
          {
            ...(req.system && { system: req.system }),
            messages: [{ role: 'user', content: req.prompt }],
            ...(req.maxOutputTokens && { maxOutputTokens: req.maxOutputTokens }),
            ...(req.temperature !== undefined && { temperature: req.temperature }),
          },
          signal ?? AbortSignal.timeout(120_000),
        )) {
          if (ev.type === 'model') used = registry.get(ev.modelId) ?? used;
          else if (ev.type === 'chunk' && ev.chunk.type === 'text') text += ev.chunk.delta;
          else if (ev.type === 'chunk' && ev.chunk.type === 'finish') {
            input += ev.chunk.usage.inputTokens;
            output += ev.chunk.usage.outputTokens;
          }
        }
        const price = used?.price ?? { input_per_mtok: 0, output_per_mtok: 0 };
        return {
          text,
          model_id: used?.id ?? model ?? '',
          input_tokens: input,
          output_tokens: output,
          cost_usd: (input * price.input_per_mtok + output * price.output_per_mtok) / 1_000_000,
          ms: Date.now() - started,
        };
      },
    },
    flows: {
      async get(id, version) {
        const f =
          version !== undefined && version !== null
            ? await deps.flowStore.getVersion(id, version)
            : await deps.flowStore.getLive(id);
        return f ?? null;
      },
      async list() {
        return (await deps.flowStore.list({})).map((f) => ({
          id: f.id,
          name: f.name,
          active: f.active,
          scope: f.scope,
          scope_ref: f.scope_ref,
        }));
      },
      async activeFor(notebookId) {
        const f =
          (notebookId ? await deps.flowStore.activeFor('notebook', notebookId) : undefined) ??
          (await deps.flowStore.activeFor('workspace', null));
        return f ? { id: f.id, name: f.name } : null;
      },
      async runOnce(opts) {
        const flow =
          opts.version !== undefined && opts.version !== null
            ? await deps.flowStore.getVersion(opts.flowId, opts.version)
            : await deps.flowStore.getLive(opts.flowId);
        if (!flow) throw new Error(`no flow ${opts.flowId}`);
        return runFlowOnce(deps.flows, {
          flow,
          text: opts.text,
          workspaceId: deps.workspaceId,
          threadId: opts.threadId ?? null,
          headId: opts.headId ?? null,
          notebookId: opts.notebookId ?? null,
          ...(opts.mock && { mock: true }),
          signal: opts.signal,
        });
      },
      decisions: (flowId, nodeId) =>
        deps.flowStore.decisions({ flowId, ...(nodeId && { nodeId }), limit: 2_000 }),
    },
    notebooks: {
      async list() {
        return (await deps.notebooks.list(deps.workspaceId)).map((n) => ({ id: n.id, title: n.title }));
      },
    },
    factcheck: (answer, opts) =>
      deps.flows.factcheck(answer, {
        question: opts.question,
        workspaceId: deps.workspaceId,
        notebookId: opts.notebookId,
        signal: opts.signal,
      }),
    async memoryHistory(limit) {
      if (!deps.memory) return [];
      return (await deps.memory.log(limit)).map((c) => ({ at: c.at }));
    },
  };
}
