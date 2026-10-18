/**
 * ------------------------------------------------------------------
 *  Title    |  Model lines and versions
 *  Ref      |  roadmap MD4, MD5 · docs/models.md (Lines and tiers)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Tell which family ("line") a provider's model id
 *           |  belongs to, how new it is, and whether it is a preview,
 *           |  so `anthropic/opus:latest` can mean the newest Opus and
 *           |  nothing unknown is ever followed.
 *  How      |  Pure functions over the id string. Each provider has a
 *           |  few patterns; an id that matches none is not in a line
 *           |  (it can be offered as a new model, never followed).
 *           |  Dated snapshots (gpt-5.5-2026-08-01, -20251001) are the
 *           |  same version as the undated id, never newer, and the
 *           |  undated id is preferred.
 *  Note     |  Endpoint providers (DeepSeek, Kimi…) are recognised by
 *           |  their host: vendorOf() names the family of rules, and
 *           |  lineFor() keeps the registry's own provider name in the
 *           |  line id.
 * ------------------------------------------------------------------
 */
import type { ModelTier } from '@nvx/contracts';

export interface LineInfo {
  /** `<provider>/<line>`, e.g. anthropic/opus. */
  line_id: string;
  /** "Claude Opus". */
  name: string;
  tier: ModelTier;
  /** "5.5", or null when the id carries none. */
  version: string | null;
  preview: boolean;
}

/** exp/preview/beta/alpha/rc as a word of the id. */
const PREVIEW = /(^|[-_.])(preview|exp|experimental|beta|alpha|rc\d*)($|[-_.])/i;

/** A trailing snapshot date: -20251001 or -2026-08-01. */
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/** The id without its snapshot date. */
export const stripDate = (providerModel: string) => providerModel.replace(DATE_SUFFIX, '');

/** The snapshot date of an id as YYYYMMDD, or null. */
export function dateOf(providerModel: string): string | null {
  const m = DATE_SUFFIX.exec(providerModel);
  return m ? (m[1] as string).replace(/-/g, '') : null;
}

const mk = (
  provider: string,
  line: string,
  name: string,
  tier: ModelTier,
  version: string | null,
  providerModel: string,
): LineInfo => ({
  line_id: `${provider}/${line}`,
  name,
  tier,
  version,
  preview: PREVIEW.test(providerModel),
});

const ANTHROPIC_TIER: Record<string, { name: string; tier: ModelTier }> = {
  fable: { name: 'Claude Fable', tier: 'best' },
  opus: { name: 'Claude Opus', tier: 'best' },
  sonnet: { name: 'Claude Sonnet', tier: 'balanced' },
  haiku: { name: 'Claude Haiku', tier: 'fast' },
};

const OPENAI_SKIP =
  /(audio|realtime|search|transcribe|tts|image|embedding|moderation|chat-latest|codex|instruct)/;

/**
 * The line a model belongs to under one family of naming rules
 * (anthropic, openai, google, deepseek, moonshot, xai, mistral), or null.
 */
