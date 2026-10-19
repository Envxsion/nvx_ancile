/**
 * ------------------------------------------------------------------
 *  Title    |  An image_generate step
 *  Ref      |  docs/images.md (Generation)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Show what was asked for and what came back: the images
 *           |  inline (they open in the lightbox), with the prompt, the
 *           |  model and provider that made them, and what they cost.
 *  How      |  The tool result is ImageGenerateResult; the images are
 *           |  stored attachments of the thread, served by Core by id.
 * ------------------------------------------------------------------
 */

import { ImageGenerateResult } from '@nvx/contracts/images';
import type { ToolCall, ToolResult } from '../thread/ToolSteps';
import { ImageFrame } from './ThreadImage';

const KIND = { cloud: 'cloud', local: 'this computer', node: 'your GPU node' } as const;

function parse(result: ToolResult | undefined): ImageGenerateResult | null {
  if (!result?.ok) return null;
  const r = ImageGenerateResult.safeParse(result.result);
  return r.success ? r.data : null;
}

const money = (usd: number | null) =>
  usd === null ? null : usd === 0 ? 'no charge' : `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;

/** One short line for the step's summary: "2 images · $0.08". */
export function imageMeta(result: ToolResult | undefined): string | null {
  const r = parse(result);
  if (!r) return null;
  const n = `${r.images.length} image${r.images.length === 1 ? '' : 's'}`;
  const cost = money(r.cost_usd);
  return cost ? `${n} · ${cost}` : n;
}

export function ImageGenBody({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  const args = (call.args ?? {}) as { prompt?: unknown };
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  const r = parse(result);
  const failed = result && !result.ok ? (typeof result.result === 'string' ? result.result : null) : null;
  return (
    <div className="imggen">
      {prompt ? <p className="imggen__prompt">{prompt}</p> : null}
      {!result ? (
        <p className="imggen__live" aria-live="polite">
          <span className="pyrun__dot" aria-hidden="true" />
          Making the image
        </p>
      ) : null}
      {r ? (
        <>
          <div className="imggen__grid">
            {r.images.map((img) => (
              <ImageFrame
                key={img.id}
                src={img.url}
                alt={r.prompt}
                width={img.width}
                height={img.height}
                caption={
                  <span>
                    {r.model} · {KIND[r.provider_kind]}
                  </span>
                }
              />
            ))}
          </div>
          <p className="imggen__meta" data-num>
            {r.model} on {r.provider} ({KIND[r.provider_kind]})
            {money(r.cost_usd) ? ` · ${money(r.cost_usd)}` : ''}
          </p>
        </>
      ) : null}
      {failed ? (
        <p className="imggen__error" role="status">
          {failed}
        </p>
      ) : null}
    </div>
  );
}
