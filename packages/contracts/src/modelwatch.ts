/**
 * ------------------------------------------------------------------
 *  Title    |  Model watch: live model lists, prices and "follow latest"
 *  Ref      |  roadmap MD4, MD5 · guard rail GR16 · docs/models.md
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Once a day (and on start) Core reads the live model list
 *           |  of every provider you have a key or sign-in for, and
 *           |  prices where they are published. New models are offered
 *           |  by line and tier; changes in price, context, abilities or
 *           |  retirement are shown before anything switches.
 *  How      |  A line is one family of a provider's models that get
 *           |  newer versions ("Claude Opus"). Its alias id
 *           |  `<provider>/<line>:latest` resolves, at call time, to the
 *           |  line's current model. Following moves the alias only
 *           |  after a test call passes, never to a preview, and always
 *           |  keeps a way back (GR16).
 *  Note     |  Literal model ids are never rewritten. A retired literal
 *           |  id resolves to its line's current model, with a note.
 * ------------------------------------------------------------------
 */
import { z } from 'zod';
import { Capability, ModelTier } from './config';

/** `<provider>/<line>:latest`, e.g. anthropic/opus:latest. */
export const LINE_ALIAS_SUFFIX = ':latest';
export const lineAlias = (lineId: string) => `${lineId}${LINE_ALIAS_SUFFIX}`;
export const isLineAlias = (id: string | null | undefined): id is string =>
  !!id && id.endsWith(LINE_ALIAS_SUFFIX) && id.includes('/');
/** anthropic/opus:latest -> anthropic/opus */
export const lineOfAlias = (id: string) => id.slice(0, -LINE_ALIAS_SUFFIX.length);

export const WatchPrice = z
  .object({
    input_per_mtok: z.number().nonnegative(),
    output_per_mtok: z.number().nonnegative(),
    cached_per_mtok: z.number().nonnegative().optional(),
    cache_write_per_mtok: z.number().nonnegative().optional(),
  })
  .strict();
export type WatchPrice = z.infer<typeof WatchPrice>;

/** Where a price came from: the provider itself, OpenRouter's public list, or the copy shipped with NVX Ancile. */
export const PriceSource = z.enum(['provider', 'openrouter', 'bundled']);
export type PriceSource = z.infer<typeof PriceSource>;

/** One model as a provider's live list reports it. */
export const WatchedModel = z
  .object({
    /** Ancile's id, `<provider>/<provider_model>`. */
    id: z.string(),
    provider: z.string(),
    provider_model: z.string(),
    display_name: z.string(),
    /** `<provider>/<line>` when the model belongs to a line, else null (offered, never followed). */
    line_id: z.string().nullable(),
    /** The version within its line, for ordering ("5.5"); null when unknown. */
    version: z.string().nullable(),
    /** Preview, experimental, beta or limited access: offered, never followed (GR16). */
    preview: z.boolean(),
    context_window: z.number().int().positive().nullable(),
    max_output: z.number().int().positive().nullable(),
    /** Abilities NVX Ancile uses. */
    capabilities: z.array(Capability),
    /** Abilities the provider reports that NVX Ancile does not use yet ("pdf_input", "video_input"…). */
    other_abilities: z.array(z.string().max(60)).max(40),
    price: WatchPrice.nullable(),
    price_source: PriceSource.nullable(),
    /** ISO date the price was last confirmed. */
    price_checked_at: z.string().nullable(),
    lifecycle: z.enum(['active', 'deprecated', 'retired']),
    /** When the provider says it retires (ISO), if it says. */
    retires_at: z.string().nullable(),
    first_seen: z.string(),
    last_seen: z.string(),
    /** Already in the model list (models.yaml, added by you, or added from here). */
    in_catalogue: z.boolean(),
  })
  .strict();
export type WatchedModel = z.infer<typeof WatchedModel>;

