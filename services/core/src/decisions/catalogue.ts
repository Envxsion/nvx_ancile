/**
 * ------------------------------------------------------------------
 *  Title    |  Decision models: the routes, prices and allowances
 *  Ref      |  docs/decisions.md (Providers) · DESIGN.md D30
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  One table of every way Core can reach a decision model:
 *           |  endpoint, auth, model names, list price, the free
 *           |  allowance it draws on, and the page each fact came from.
 *  How      |  Plain data. The adapters (adapters.ts) read it to build
 *           |  a call; the router (router.ts) reads it to order
 *           |  routes. Prices are USD per million input tokens; output
 *           |  is free on every one of these models.
 *  Note     |  Every source was read on 2026-10-20. `verified: false`
 *           |  means the provider's own pages did not document it yet
 *           |  (the OpenAI Decisions API is a preview that answers 403
 *           |  "not enabled for this user" to most keys). No route here
 *           |  claims provider-side prompt caching: none offers it.
 * ------------------------------------------------------------------
 */

import type { DecisionProviderId, DecisionRouteId, DecisionTaskId } from '@nvx/contracts';
import type { AllowanceDef } from '../free/allowances';

export type RouteShape = 'jev' | 'cloudflare';

export interface RouteDef {
  id: DecisionRouteId;
  provider: DecisionProviderId;
  label: string;
  /** Tried in order: the next is used when the service does not know a model (400, 404, 422). */
  models: string[];
  tier: 'fast' | 'reasoning';
  local: boolean;
  shape: RouteShape;
  /** Fixed endpoint; null for local (the person's URL) and Cloudflare (needs the account ID). */
  url: string | null;
  /** The secret that holds its key (null: none needed). */
  secret: string | null;
  /** USD per million input tokens; null when unlisted (the cost the service reports is used). */
  input_per_mtok: number | null;
  /** The free allowance it draws on, and the neurons a million input tokens cost against it. */
  allowance?: { id: string; per_mtok: number };
  /** Most input tokens one request may hold; a larger one skips the route. Absent: not known. */
  context?: number;
  verified: boolean;
  source: string;
}

/** Cloudflare Workers AI: 10,000 neurons a day free, reset 00:00 UTC. */
export const CLOUDFLARE_ALLOWANCE = 'cloudflare_neurons';

export const ALLOWANCES: AllowanceDef[] = [
  {
    id: CLOUDFLARE_ALLOWANCE,
    label: 'Cloudflare Workers AI',
    unit: 'neurons',
    limit: 10_000,
    // A 50-neuron margin so a rounding difference never tips us over the free line.
    defaultCeiling: 9_950,
    source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  },
];

const OR_SOURCE = 'https://openrouter.ai/docs/guides/community/jev';
const CF_PRICING = 'https://developers.cloudflare.com/workers-ai/platform/pricing/';
const PPLX = 'https://docs.perplexity.ai/docs/decisions/quickstart';

export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const PERPLEXITY_DECISIONS_URL = 'https://api.perplexity.ai/v1/decisions';
export const OPENAI_DECISIONS_URL = 'https://api.openai.com/v1/decisions';

/** The Jev model names: the latest alias, then the version before it. */
export const JEV_OPENROUTER_MODELS = ['~typesafe/jev-latest', 'typesafe/jev-1.13'];
export const JEV_DIRECT_MODELS = ['jev-latest'];

export const SECRETS = {
  openrouter: 'OPENROUTER_API_KEY',
  typesafe: 'typesafe.api_key',
  cloudflareToken: 'CLOUDFLARE_API_TOKEN',
  cloudflareAccount: 'CLOUDFLARE_ACCOUNT_ID',
  perplexity: 'PERPLEXITY_API_KEY',
  openai: 'OPENAI_API_KEY',
  /** An optional key for a decision server on this computer or node. */
  local: 'decisions.local_key',
} as const;

