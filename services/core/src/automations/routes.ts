/**
 * ------------------------------------------------------------------
 *  Title    |  Automation routes
 *  Ref      |  ROADMAP Phase 5 · packages/contracts/src/ops.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  List the automations; make, edit and delete your own;
 *           |  change a built-in job's schedule and settings, or reset
 *           |  it to automations.yaml; switch one on or off; run one
 *           |  now.
 *  How      |  The contract schemas check the shape; this file checks
 *           |  the rest (the schedule reads and is not too frequent,
 *           |  the notebook, flow and model exist, a built-in's
 *           |  settings are its own options) before the runner applies
 *           |  it. Changes are kept in core.automations, never in the
 *           |  YAML file, which is read-only on the desktop.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type AutomationOption,
  type AutomationView,
  CreateAutomationRequest,
  UpdateAutomationRequest,
  UserAutomationConfig,
  type UserAutomationKind,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { canChat, type ModelRegistry } from '../gateway/registry';
import { body } from '../http/body';
import { badRequest, notFound } from '../obs/errors';
import { MIN_INTERVAL_MINUTES, scheduleProblem } from './cron';
import type { AutomationRunner } from './runner';

export interface AutomationRouteDeps {
  runner: AutomationRunner;
  /** Checks for what your own automations point at; each is skipped when absent. */
  notebookExists?: (id: string) => Promise<boolean>;
  flowExists?: (id: string) => Promise<boolean>;
  registry?: Pick<ModelRegistry, 'get'>;
}

export function badSchedule(cron: string, problem: string): AncileError {
  const tooOften = problem.includes('more often');
  return new AncileError({
    code: tooOften ? 'automation.too_often' : 'automation.bad_schedule',
    title: tooOften
      ? `That schedule runs more often than every ${MIN_INTERVAL_MINUTES} minutes`
      : "That schedule can't be used",
    hint: tooOften
      ? `Pick a schedule with at least ${MIN_INTERVAL_MINUTES} minutes between runs.`
      : 'A schedule has five fields: minute, hour, day of month, month and weekday, for example "0 9 * * 1-5".',
    status: 422,
    errorClass: 'permanent',
    context: { cron, problem },
  });
}

function eventDriven(view: AutomationView): AncileError {
  return new AncileError({
    code: 'automation.event_driven',
    title: `${view.title} runs as part of another feature`,
    hint: 'It has no schedule to change or switch off here.',
    status: 422,
    errorClass: 'permanent',
  });
}

function notSetUp(view: AutomationView): AncileError {
  return new AncileError({
    code: 'automation.not_set_up',
    title: `${view.title} is not set up`,
    hint: view.setup?.hint ?? 'It needs setting up before it can run.',
    status: 422,
    errorClass: 'permanent',
  });
}

const hasNul = (v: unknown): boolean =>
  typeof v === 'string'
    ? v.includes('\u0000')
    : v !== null && typeof v === 'object' && Object.values(v as object).some(hasNul);

/** A built-in job's settings: only its own options, each the right type and in range. */
export function checkOptions(options: AutomationOption[], patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    const o = options.find((x) => x.key === key);
    if (!o) throw badRequest(`config.${key}: this automation has no setting called ${key}`);
    if (o.type === 'boolean') {
      if (typeof value !== 'boolean') throw badRequest(`config.${key}: expected true or false`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value))
      throw badRequest(`config.${key}: expected a whole number`);
    if ((o.min !== null && value < o.min) || (o.max !== null && value > o.max))
      throw badRequest(`config.${key}: expected ${o.min ?? '…'} to ${o.max ?? '…'}`);
  }
}

