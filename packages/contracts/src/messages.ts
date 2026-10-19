/**
 * Message parts: the provider-neutral shape every message is stored in.
 * The Gateway translates these to and from each provider, which is what
 * makes switching model mid-thread lossless (DESIGN.md §8.6).
 */
import { z } from 'zod';
import { ModelBilling } from './billing';
import { ServedBy } from './openrouter';

export const Role = z.enum(['system', 'user', 'assistant', 'tool']);

export const TextPart = z.object({ type: z.literal('text'), text: z.string() });
export const ReasoningPart = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  /**
   * CA1: some providers require their signed reasoning back verbatim, so it is
   * kept exactly as received: `{ anthropic: { signature } }` or
   * `{ anthropic: { redactedData } }` for a thinking block, `{ openrouter:
   * { reasoning_details } }` for OpenRouter. Absent on a block that was cut off
   * (a cancelled stream), which a signing provider would reject.
   */
  provider_meta: z.record(z.string(), z.unknown()).optional(),
});
export const FilePart = z.object({
  type: z.literal('file'),
  source_id: z.string().optional(),
  name: z.string(),
  mime: z.string(),
  url: z.string(),
  /**
   * CH6: a file attached to this one message. Its text was read when it was attached and is kept
   * here, so the message reads the same on every later turn (CA4); it is not a source and no
   * other message sees it. Absent on a file that only names a source.
   */
  text: z.string().optional(),
  /** Pages, for a PDF. */
  pages: z.number().int().positive().optional(),
  /** Only the start of the file was kept (a very long one). */
  truncated: z.boolean().optional(),
  /**
   * CH6 (Pro): the file was over the model's context budget, so only its most relevant pages
   * (or parts, for a text file) are in `text`. Absent: all of it went.
   */
  kept: z
    .object({
      /** The pages (or parts) that went, 1-based, in order. */
      pages: z.array(z.number().int().positive()),
      /** How many the file has. */
      of: z.number().int().positive(),
      unit: z.enum(['page', 'part']),
      /** The last kept page was cut short (one page was bigger than the budget). */
      partial: z.boolean().optional(),
    })
    .optional(),
});
export type FilePart = z.infer<typeof FilePart>;
export const ImagePart = z.object({
  type: z.literal('image'),
  url: z.string(),
  mime: z.string(),
  /** Generated caption, used for models without vision. */
  caption: z.string().optional(),
  /** A stored image (core.images, docs/images.md); its url is then /api/v1/images/<id>. */
  image_id: z.string().optional(),
  alt: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});
export type ImagePart = z.infer<typeof ImagePart>;
export const ToolCallPart = z.object({
  type: z.literal('tool_call'),
  call_id: z.string(),
  tool: z.string(),
  args: z.unknown(),
  /**
   * CA1: what a provider signed on this call and wants back with it, exactly as
   * received (Gemini's thought signature, `{ google: { thoughtSignature } }`).
   * Sent only to the provider that issued it.
   */
  provider_meta: z.record(z.string(), z.unknown()).optional(),
});
export const ToolResultPart = z.object({
  type: z.literal('tool_result'),
  call_id: z.string(),
  ok: z.boolean(),
  result: z.unknown(),
  /** Set when the user declined: the model is told, not aborted. */
  declined_reason: z.string().optional(),
  /**
   * How long the step took, from the call to its result, when it was
   * measured (Core's tool loop; Claude Code's transcript times). Absent on
   * older messages: the step then shows no duration rather than a guess.
   */
  duration_ms: z.number().int().nonnegative().optional(),
});
export const CitationRefPart = z.object({
  type: z.literal('citation_ref'),
  marker: z.number().int(),
  chunk_id: z.string(),
  source_id: z.string(),
  char_start: z.number().int(),
  char_end: z.number().int(),
  quote: z.string(),
  /**
   * The source's title when the answer was written, so a citation still
   * names its source after the source is removed. Absent on older answers.
   */
  source_title: z.string().optional(),
  /**
   * sha256 (hex) of the whole passage as it was given to the model, so a
   * later look can tell whether the source still says the same thing.
   * Absent on older answers.
   */
  text_sha256: z.string().optional(),
  /**
   * Set when the passage was read through a context link from another
   * notebook (docs/notebooks.md): that notebook, so the citation names it.
   */
  notebook_id: z.string().optional(),
  notebook_title: z.string().optional(),
});
/** Where a fallback model continued a stream another model started. */
export const SeamPart = z.object({
  type: z.literal('seam'),
  from_model: z.string(),
  to_model: z.string(),
  reason: z.string(),
});

export const Part = z.discriminatedUnion('type', [
  TextPart,
  ReasoningPart,
  FilePart,
  ImagePart,
  ToolCallPart,
  ToolResultPart,
  CitationRefPart,
  SeamPart,
]);
export type Part = z.infer<typeof Part>;

