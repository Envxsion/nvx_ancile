/**
 * ------------------------------------------------------------------
 *  Title    |  What a model family can do
 *  Ref      |  roadmap MD5 · docs/models.md (What is checked)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Give a model its abilities when its provider's list
 *           |  says nothing about them (Google's list carries no
 *           |  input types or tool support).
 *  How      |  Pure. A small table by provider and id pattern, taken
 *           |  from each provider's model pages. Returns null for a
 *           |  family it does not know, so the caller never claims an
 *           |  ability on a guess.
 *  Note     |  Sources, checked 2026-10-20: ai.google.dev/gemini-api/
 *           |  docs/models (Gemini 3.x take text, image, video, audio
 *           |  and PDF; function calling, structured output, thinking),
 *           |  ai.google.dev/gemma/docs/core (Gemma 3 takes images from
 *           |  4B up; no native function calling).
 * ------------------------------------------------------------------
 */
import type { ModelConfig } from '@nvx/contracts';

type Capability = ModelConfig['capabilities'][number];

/** The abilities of a model family, or null when the family is not known. */
export function familyCapabilities(provider: string, providerModel: string): Capability[] | null {
  const id = providerModel.toLowerCase();
  if (provider === 'google') {
    const gemini = /^gemini-(\d+(?:\.\d+)?)-/.exec(id);
    if (gemini) {
      const v = Number(gemini[1]);
      return v >= 2.5 ? ['tools', 'vision', 'reasoning', 'json'] : ['tools', 'vision', 'json'];
    }
    // Gemma 3 reads images from 4B up (the 1B is text only) and has no native function calling.
    const gemma = /^gemma-3n?-(\d+)b/.exec(id);
    if (gemma) return Number(gemma[1]) >= 4 ? ['vision'] : [];
    if (id.startsWith('gemma')) return [];
  }
  return null;
}