export function automationRoutes(deps: AutomationRouteDeps) {
  const r = new Hono<AppEnv>();
  const { runner } = deps;

  const checkCron = (cron: string) => {
    const problem = scheduleProblem(cron);
    if (problem) throw badSchedule(cron, problem);
  };

  /** What your own automation points at must exist now (it is checked again when it runs). */
  const checkTargets = async (kind: UserAutomationKind, config: Record<string, unknown>) => {
    if (hasNul(config)) throw badRequest('config: contains a NUL character');
    const nb = typeof config.notebook_id === 'string' ? config.notebook_id : null;
    if (nb && deps.notebookExists && !(await deps.notebookExists(nb))) throw notFound('That notebook');
    if (kind === 'run_flow' && deps.flowExists && !(await deps.flowExists(String(config.flow_id))))
      throw notFound('That flow');
    const model = typeof config.model === 'string' ? config.model : null;
    if (model && deps.registry) {
      const m = deps.registry.get(model);
      if (!m) throw notFound(`The model ${model}`);
      if (!canChat(m))
        throw new AncileError({
          code: 'model.not_chat',
          title: `${m.display_name} can't answer messages`,
          hint: 'It is an embedding or rerank model. Pick a chat model.',
          status: 422,
          errorClass: 'permanent',
        });
    }
  };

  const viewOr404 = async (id: string) => {
    const v = await runner.view(id);
    if (!v) throw notFound('That automation');
    return v;
  };

  r.get('/automations', async (c) => c.json({ items: await runner.views(), next_cursor: null }));

  r.post('/automations', async (c) => {
    const req = await body(c, CreateAutomationRequest);
    checkCron(req.cron);
    await checkTargets(req.kind, req.config as Record<string, unknown>);
    const v = await runner.create({
      kind: req.kind,
      title: req.title,
      cron: req.cron,
      config: req.config,
      enabled: req.enabled,
    });
    return c.json(v, 201);
  });

  r.patch('/automations/:id', async (c) => {
    const req = await body(c, UpdateAutomationRequest);
    const view = await viewOr404(c.req.param('id'));
    if (view.trigger === 'event') throw eventDriven(view);
    if (req.cron !== undefined) checkCron(req.cron);
    let config: Record<string, unknown> | undefined;
    if (view.origin === 'user') {
      if (req.config !== undefined) {
        const kind = view.kind as UserAutomationKind;
        const parsed = UserAutomationConfig[kind].safeParse(req.config);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          throw badRequest(
            first ? `config.${first.path.join('.')}: ${first.message}` : 'config does not match',
          );
        }
        config = parsed.data as Record<string, unknown>;
        await checkTargets(kind, config);
      }
    } else {
      if (req.title !== undefined) throw badRequest('title: a built-in automation keeps its name');
      if (req.config !== undefined) {
        checkOptions(view.options, req.config);
        config = { ...view.config, ...req.config };
      }
    }
    await runner.edit(view.id, {
      ...(req.enabled !== undefined && { enabled: req.enabled }),
      ...(req.cron !== undefined && { cron: req.cron }),
      ...(req.title !== undefined && { title: req.title }),
      ...(config && { config }),
    });
    return c.json(await viewOr404(view.id));
  });

  r.post('/automations/:id/reset', async (c) => {
    const view = await viewOr404(c.req.param('id'));
    if (view.origin !== 'builtin')
      throw new AncileError({
        code: 'automation.no_default',
        title: 'Only built-in automations have a default',
        hint: 'Edit this one instead, or delete it.',
        status: 422,
        errorClass: 'permanent',
      });
    if (view.trigger === 'event') throw eventDriven(view);
    await runner.reset(view.id);
    return c.json(await viewOr404(view.id));
  });

  r.delete('/automations/:id', async (c) => {
    const view = await viewOr404(c.req.param('id'));
    if (view.origin !== 'user')
      throw new AncileError({
        code: 'automation.builtin',
        title: `${view.title} is built in and can't be deleted`,
        hint: 'Switch it off instead, or reset it to default.',
        status: 422,
        errorClass: 'permanent',
      });
    await runner.remove(view.id);
    return c.body(null, 204);
  });

  r.post('/automations/:id/run', async (c) => {
    const id = c.req.param('id');
    const status = await runner.runNow(id);
    if (status === 'unknown') throw notFound('That automation');
    if (status === 'not_set_up') throw notSetUp(await viewOr404(id));
    if (status === 'busy')
      throw new AncileError({
        code: 'automation.busy',
        title: 'It is running already',
        hint: 'Wait for it to finish.',
        status: 409,
        errorClass: 'permanent',
      });
    return c.json(await viewOr404(id));
  });

  return r;
}
