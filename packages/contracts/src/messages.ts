/**
 * Message parts: the provider-neutral shape every message is stored in.
 * The Gateway translates these to and from each provider, which is what
 * makes switching model mid-thread lossless (DESIGN.md §8.6).
 */
import { z } from 'zod';

export const Role = z.enum(['system', 'user', 'assistant', 'tool']);

export const TextPart = z.object({ type: z.literal('text'), text: z.string() });
export const ReasoningPart = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  /** Some providers require their signed reasoning back verbatim. */
  provider_meta: z.record(z.string(), z.unknown()).optional(),
});
export const FilePart = z.object({
  type: z.literal('file'),
  source_id: z.string().optional(),
  name: z.string(),
  mime: z.string(),
  url: z.string(),
});
export const ImagePart = z.object({
  type: z.literal('image'),
  url: z.string(),
  mime: z.string(),
  /** Generated caption, used for models without vision. */
  caption: z.string().optional(),
});
export const ToolCallPart = z.object({
  type: z.literal('tool_call'),
  call_id: z.string(),
  tool: z.string(),
  args: z.unknown(),
});
export const ToolResultPart = z.object({
  type: z.literal('tool_result'),
  call_id: z.string(),
  ok: z.boolean(),
  result: z.unknown(),
  /** Set when the user declined: the model is told, not aborted. */
  declined_reason: z.string().optional(),
});
export const CitationRefPart = z.object({
  type: z.literal('citation_ref'),
  marker: z.number().int(),
  chunk_id: z.string(),
  source_id: z.string(),
  char_start: z.number().int(),
  char_end: z.number().int(),
  quote: z.string(),
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

export const Usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

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
