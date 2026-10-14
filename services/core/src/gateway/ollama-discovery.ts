/**
 * ------------------------------------------------------------------
 *  Title    |  Ollama's pulled models, as models
 *  Ref      |  docs/models.md (Ollama) · gateway/registry.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A chat model you pulled into Ollama is listed by itself,
 *           |  as ollama/<name>, without adding it anywhere; it leaves
 *           |  the list when Ollama no longer has it.
 *  How      |  The registry reads Ollama's tags on its existing probe
 *           |  and turns each pulled name into a ModelConfig here.
 *           |  Embedding models are left out: by what Ollama says it can
 *           |  do (POST /api/show capabilities) when that is known, by
 *           |  name otherwise. A name a configured or added model
 *           |  already serves is never listed twice.
 *  Note     |  Without Ollama's facts a model gets no tool or vision
 *           |  capability (sending tools to a model that has none is an
 *           |  error in Ollama) and a modest window, so it always
 *           |  answers; with them it gets what Ollama says it has.
 * ------------------------------------------------------------------
 */

import { ModelConfig } from '@nvx/contracts';

/** What Ollama says about one pulled model (POST /api/show); null fields when it does not say. */
export interface OllamaModelFacts {
  /** Ollama's own words: completion, tools, vision, thinking, embedding, insert. */
  capabilities: string[] | null;
  /** The model's trained context length (model_info "<arch>.context_length"). */
  context: number | null;
}

/** The window a discovered model is planned for when Ollama does not say. */
export const DISCOVERED_CONTEXT = 8_192;

/** Ollama names a model `name:tag`; `name` alone is `name:latest`. */
export const ollamaName = (n: string) => (n.includes(':') ? n : `${n}:latest`);

/** Names Ollama's embedding models go by (nomic-embed-text, mxbai-embed-large, all-minilm, bge-m3, …). */
const EMBED_NAME = /embed|minilm|(^|[-_.])(bge|e5|gte)([-_.]|$)|rerank|paraphrase/i;

/** The model part of a name: "hf.co/user/Model-GGUF:Q4" → "Model-GGUF". */
const baseOf = (name: string) => (name.split(':')[0] ?? name).split('/').pop() ?? name;

/** A model that answers a chat: what Ollama says when it says, otherwise not an embedding name. */
export function isChatModel(name: string, facts: OllamaModelFacts | null | undefined): boolean {
  const caps = facts?.capabilities;
  if (caps?.length) return caps.includes('completion');
  return !EMBED_NAME.test(baseOf(name));
}

/** A model served by an Ollama server: an Ollama model, an ollama/… id, or a server on Ollama's port. */
export function servedByOllama(m: Pick<ModelConfig, 'id' | 'provider' | 'via' | 'base_url'>): boolean {
  if (m.via === 'controller') return false;
  if (m.provider === 'ollama' || m.id.startsWith('ollama/')) return true;
  if (!m.base_url) return false;
  try {
    return new URL(m.base_url).port === '11434';
  } catch {
    return false;
  }
}

/** The id a pulled name is listed under; the same one a one-click download saves (localmodels/service.ts). */
export function discoveredId(name: string): string {
  const short = ollamaName(name).replace(/:latest$/, '');
  return `ollama/${short.replace(/[^A-Za-z0-9._:-]/g, '-')}`;
}

/** Ollama's words for what a model can do, in NVX Ancile's. */
const CAPABILITY = new Map<string, ModelConfig['capabilities'][number]>([
  ['tools', 'tools'],
  ['vision', 'vision'],
  ['thinking', 'reasoning'],
]);

/** A pulled chat model as a ModelConfig, or null when its name cannot make a valid id. */
export function discoveredModel(
  name: string,
  facts: OllamaModelFacts | null | undefined,
): ModelConfig | null {
  const short = ollamaName(name).replace(/:latest$/, '');
  const window = facts?.context && facts.context > 0 ? Math.floor(facts.context) : DISCOVERED_CONTEXT;
  const caps = [...new Set((facts?.capabilities ?? []).flatMap((c) => CAPABILITY.get(c) ?? []))];
  const parsed = ModelConfig.safeParse({
    id: discoveredId(name),
    provider: 'ollama',
    provider_model: name,
    display_name: `${short} (Ollama)`,
    via: 'direct',
    family: /^[a-z]+/.exec(baseOf(name).toLowerCase())?.[0] ?? 'ollama',
    context_window: window,
    max_output: Math.min(8_192, window),
    capabilities: caps,
    price: { input_per_mtok: 0, output_per_mtok: 0 },
    enabled: true,
  });
  return parsed.success ? parsed.data : null;
}
