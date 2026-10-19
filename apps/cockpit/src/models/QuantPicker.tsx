/**
 * ------------------------------------------------------------------
 *  Title    |  Precision for a local model
 *  Ref      |  docs/models.md (Download a local model) · docs/openrouter.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Offer the precisions a local model comes in (Ollama tags
 *           |  like q4_K_M, q8_0, fp16), with download size and memory
 *           |  estimates and the trade-off in plain words.
 *  How      |  quantOptions() is pure: size from the weights' count
 *           |  (params_b) and bits per weight; memory adds a working
 *           |  context (memoryEstimateGb in contracts).
 * ------------------------------------------------------------------
 */

import '../styles/openrouter.css';
import type { LocalModelView, OllamaQuant } from '@nvx/contracts';
import { memoryEstimateGb, OLLAMA_QUANT_BITS } from '@nvx/contracts/openrouter';

const WORDS: Record<OllamaQuant, string> = {
  q4_K_M: 'Smallest and quickest. A little less precise; fine for most everyday use.',
  q5_K_M: 'A touch larger, a touch more precise.',
  q8_0: 'Close to the original. Twice the size of the smallest.',
  fp16: 'The original weights. Largest and slowest; only worth it with memory to spare.',
};

export interface QuantOption {
  quant: OllamaQuant;
  tag: string;
  size_gb: number;
  memory_gb: number;
  words: string;
}

export function quantOptions(
  m: Pick<LocalModelView, 'quant_tags' | 'params_b' | 'context_window'>,
): QuantOption[] {
  if (!m.quant_tags || !m.params_b) return [];
  const out: QuantOption[] = [];
  for (const q of Object.keys(OLLAMA_QUANT_BITS) as OllamaQuant[]) {
    const tag = m.quant_tags[q];
    if (!tag) continue;
    const bits = OLLAMA_QUANT_BITS[q];
    out.push({
      quant: q,
      tag,
      size_gb: Math.round(((m.params_b * bits) / 8) * 10) / 10,
      memory_gb: memoryEstimateGb(m.params_b, bits, Math.min(m.context_window, 8_192)),
      words: WORDS[q],
    });
  }
  return out;
}

export function QuantPicker({
  m,
  value,
  onChange,
}: {
  m: LocalModelView;
  value: OllamaQuant | null;
  onChange: (q: OllamaQuant | null) => void;
}) {
  const opts = quantOptions(m);
  if (!opts.length) return null;
  const chosen = opts.find((o) => o.quant === value);
  return (
    <div className="lm-quant">
      <label>
        <span className="mute">Precision </span>
        <select
          className="input input--sm"
          value={value ?? ''}
          onChange={(e) => onChange((e.target.value || null) as OllamaQuant | null)}
        >
          <option value="">Default ({m.source})</option>
          {opts.map((o) => (
            <option key={o.quant} value={o.quant}>
              {o.quant}: about {o.size_gb} GB, {o.memory_gb} GB of memory
            </option>
          ))}
        </select>
      </label>
      <span className="mute">
        {chosen
          ? chosen.words
          : 'Fewer bits per weight means a smaller, faster model that is slightly less exact. Sizes are estimates.'}
      </span>
    </div>
  );
}
