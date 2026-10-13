/**
 * ------------------------------------------------------------------
 *  Title    |  OpenRouter: queries and words
 *  Ref      |  docs/openrouter.md · contracts openrouter.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What the endpoint explorer, routing controls, cost
 *           |  calculator and model assistant read and write, and the
 *           |  plain words each preset is shown in.
 *  How      |  React Query against Core's /openrouter, /cost and
 *           |  /advisor routes. Endpoint lists are cached by Core (and
 *           |  kept for offline); here they stay fresh for five minutes.
 * ------------------------------------------------------------------
 */

import type {
  AdvisorRequest,
  AdvisorResult,
  CostEstimate,
  CostEstimateRequest,
  EndpointsReport,
  RoutingPreset,
  RoutingPreview,
  RoutingScope,
  RoutingSettings,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiCallError, api, localError } from '../lib/api';

export const OR_KEYS = {
  endpoints: (model: string) => ['openrouter', 'endpoints', model] as const,
  routing: (scope: RoutingScope, id: string) => ['openrouter', 'routing', scope, id] as const,
};

export function useEndpoints(model: string | null) {
  return useQuery({
    queryKey: OR_KEYS.endpoints(model ?? ''),
    queryFn: () => api.get<EndpointsReport>(`/openrouter/endpoints?model=${encodeURIComponent(model ?? '')}`),
    enabled: !!model,
    staleTime: 5 * 60_000,
  });
}

export function useRoutingOverride(scope: RoutingScope, id: string | null) {
  return useQuery({
    queryKey: OR_KEYS.routing(scope, id ?? ''),
    queryFn: () =>
      api.get<{ settings: RoutingSettings | null }>(
        `/openrouter/routing?scope=${scope}&id=${encodeURIComponent(id ?? '')}`,
      ),
    enabled: !!id,
  });
}

export const saveRouting = (scope: RoutingScope, id: string, settings: RoutingSettings | null) =>
  api.put('/openrouter/routing', { scope, id, settings });

export const previewRouting = (model: string, settings: RoutingSettings, modelId?: string) =>
  api.post<RoutingPreview>(
    `/openrouter/routing/preview${modelId ? `?model_id=${encodeURIComponent(modelId)}` : ''}`,
    { model, settings },
  );

export const estimateCost = (req: CostEstimateRequest, modelId?: string) =>
  api.post<CostEstimate>(`/cost/estimate${modelId ? `?model_id=${encodeURIComponent(modelId)}` : ''}`, req);

export const askAdvisor = (req: AdvisorRequest) => api.post<AdvisorResult>('/advisor', req);

/** An error as ErrorState shows it. */
export const errorBody = (e: unknown) =>
  e instanceof ApiCallError
    ? e.body
    : localError(
        'client.unreachable',
        'NVX Ancile could not be reached',
        'Check it is running, then try again.',
        '',
      );

export const DEFAULT_ROUTING: RoutingSettings = {
  preset: 'recommended',
  providers: [],
  avoid: [],
  deny_data_collection: false,
  min_precision: null,
  max_tokens: null,
  advanced: null,
};

export const PRESETS: { value: RoutingPreset; label: string; blurb: string; exacto: boolean }[] = [
  {
    value: 'recommended',
    label: 'Recommended',
    blurb:
      'Leaves out endpoints too short for the job, asks only providers that support every setting, and keeps Auto Exacto for tool calls.',
    exacto: true,
  },
  {
    value: 'best_quality',
    label: 'Best quality',
    blurb: 'Trusted providers first, at the lab’s own precision only. Costs more, varies less.',
    exacto: false,
  },
  {
    value: 'lowest_cost',
    label: 'Lowest real cost',
    blurb:
      'Ranks providers by what your turns really cost, cache discounts and your own input and output mix included.',
    exacto: false,
  },
  {
    value: 'fastest',
    label: 'Fastest',
    blurb: 'The provider that answers quickest right now.',
    exacto: false,
  },
  { value: 'pinned', label: 'Pinned', blurb: 'Only the providers you choose, in your order.', exacto: false },
  {
    value: 'advanced',
    label: 'Advanced',
    blurb: 'Every OpenRouter provider field, set by hand.',
    exacto: true,
  },
];

export const usd = (n: number) =>
  n === 0
    ? '$0'
    : n < 0.01
      ? `$${n.toFixed(4)}`
      : n < 100
        ? `$${n.toFixed(2)}`
        : `$${Math.round(n).toLocaleString('en-GB')}`;

export const tokensText = (n: number | null) => (n === null ? 'Unknown' : n.toLocaleString('en-GB'));