export const MessageStatus = z.enum(['pending', 'streaming', 'complete', 'stopped', 'error']);

/**
 * One model call inside an answer (roadmap WY1). A tool-using answer makes
 * several; the receipt lists them. Token counts follow the canonical meaning
 * (gateway/usage.ts): input counts every prompt token, cache reads and
 * writes included.
 */
export const UsageCall = z.object({
  model_id: z.string(),
  /** When the call began, in ms after the turn started. */
  started_ms: z.number().int().nonnegative(),
  ms: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  cache_write_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  /** List price for this call. */
  cost_usd: z.number().nonnegative(),
  /** What the provider says it billed, when it says (OpenRouter). */
  billed_usd: z.number().nonnegative().optional(),
  served: ServedBy.optional(),
  /** Why the call ended: it asked for tools, finished its answer, hit the output cap, or failed. */
  stop: z.enum(['tool_calls', 'end', 'length', 'error']).optional(),
});
export type UsageCall = z.infer<typeof UsageCall>;

/** Prices per million tokens in force when the answer was written. */
export const UsageRates = z.object({
  input: z.number().nonnegative(),
  cached: z.number().nonnegative(),
  cache_write: z.number().nonnegative(),
  output: z.number().nonnegative(),
});
export type UsageRates = z.infer<typeof UsageRates>;

export const MAX_USAGE_CALLS = 50;

export const Usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative().default(0),
  /** The list-price cost (tokens times the model's rates). The receipt total uses `billed_usd` when it is set. */
  cost_usd: z.number().nonnegative(),
  /** OpenRouter only: which provider (and, under openrouter/auto, which model) answered. */
  served: ServedBy.optional(),
  /** Tokens written to the provider's cache. Absent on answers from before the receipt. */
  cache_write_tokens: z.number().int().nonnegative().optional(),
  /** False when the provider reported no cache figures at all: "not reported", never zero. Absent on older answers. */
  cache_reported: z.boolean().optional(),
  /** What the provider billed for the whole answer: its calls' billed cost, plus list price for any call it did not bill. Set only when a provider billed at least one call (OpenRouter); it then equals `cost_usd`. */
  billed_usd: z.number().nonnegative().optional(),
  /** The list price of the whole answer (its tokens at the model's rates), set with `billed_usd` so a difference can be shown. */
  list_usd: z.number().nonnegative().optional(),
  /** Who paid, as it was when the answer was written; a later sign-in change does not rewrite it. */
  billing: ModelBilling.optional(),
  rates: UsageRates.optional(),
  /** Every model call the answer made, in order (at most 50). */
  calls: z.array(UsageCall).max(MAX_USAGE_CALLS).optional(),
  /** Wall time of the whole turn, in ms. */
  ms: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

/**
 * A problem that fixed itself while the answer was written (provenance.recovered):
 * a model call or a tool call that failed, was retried inside the resilience
 * layer, and then succeeded.
 */
export const Recovered = z.object({
  what: z.enum(['model', 'tool']),
  name: z.string(),
  /** Attempts in all, the successful one included. */
  attempts: z.number().int().min(2),
  /** Time spent waiting between attempts, in ms. */
  waited_ms: z.number().int().nonnegative(),
  /** A short code: rate_limited, timeout, server_error or network. */
  reason: z.string().max(40),
});
export type Recovered = z.infer<typeof Recovered>;

export const MAX_RECOVERED = 20;

/**
 * A note the person added while the answer was written (provenance.steered, CH7): which model round
 * took it, and `part`, how many of the answer's parts came before it, so it can be put back in place.
 * Answers written before `part` was kept have none: their notes sit after the last part.
 */
export const SteeredNote = z.object({
  id: z.string(),
  text: z.string(),
  round: z.number().int().nonnegative(),
  part: z.number().int().nonnegative().optional(),
  at: z.string(),
});
export type SteeredNote = z.infer<typeof SteeredNote>;

export const Message = z.object({
  id: z.string(),
  thread_id: z.string(),
  parent_id: z.string().nullable(),
  role: Role,
  parts: z.array(Part),
  model_id: z.string().nullable(),
  requested_model_id: z.string().nullable(),
  status: MessageStatus,
  edit_of_id: z.string().nullable(),
  provenance: z.record(z.string(), z.unknown()).default({}),
  usage: Usage.nullable(),
  run_id: z.string().nullable(),
  trace_id: z.string(),
  created_at: z.string(),
  /** Computed: number of siblings and this one's index, for ‹ 2 / 3 › */
  siblings: z
    .object({ index: z.number().int(), count: z.number().int(), ids: z.array(z.string()).optional() })
    .optional(),
});
export type Message = z.infer<typeof Message>;