/** A line of models that get newer versions, and how "follow latest" stands for it. */
export const ModelLine = z
  .object({
    /** `<provider>/<line>`, e.g. anthropic/opus. Its alias is `${id}:latest`. */
    id: z.string(),
    provider: z.string(),
    /** "Claude Opus", "GPT mini", "Gemini Flash". */
    name: z.string(),
    tier: ModelTier,
    /** The newest stable model seen for this line. */
    latest_id: z.string().nullable(),
    /** What the alias answers with now. */
    current_id: z.string().nullable(),
    /** Move to newer models by itself (after a passing test call). Off until you turn it on. */
    follow: z.boolean(),
    /** What "Go back" returns to: the model before the last move. */
    previous_id: z.string().nullable(),
    /** A newer model waiting: being tested, failed its test, or offered while not following. */
    pending: z
      .object({
        model_id: z.string(),
        state: z.enum(['offered', 'testing', 'failed']),
        /** Why a test failed, in a sentence. */
        detail: z.string().max(300).nullable(),
        at: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ModelLine = z.infer<typeof ModelLine>;

export const ModelChangeKind = z.enum([
  /** A model you don't have yet: offered with Add. */
  'new_model',
  /** The alias of a line moved (followed, switched by you, or gone back). */
  'line_moved',
  'price',
  'context',
  /** It gained or lost an ability NVX Ancile uses. */
  'capability',
  /** It gained an ability NVX Ancile does not use yet. */
  'unsupported_capability',
  /** The provider retired or deprecated it, or stopped listing it (three checks in a row). */
  'retired',
]);
export type ModelChangeKind = z.infer<typeof ModelChangeKind>;

export const ModelChange = z
  .object({
    id: z.string(),
    kind: ModelChangeKind,
    model_id: z.string(),
    line_id: z.string().nullable(),
    /**
     * Kind-specific before/after (Core emits exactly these shapes):
     * - price: { input_per_mtok, output_per_mtok, cached_per_mtok?, cache_write_per_mtok? } per million tokens
     * - context: { context_window, max_output } (numbers)
     * - capability, unsupported_capability: string arrays, the full ability list before and after
     * - line_moved: the model id string (before = the previous current model or null, after = the new one)
     * - new_model: before null, after null (the model is in the report's models by model_id)
     * - retired: before null, after = the id of the model that now answers in its place, or null
     */
    before: z.unknown(),
    after: z.unknown(),
    /** For line_moved: followed (by itself), chosen (by you), back (Go back), retired (its model retired). */
    reason: z.enum(['followed', 'chosen', 'back', 'retired']).nullable(),
    at: z.string(),
    seen: z.boolean(),
  })
  .strict();
export type ModelChange = z.infer<typeof ModelChange>;

/** How the last check of one provider went. */
export const ProviderCheck = z
  .object({
    provider: z.string(),
    checked_at: z.string().nullable(),
    ok: z.boolean(),
    /** A documented error code (docs/errors.md) when the last check failed. */
    error_code: z.string().nullable(),
    error_title: z.string().nullable(),
    /** No models endpoint, or the key may not list models: prices and lists stay as shipped, and the page says so. */
    unsupported: z.boolean(),
    next_at: z.string().nullable(),
    models: z.number().int().nonnegative(),
  })
  .strict();
export type ProviderCheck = z.infer<typeof ProviderCheck>;

/** GET /models/watch */
export const ModelWatchReport = z
  .object({
    providers: z.array(ProviderCheck),
    lines: z.array(ModelLine),
    models: z.array(WatchedModel),
    /** Newest first, at most 200; seen ones older than 30 days are dropped. */
    changes: z.array(ModelChange),
    /** The date the prices shipped in models.yaml were last checked by hand. */
    bundled_prices_date: z.string().nullable(),
    /** Prices for direct providers are checked against OpenRouter's public list (no key sent). */
    openrouter_prices: z.boolean(),
  })
  .strict();
export type ModelWatchReport = z.infer<typeof ModelWatchReport>;

/** POST /models/watch/check: check now (all providers, or one). Each provider at most once a minute. */
export const ModelWatchCheckRequest = z.object({ provider: z.string().max(60).optional() }).strict();
export type ModelWatchCheckRequest = z.infer<typeof ModelWatchCheckRequest>;

/** PUT /models/lines/:line_id */
export const ModelLineUpdate = z
  .object({
    follow: z.boolean().optional(),
    /** Move the alias to this model now (a model of the same line; previews allowed when you choose them). */
    use: z.string().optional(),
  })
  .strict();
export type ModelLineUpdate = z.infer<typeof ModelLineUpdate>;

/** PUT /models/watch/settings */
export const ModelWatchSettings = z.object({ openrouter_prices: z.boolean() }).strict();
export type ModelWatchSettings = z.infer<typeof ModelWatchSettings>;

/** POST /models/watch/seen */
export const ModelChangesSeen = z.object({ ids: z.array(z.string()).max(500) }).strict();
export type ModelChangesSeen = z.infer<typeof ModelChangesSeen>;

/** POST /models/watch/add: add an offered model to your list. */
export const ModelWatchAdd = z.object({ model_id: z.string() }).strict();
export type ModelWatchAdd = z.infer<typeof ModelWatchAdd>;
