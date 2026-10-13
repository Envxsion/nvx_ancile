/**
 * ------------------------------------------------------------------
 *  Title    |  OpenRouter routes
 *  Ref      |  docs/openrouter.md · docs/api.md (OpenRouter)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The endpoint explorer, routing choices, the cost
 *           |  calculator and the model-choosing assistant.
 *  How      |  GET /openrouter/endpoints?model= · GET/PUT
 *           |  /openrouter/routing (?scope=&id= to read) · POST
 *           |  /openrouter/routing/preview[?model_id=] · POST
 *           |  /cost/estimate[?model_id=] · POST /advisor.
 *  Note     |  TODO(phase-5b): connect `explain` to a running local
 *           |  model in main.ts; until then explanation is null.
 * ------------------------------------------------------------------
 */

import {
  AdvisorRequest,
  type AdvisorResult,
  CostEstimateRequest,
  RoutingOverride,
  RoutingPreviewRequest,
  RoutingScope,
} from '@nvx/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { badRequest } from '../obs/errors';
import { advise, type Candidate } from './advisor';
import type { OpenRouterService } from './service';

export function openRouterRoutes(deps: {
  service: OpenRouterService;
  /** Models to choose among (registry, plus local ones not yet downloaded). */
  candidates: () => Promise<Candidate[]>;
  /** A short explanation from a local model; null when none is running. Never a paid call. */
  explain?: (prompt: string) => Promise<string | null>;
}) {
  const r = new Hono<AppEnv>();
  const { service } = deps;

  r.get('/openrouter/endpoints', async (c) => {
    const model = c.req.query('model');
    if (!model) throw badRequest('model: an OpenRouter model id such as qwen/qwen3-coder');
    return c.json(await service.endpoints.report(model));
  });

  r.get('/openrouter/routing', async (c) => {
    const scope = RoutingScope.safeParse(c.req.query('scope'));
    const id = c.req.query('id');
    if (!scope.success || !id) throw badRequest('scope (model, notebook or thread) and id');
    return c.json({ scope: scope.data, id, settings: await service.getOverride(scope.data, id) });
  });

  r.put('/openrouter/routing', async (c) => {
    const o = await body(c, RoutingOverride);
    await service.setOverride(o.scope, o.id, o.settings);
    return c.json(o);
  });

  r.post('/openrouter/routing/preview', async (c) => {
    const req = await body(c, RoutingPreviewRequest);
    return c.json(await service.preview(req, c.req.query('model_id') || undefined));
  });

  r.post('/cost/estimate', async (c) => {
    const req = await body(c, CostEstimateRequest);
    return c.json(await service.estimate(req, c.req.query('model_id') || undefined));
  });

  r.post('/advisor', async (c) => {
    const req = await body(c, AdvisorRequest);
    const result = advise(req, await deps.candidates(), await service.usage());
    let explanation: string | null = null;
    if (req.explain && deps.explain && result.options.length) {
      const list = result.options.map((o) => `${o.name}: ${o.reasons.join(' ')}`).join('\n');
      explanation = await deps
        .explain(
          `In two plain sentences, in British English, say which of these suits the job "${req.describe || result.kind}" and why.\n${list}`,
        )
        .catch(() => null);
    }
    const out: AdvisorResult = { ...result, explanation };
    return c.json(out);
  });

  return r;
}