export function lineOf(provider: string, providerModel: string): LineInfo | null {
  const id = providerModel.trim().toLowerCase();
  if (!id || id.endsWith('-latest') || id.includes('/')) return null;
  switch (provider) {
    case 'anthropic': {
      const cur =
        /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?(?:-(preview|exp|beta|alpha))?$/.exec(
          id,
        );
      if (cur) {
        const t = ANTHROPIC_TIER[cur[1] as string] as { name: string; tier: ModelTier };
        return mk('anthropic', cur[1] as string, t.name, t.tier, `${cur[2]}.${cur[3] ?? '0'}`, id);
      }
      // Legacy: claude-3-5-sonnet-20241022, claude-3-opus-20240229.
      const old = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-(\d{8}))?$/.exec(id);
      if (old) {
        const t = ANTHROPIC_TIER[old[3] as string] as { name: string; tier: ModelTier };
        return mk('anthropic', old[3] as string, t.name, t.tier, `${old[1]}.${old[2] ?? '0'}`, id);
      }
      return null;
    }
    case 'openai': {
      if (OPENAI_SKIP.test(id)) return null;
      const m = /^gpt-(\d+(?:\.\d+)?)(-mini|-nano)?(?:-(\d{4}-\d{2}-\d{2}|preview))?$/.exec(id);
      if (!m) return null;
      const v = m[1] as string;
      if (m[2] === '-mini') return mk('openai', 'gpt-mini', 'GPT mini', 'balanced', v, id);
      if (m[2] === '-nano') return mk('openai', 'gpt-nano', 'GPT nano', 'fast', v, id);
      return mk('openai', 'gpt', 'GPT', 'best', v, id);
    }
    case 'google': {
      if (/(tts|image|live|audio|embedding|native|computer)/.test(id)) return null;
      const m =
        /^gemini-(\d+(?:\.\d+)?)-(pro|flash-lite|flash)((?:-(?:preview|exp|experimental)[-\w.]*)?|-\d{3})$/.exec(
          id,
        );
      if (!m) return null;
      const v = m[1] as string;
      if (m[2] === 'pro') return mk('google', 'gemini-pro', 'Gemini Pro', 'best', v, id);
      if (m[2] === 'flash') return mk('google', 'gemini-flash', 'Gemini Flash', 'balanced', v, id);
      return mk('google', 'gemini-flash-lite', 'Gemini Flash-Lite', 'fast', v, id);
    }
    case 'deepseek': {
      const pro = /^deepseek-v(\d+(?:\.\d+)?)-pro$/.exec(id);
      if (pro) return mk('deepseek', 'pro', 'DeepSeek Pro', 'best', pro[1] as string, id);
      const flash = /^deepseek(?:-v(\d+(?:\.\d+)?))?-flash$/.exec(id);
      if (flash) return mk('deepseek', 'flash', 'DeepSeek Flash', 'fast', flash[1] ?? null, id);
      return null;
    }
    case 'moonshot': {
      if (/(code|highspeed|thinking)/.test(id)) return null;
      const m = /^kimi-k(\d+(?:\.\d+)?)(?:-(preview|\d{4}))?$/.exec(id);
      if (!m) return null;
      return mk('moonshot', 'kimi', 'Kimi', 'best', m[1] as string, id);
    }
    case 'xai': {
      const m = /^grok-(\d+(?:\.\d+)?)(-mini)?$/.exec(id);
      if (!m) return null;
      return m[2]
        ? mk('xai', 'grok-mini', 'Grok mini', 'fast', m[1] as string, id)
        : mk('xai', 'grok', 'Grok', 'best', m[1] as string, id);
    }
    case 'mistral': {
      const m = /^mistral-(large|medium|small)-(\d{4})$/.exec(id);
      if (!m) return null;
      const t: Record<string, { name: string; tier: ModelTier }> = {
        large: { name: 'Mistral Large', tier: 'best' },
        medium: { name: 'Mistral Medium', tier: 'balanced' },
        small: { name: 'Mistral Small', tier: 'fast' },
      };
      const x = t[m[1] as string] as { name: string; tier: ModelTier };
      return mk('mistral', m[1] as string, x.name, x.tier, m[2] as string, id);
    }
    default:
      return null;
  }
}

/** Hosts of endpoint providers whose naming rules we know, and the vendor they are. */
const HOSTS: [RegExp, string][] = [
  [/(^|\.)deepseek\.com$/, 'deepseek'],
  [/(^|\.)moonshot\.(ai|cn)$/, 'moonshot'],
  [/(^|\.)mistral\.ai$/, 'mistral'],
  [/(^|\.)x\.ai$/, 'xai'],
  [/(^|\.)aliyuncs\.com$/, 'qwen'],
  [/(^|\.)(z\.ai|bigmodel\.cn)$/, 'zai'],
  [/(^|\.)minimaxi?\.(io|com)$/, 'minimax'],
  [/(^|\.)groq\.com$/, 'groq'],
  [/(^|\.)together\.(ai|xyz)$/, 'together'],
];

/** The family of naming rules for a registry provider: itself when built in, else read from the host. */
export function vendorOf(provider: string, baseUrl?: string | null): string | null {
  if (provider === 'anthropic' || provider === 'openai' || provider === 'google' || provider === 'openrouter')
    return provider;
  if (!baseUrl) return null;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** lineOf for a registry model: the line id keeps the registry's provider name. */
export function lineFor(
  provider: string,
  baseUrl: string | null | undefined,
  providerModel: string,
): LineInfo | null {
  const vendor = vendorOf(provider, baseUrl);
  if (!vendor) return null;
  const l = lineOf(vendor, providerModel);
  if (!l) return null;
  return vendor === provider ? l : { ...l, line_id: `${provider}/${l.line_id.slice(vendor.length + 1)}` };
}

/** Numeric segment compare of "5.5" against "5.10"; a missing version is the oldest. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface Rankable {
  version: string | null;
  /** Snapshot date from the id (YYYYMMDD), null for an undated id. */
  date?: string | null;
  /** The provider's created_at, when it gave one. */
  created?: string | null;
}

/**
 * Newer is positive. Version first; at the same version an undated id beats a
 * dated snapshot (they are the same model), two snapshots go by date, then by created_at.
 */
export function compareModels(a: Rankable, b: Rankable): number {
  const v = compareVersions(a.version, b.version);
  if (v !== 0) return v;
  const da = a.date ?? null;
  const db = b.date ?? null;
  if (da === null && db !== null) return 1;
  if (da !== null && db === null) return -1;
  if (da !== null && db !== null && da !== db) return da < db ? -1 : 1;
  const ca = a.created ?? '';
  const cb = b.created ?? '';
  return ca === cb ? 0 : ca < cb ? -1 : 1;
}
