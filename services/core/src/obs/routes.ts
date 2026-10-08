/**
 * ------------------------------------------------------------------
 *  Title    |  Traces and replay
 *  Ref      |  DESIGN.md §11.1, §11.2 · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Open any trace as a waterfall with its log lines; step
 *           |  through a run; re-run an answer from a chosen step with
 *           |  another model, as a new reply beside the original.
 *  How      |  Spans and logs come from the obs store, a run's steps
 *           |  from its event log. A re-run goes through startTurn like
 *           |  a regenerate, carrying the original's tool record (so
 *           |  nothing runs twice) and the parts it keeps.
 * ------------------------------------------------------------------
 */

import { AncileError, RerunRequest, type RunEvent, type TraceDetail } from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import type { RunStore } from '../runs/engine';
import type { RunEventLog } from '../runs/events';
import { assertChatModel, startTurn, type TurnDeps } from '../threads/service';
import { notFound } from './errors';
import { prefixFor, recordedCalls, replayOf, stepsFrom } from './replay';
import type { ObsStore } from './store';

export function traceRoutes(deps: {
  store: ObsStore;
  runs: RunStore;
  runEvents: RunEventLog;
  turn: TurnDeps;
}) {
  const r = new Hono<AppEnv>();

  r.get('/traces', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const before = c.req.query('before');
    const q = c.req.query('q');
    const items = await deps.store.traces({
      limit,
      ...(before && { before }),
      ...(q && { q }),
      errorsOnly: c.req.query('errors') === '1',
    });
    const last = items.at(-1);
    return c.json({ items, next_cursor: items.length === limit && last ? last.start_at : null });
  });

  r.get('/traces/:id', async (c) => {
    const id = c.req.param('id');
    const { spans, logs } = await deps.store.trace(id);
    if (!spans.length && !logs.length) throw notFound('That trace');
    const runIds = [
      ...new Set(
        [...spans.map((s) => s.attrs.run_id), ...logs.map((l) => l.data.run_id)].filter(
          (v): v is string => typeof v === 'string',
        ),
      ),
    ];
    const runs = (await Promise.all(runIds.map((rid) => deps.runs.get(rid)))).flatMap((run) =>
      run ? [{ id: run.id, kind: run.kind, status: run.status }] : [],
    );
    const out: TraceDetail = { trace_id: id, spans, logs, runs };
    return c.json(out);
  });

  const replayFor = async (runId: string) => {
    const run = await deps.runs.get(runId);
    if (!run) throw notFound('That run');
    const events = (await deps.runEvents.since(run.id, 0)) as RunEvent[];
    const message = run.messageId ? await deps.turn.repo.getMessage(run.messageId) : undefined;
    return { run, events, message };
  };

  r.get('/runs/:id/replay', async (c) => {
    const { run, events, message } = await replayFor(c.req.param('id'));
    return c.json(replayOf({ run, events, modelId: message?.model_id ?? null }));
  });

  r.get('/traces/:id/replay', async (c) => {
    const { spans } = await deps.store.trace(c.req.param('id'));
    const runId = spans.map((s) => s.attrs.run_id).find((v): v is string => typeof v === 'string');
    if (!runId) throw notFound('A run in that trace');
    const { run, events, message } = await replayFor(runId);
    return c.json(replayOf({ run, events, modelId: message?.model_id ?? null }));
  });

  r.post('/runs/:id/rerun', async (c) => {
    const req = await body(c, RerunRequest);
    const { run, events, message } = await replayFor(c.req.param('id'));
    if (run.kind !== 'chat_turn' || !message || !message.parent_id)
      throw new AncileError({
        code: 'replay.not_rerunnable',
        title: 'Only an answer in a thread can be re-run',
        hint: 'Open a chat answer’s run and choose Re-run from there.',
        status: 422,
        errorClass: 'permanent',
      });
    if (!['succeeded', 'failed', 'cancelled'].includes(run.status))
      throw new AncileError({
        code: 'replay.run_active',
        title: 'That run has not finished yet',
        hint: 'Wait for it to finish, or stop it, then re-run it.',
        status: 409,
        errorClass: 'permanent',
      });
    const steps = stepsFrom(events);
    if (req.from_step > steps.length)
      throw new AncileError({
        code: 'replay.bad_step',
        title: `There is no step ${req.from_step + 1} in that run`,
        hint: 'Pick a step from the replay.',
        status: 422,
        errorClass: 'permanent',
      });
    const thread = await deps.turn.repo.getThread(message.thread_id);
    if (!thread) throw notFound('That thread');
    if (req.model) assertChatModel(deps.turn.registry, req.model);
    const started = await startTurn(deps.turn, {
      thread,
      user: { existingId: message.parent_id },
      ...(req.model && { model: req.model }),
      replay: { fromRunId: run.id, fromStep: req.from_step, calls: recordedCalls(message.parts) },
      seedParts: prefixFor(message.parts, steps, req.from_step),
    });
    return c.json(started, 202);
  });

  return r;
}
