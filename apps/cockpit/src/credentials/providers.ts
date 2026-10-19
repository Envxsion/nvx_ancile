/**
 * ------------------------------------------------------------------
 *  Title    |  Model providers, for key screens
 *  Ref      |  roadmap PV1, PV3, GW1 · docs/errors.md (provider.*)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What Settings → API keys and first-run setup share:
 *           |  the provider list from Core, the words for a failed key
 *           |  test, and the quiet "this looks like another provider's
 *           |  key" hint.
 *  How      |  GET /providers is static facts (names, regions, how a
 *           |  key looks, where to make one), never a key. Key
 *           |  recognition looks at a short, unambiguous prefix only,
 *           |  on this computer, and never stores or logs what was
 *           |  typed. Error words are chosen by Core's documented
 *           |  code; Core's own title and hint are the fallback.
 *  Note     |  Core checks a key's shape on save as well. This hint
 *           |  only saves a trip, and never blocks anything.
 * ------------------------------------------------------------------
 */

import type { ProviderInfo, ProviderInfoList, ProviderRegion } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { orDemo } from '../lib/data';
import { loadDemo } from '../lib/demoData';

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      orDemo<ProviderInfo[]>(
        () => api.get<ProviderInfoList>('/providers').then((r) => r.items),
        () => loadDemo().then((m) => m.providers),
      ),
  });
}

/** A provider's own key page, only when it is a web address. */
export const safeDocsUrl = (url: string | null | undefined): string | null =>
  url && /^https:\/\//.test(url) ? url : null;

/** A region's label from its id, or the id itself. */
export const regionLabel = (
  info: Pick<ProviderInfo, 'regions'> | undefined,
  id: string | null | undefined,
) => (id ? (info?.regions?.find((r) => r.id === id)?.label ?? id) : null);

/* ---- Paste recognition -------------------------------------------------- */

/** "a" or "an" before a provider's name: "an OpenRouter key", "a DeepSeek key". */
export const withArticle = (name: string) => (/^[aeiox]/i.test(name) ? `an ${name}` : `a ${name}`);

/**
 * Prefixes only one provider uses. A bare `sk-` is shared by several and is
 * never read here. Order matters: longer prefixes first.
 */
const PREFIXES: [prefix: string, provider: string][] = [
  ['sk-ant-', 'anthropic'],
  ['sk-or-', 'openrouter'],
  ['sk-proj-', 'openai'],
  ['xai-', 'xai'],
  ['gsk_', 'groq'],
  ['AIza', 'google'],
];

export interface KeyNeighbour {
  id: string;
  name: string;
}

/**
 * The provider a pasted key clearly belongs to, when it is another one that
 * has a key row. Null for a key with no clear prefix or one that fits here.
 * Only the first few characters are looked at.
 */
export function recogniseKey(
  value: string,
  current: string,
  rows: readonly KeyNeighbour[],
): KeyNeighbour | null {
  const v = value.trim();
  if (v.length < 6) return null;
  const hit = PREFIXES.find(([p]) => v.startsWith(p));
  if (!hit || hit[1] === current) return null;
  return rows.find((r) => r.id === hit[1]) ?? null;
}

/* ---- Failure words ------------------------------------------------------ */

export interface Problem {
  title: string;
  hint: string;
  code?: string;
  /** The provider's own explanation, key removed by Core. */
  detail?: string;
}

export interface FriendlyProblem extends Problem {
  /** Regions to offer as a one-click retry (wrong region only). */
  tryRegions: ProviderRegion[];
}

/**
 * Core's error, in this screen's words. Core sends a title and hint for each
 * code already; these make the three the owner asked for read the same
 * everywhere, and turn "limiting requests" into plain words that say the key
 * may be fine.
 */
export function friendlyProblem(
  p: Problem,
  ctx: { name: string; regions?: ProviderRegion[] | null; region?: string | null },
): FriendlyProblem {
  const none: ProviderRegion[] = [];
  switch (p.code) {
    case 'provider.no_credit':
      return {
        ...p,
        title: `${ctx.name} says your account is out of credit`,
        hint: 'Top up there, or use another model.',
        tryRegions: none,
      };
    case 'provider.wrong_region':
      return {
        ...p,
        tryRegions: (ctx.regions ?? []).filter((r) => r.id !== ctx.region),
      };
    case 'provider.model_not_permitted': {
      const model = /can't use (.+?)\.?$/.exec(p.title)?.[1];
      return { ...p, title: model ? `This key can't use ${model}` : p.title, tryRegions: none };
    }
    case 'credentials.invalid': {
      const other = /^That key is for (.+?), not /.exec(p.title)?.[1];
      return { ...p, title: other ? `This looks like ${withArticle(other)} key` : p.title, tryRegions: none };
    }
    case 'provider.unavailable':
      if (/limiting requests/i.test(p.title))
        return {
          ...p,
          title: `${ctx.name} is busy right now`,
          hint: 'Your key may be fine; try again in a moment.',
          tryRegions: none,
        };
      return { ...p, tryRegions: none };
    default:
      return { ...p, tryRegions: none };
  }
}