export const ROUTES: RouteDef[] = [
  {
    id: 'local_jev',
    provider: 'local',
    label: 'Decision server on this computer or your GPU node',
    // Clef-flash served with vLLM or SGLang (Apache 2.0 weights), or laya-serve (Laya, CPU): both answer POST /v1/systemone.
    models: ['Cloudflare/clef-flash'],
    tier: 'fast',
    local: true,
    shape: 'jev',
    url: null,
    secret: SECRETS.local,
    input_per_mtok: 0,
    verified: true,
    source: 'https://huggingface.co/Cloudflare/clef-flash',
  },
  {
    id: 'cf_clef_flash',
    provider: 'cloudflare',
    label: 'Clef-flash on Cloudflare',
    models: ['clef-flash'],
    tier: 'fast',
    local: false,
    shape: 'cloudflare',
    url: null,
    secret: SECRETS.cloudflareToken,
    input_per_mtok: 0.038,
    allowance: { id: CLOUDFLARE_ALLOWANCE, per_mtok: 3_455 },
    context: 24_576,
    verified: true,
    source: 'https://developers.cloudflare.com/workers-ai/models/clef-flash/',
  },
  {
    id: 'cf_clef',
    provider: 'cloudflare',
    label: 'Clef on Cloudflare',
    models: ['clef'],
    tier: 'reasoning',
    local: false,
    shape: 'cloudflare',
    url: null,
    secret: SECRETS.cloudflareToken,
    input_per_mtok: 0.24,
    allowance: { id: CLOUDFLARE_ALLOWANCE, per_mtok: 21_818 },
    context: 65_536,
    verified: true,
    source: 'https://developers.cloudflare.com/workers-ai/models/clef/',
  },
  {
    id: 'jev_openrouter',
    provider: 'openrouter',
    label: 'Jev through OpenRouter',
    models: JEV_OPENROUTER_MODELS,
    tier: 'reasoning',
    local: false,
    shape: 'jev',
    url: OPENROUTER_DECISIONS_URL,
    secret: SECRETS.openrouter,
    input_per_mtok: 0.042,
    verified: true,
    source: OR_SOURCE,
  },
  {
    id: 'jev_direct',
    provider: 'typesafe',
    label: 'Jev through TypeSafe',
    models: JEV_DIRECT_MODELS,
    tier: 'reasoning',
    local: false,
    shape: 'jev',
    url: TYPESAFE_SYSTEMONE_URL,
    secret: SECRETS.typesafe,
    input_per_mtok: 0.042,
    verified: true,
    source: 'https://docs.typesafe.ai/api',
  },
  {
    id: 'pplx_flash',
    provider: 'perplexity',
    label: 'Perplexity decider flash',
    models: ['pplx-decider-flash-latest'],
    tier: 'fast',
    local: false,
    shape: 'jev',
    url: PERPLEXITY_DECISIONS_URL,
    secret: SECRETS.perplexity,
    input_per_mtok: 0.01,
    verified: true,
    source: PPLX,
  },
  {
    id: 'pplx_decider',
    provider: 'perplexity',
    label: 'Perplexity decider',
    models: ['pplx-decider-latest'],
    tier: 'reasoning',
    local: false,
    shape: 'jev',
    url: PERPLEXITY_DECISIONS_URL,
    secret: SECRETS.perplexity,
    input_per_mtok: 0.02,
    verified: true,
    source: PPLX,
  },
  {
    id: 'or_pplx_flash',
    provider: 'openrouter',
    label: 'Perplexity decider flash through OpenRouter',
    models: ['perplexity/pplx-decider-flash-v1.2'],
    tier: 'fast',
    local: false,
    shape: 'jev',
    url: OPENROUTER_DECISIONS_URL,
    secret: SECRETS.openrouter,
    // OpenRouter may add its own margin; the cost it reports on each answer is what is counted.
    input_per_mtok: 0.01,
    verified: true,
    source: OR_SOURCE,
  },
  {
    id: 'or_clef_flash',
    provider: 'openrouter',
    label: 'Clef-flash through OpenRouter',
    models: ['cloudflare/clef-flash'],
    tier: 'fast',
    local: false,
    shape: 'jev',
    url: OPENROUTER_DECISIONS_URL,
    secret: SECRETS.openrouter,
    input_per_mtok: 0.038,
    verified: true,
    source: OR_SOURCE,
  },
  {
    id: 'openai_luna',
    provider: 'openai',
    label: 'OpenAI Decisions (GPT-6 Luna), preview',
    models: ['gpt-6-luna'],
    tier: 'fast',
    local: false,
    shape: 'jev',
    url: OPENAI_DECISIONS_URL,
    secret: SECRETS.openai,
    // Decisions pricing is not published; Luna's standard input rate is the only figure (no output charge is assumed).
    input_per_mtok: 0.1,
    // The request and answer shapes are not documented on OpenAI's own pages (they returned 404/403 on 2026-10-20).
    verified: false,
    source: 'https://thenewstack.io/openai-decision-api-luna/',
  },
];

export const routeDef = (id: DecisionRouteId): RouteDef => {
  const r = ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`unknown decision route ${id}`);
  return r;
};

/**
 * What each task needs. Fast sorting wants Clef-flash's ~40 ms; a decision that needs reasoning (a
 * security review) wants Jev or Clef. `timeoutMs` is how long it will wait before the caller's own
 * behaviour takes over.
 */
export const TASK_PROFILES: Record<DecisionTaskId, { tier: 'fast' | 'reasoning'; timeoutMs: number }> = {
  auto_review: { tier: 'reasoning', timeoutMs: 4_000 },
  flow_router: { tier: 'fast', timeoutMs: 3_000 },
  flow_condition: { tier: 'fast', timeoutMs: 3_000 },
  factcheck_triage: { tier: 'fast', timeoutMs: 4_000 },
  keystone_intent: { tier: 'fast', timeoutMs: 2_500 },
  automation: { tier: 'fast', timeoutMs: 4_000 },
};
