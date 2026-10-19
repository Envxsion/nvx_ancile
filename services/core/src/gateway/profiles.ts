/**
 * ------------------------------------------------------------------
 *  Title    |  Provider profiles (the adapter table)
 *  Ref      |  roadmap PV3, GW1, PV1 · docs/models.md · docs/errors.md · DESIGN.md §7
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Everything that differs between model providers, as data
 *           |  in one place: where they are, what their keys look like,
 *           |  which extra headers they want, how to test a key, what
 *           |  their errors mean, where they report cache hits, and what
 *           |  they need back with a reasoning model's tool calls.
 *  How      |  One `ProviderProfile` per provider, plus a `generic`
 *           |  profile for any other OpenAI-compatible endpoint. The
 *           |  table is pure data and pure functions (no I/O). The
 *           |  gateway (providers.ts), the key tests (setup/routes.ts,
 *           |  credentials/routes.ts), the model watch (models/watch) and
 *           |  the usage reader (usage.ts) read from it, so a new provider
 *           |  is a new row. Error rules are matched by
 *           |  provider-errors.ts.
 *  Note     |  Facts come from providers' own docs, researched
 *           |  16-17 Oct 2026. A rule or field marked `confirmed: false`
 *           |  was taken from memory or a third party: it is used, but
 *           |  never as proof that a key is bad. The `cache` section is
 *           |  read by gateway/cache.ts (CA5 settings, CA12 lifetimes)
 *           |  and the `reasoning` section by gateway/replay.ts (CA1);
 *           |  CA11 will use `cache` further.
 * ------------------------------------------------------------------
 */

export type ErrorKind =
  | 'bad_key'
  | 'no_credit'
  | 'rate_limited'
  | 'overloaded'
  | 'region'
  | 'model_not_permitted'
  | 'invalid_request'
  | 'server'
  | 'unknown';

/** One way a provider says something went wrong. The first rule that matches wins. */
export interface ErrorRule {
  /** HTTP statuses it applies to; omitted: any status (MiniMax errors can arrive with 200). */
  status?: readonly number[];
  /** A code, type, reason or status string in the body (case-insensitive). With `text`: either one, unless `both`. */
  codes?: readonly (string | number)[];
  /** Matches the body's words. */
  text?: RegExp;
  /** Both `codes` and `text` must match, not either. */
  both?: boolean;
  kind: ErrorKind;
  /** False: from memory or a third party. Never proof of a bad key (see provider-errors.ts). */
  confirmed: boolean;
  /** The key may belong to another region of the same provider. */
  regionHint?: boolean;
}

export interface KeyPattern {
  /** personal, workspace, project, service_account, admin, legacy, standard, auth... */
  kind: string;
  prefix?: string;
  re?: RegExp;
  /** False: this key cannot send a chat message (an admin key). */
  usable: boolean;
  confirmed: boolean;
  /** Only this provider uses this shape, so it can be told apart without being told which provider. */
  distinct: boolean;
}

export interface ProviderRegion {
  id: string;
  label: string;
  baseUrl: string;
}

export interface KeyCheck {
  /** A list of models, a balance or key-info endpoint, or one tiny call. */
  kind: 'models' | 'balance' | 'call';
  method: 'GET' | 'POST';
  /** Added to the base URL. */
  path: string;
  confirmed: boolean;
}

export interface UsageProfile {
  /** Dotted paths in the raw `usage`, the first one present is the cache-read count. */
  hit: readonly string[];
  /** Cache-write count paths. */
  write: readonly string[];
  /** Paths that count the prompt tokens not read from cache (DeepSeek). */
  miss: readonly string[];
  /** prompt_tokens already counts cached tokens (OpenAI style). False: Anthropic style, they are extra. */
  inputIncludesCache: boolean;
  /** A streamed answer carries no usage unless the request asks (stream_options.include_usage). */
  streamNeedsIncludeUsage: boolean;
  confirmed: boolean;
}

export interface CacheProfile {
  /** automatic: the provider caches by itself. explicit: you mark blocks. both: either. */
  mode: 'automatic' | 'explicit' | 'both' | 'none';
  /** Shorter prompts are never cached; null when not published. */
  minTokens: number | null;
  /** Caching works in blocks of this many tokens; null when not published. */
  blockTokens: number | null;
  /** The cache lifetimes on offer ("5m", "1h"); empty when the provider does not say. */
  ttl: readonly string[];
  /** Writing to the cache costs more than normal input. */
  writeCostsExtra: boolean;
  /** Reading from the cache costs less (Cerebras caches for speed, not price). */
  readDiscount: boolean;
  /** A request header that routes to the same server and so raises the hit rate. */
  routingHeader?: string;
  confirmed: boolean;
}

export interface ReasoningProfile {
  /** none: nothing to send back. with_tools: send it back during a tool loop. always: send it back every turn. unknown. */
  replay: 'none' | 'with_tools' | 'always' | 'unknown';
  /** Where it travels ("reasoning_content", "thought signature"). */
  field: string | null;
  confirmed: boolean;
}

export interface HeaderContext {
  key?: string | undefined;
  /** Anthropic personal keys: the workspace the calls bill. */
  workspaceId?: string | null | undefined;
}

export interface ProviderProfile {
  id: string;
  name: string;
  /** Which AI SDK provider speaks to it. */
  sdk: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'compatible';
  /** The vendor name model-line rules and OpenRouter price matching use; null when none. */
  vendor: string | null;
  /** One endpoint: used when there are no regions. Null when the address depends on you (Cloudflare account). */
  baseUrl: string | null;
  regions: readonly ProviderRegion[] | null;
  defaultRegion: string | null;
  /** The secret that holds the key, and the environment variable that overrides it. */
  secret: string | null;
  /** Where the chosen region is kept (not a secret; the environment variable of the same name wins). */
  regionSecret: string | null;
  needsKey: boolean;
  /** Words for the key's shape, never a real key. */
  keyHint: string;
  /** The provider's own page for making a key. */
  docsUrl: string | null;
  keys: readonly KeyPattern[];
  /** Extra headers every call sends. */
  headers: (ctx: HeaderContext) => Record<string, string>;
  check: KeyCheck;
  /** Path of the model list under the base URL, or null when there is none. */
  modelsPath: string | null;
  errors: readonly ErrorRule[];
  usage: UsageProfile;
  cache: CacheProfile;
  reasoning: ReasoningProfile;
}

// ---- Shared pieces ------------------------------------------------------

/** Every name a cache hit travels under, in the order they are tried. */
export const ALL_HIT_FIELDS = [
  'prompt_tokens_details.cached_tokens',
  'prompt_cache_hit_tokens',
  'cache_read_input_tokens',
  'cached_tokens',
  'input_tokens_details.cached_tokens',
  'cachedContentTokenCount',
  'cacheReadInputTokens',
] as const;

/** Every name a cache write travels under. */
export const ALL_WRITE_FIELDS = [
  'prompt_tokens_details.cache_write_tokens',
  'cache_write_tokens',
  'cache_creation_input_tokens',
  'prompt_tokens_details.cache_creation_input_tokens',
  'input_tokens_details.cache_write_tokens',
  'cacheWriteInputTokens',
] as const;

const none = () => ({});

const OPENAI_USAGE: UsageProfile = {
  hit: ['prompt_tokens_details.cached_tokens'],
  write: ['prompt_tokens_details.cache_write_tokens'],
  miss: [],
  inputIncludesCache: true,
  streamNeedsIncludeUsage: true,
  confirmed: true,
};

const autoCache = (extra: Partial<CacheProfile> = {}): CacheProfile => ({
  mode: 'automatic',
  minTokens: null,
  blockTokens: null,
  ttl: [],
  writeCostsExtra: false,
  readDiscount: true,
  confirmed: true,
  ...extra,
});

const reasoning = (
  replay: ReasoningProfile['replay'],
  field: string | null,
  confirmed = true,
): ReasoningProfile => ({
  replay,
  field,
  confirmed,
});

const modelsCheck = (path = '/models', confirmed = true): KeyCheck => ({
  kind: 'models',
  method: 'GET',
  path,
  confirmed,
});

const callCheck: KeyCheck = { kind: 'call', method: 'POST', path: '/chat/completions', confirmed: true };

/** Words that say the key itself is the problem. A bare "API key" is not enough: that misread other problems. */
const AUTH_BODY =
  /(invalid[_ -]?(api[_ -]?(key|token)|authentication|x-api-key|token|credentials)|incorrect[_ ]api[_ ]key|authentication[_ ]?(error|failed|required)|unauthori[sz]ed|invalid_authentication|api key (is )?(not valid|invalid|expired|revoked)|api_key_invalid|invalidapikey|no auth credentials|missing (authentication|api key|authorization)|auth(entication)? failed|ip not authorized|must be a member of an organization|access_token_type_unsupported|expired)/i;

/** Words that mean a limit of money or plan, not a key problem. */
const CREDIT_BODY =
  /(insufficient[_ ](quota|balance|credits?|funds)|credit balance is too low|out of credits?|no credits?|(doesn'?t|does not|don'?t) have (any )?(credits?|funds)|exceeded your current quota|billing (hard )?limit|payment required|spend(ing)? limit|prepayment credits)/i;

const REGION_BODY =
  /(wrong region|different region|another region|region mismatch|international (site|endpoint)|(china|mainland\)?) (site|endpoint)|not supported in your (region|country)|country, region, or territory|user location is not supported)/i;

export const AUTH_BODY_RE = AUTH_BODY;
export const CREDIT_BODY_RE = CREDIT_BODY;
export const REGION_BODY_RE = REGION_BODY;

// ---- The table ----------------------------------------------------------

/** Where a personal Anthropic key's workspace is kept (Settings → API keys saves it beside the key). */
export const ANTHROPIC_WORKSPACE_SECRET = 'ANTHROPIC_WORKSPACE_ID';

const anthropic: ProviderProfile = {
  id: 'anthropic',
  name: 'Anthropic',
  sdk: 'anthropic',
  vendor: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  regions: null,
  defaultRegion: null,
  secret: 'ANTHROPIC_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with sk-ant-api03- (a workspace key) or sk-ant-usr- (a personal key)',
  docsUrl: 'https://console.anthropic.com/settings/keys',
  keys: [
    { kind: 'workspace', prefix: 'sk-ant-api03-', usable: true, confirmed: true, distinct: true },
    { kind: 'personal', prefix: 'sk-ant-usr-', usable: true, confirmed: true, distinct: true },
    // Admin keys only run the Admin API; they cannot send a message.
    { kind: 'admin', prefix: 'sk-ant-admin01-', usable: false, confirmed: true, distinct: true },
  ],
  // A personal key names the workspace to bill on every call (AK1).
  headers: (c): Record<string, string> => (c.workspaceId ? { 'anthropic-workspace-id': c.workspaceId } : {}),
  check: modelsCheck('/models?limit=1'),
  modelsPath: '/models',
  errors: [
    // An unscoped personal key: not a bad key (AK1).
    { text: /anthropic-workspace-id/i, kind: 'invalid_request', confirmed: true },
    { status: [402], codes: ['billing_error'], kind: 'no_credit', confirmed: true },
    // Org or workspace spend limit you set: a 400. The "credit balance too low" wording is observed, not documented.
    {
      status: [400],
      text: /(spend(ing)? limit|usage limit|credit balance is too low|billing)/i,
      kind: 'no_credit',
      confirmed: false,
    },
    { status: [401], codes: ['authentication_error'], kind: 'bad_key', confirmed: true },
    { status: [403], codes: ['permission_error'], kind: 'model_not_permitted', confirmed: true },
    // A tier's monthly spend cap arrives as a 429 with no retry-after: do not loop on it.
    {
      status: [429],
      text: /(monthly|spend(ing)? (cap|limit)|usage limit|workspace.*limit)/i,
      kind: 'no_credit',
      confirmed: false,
    },
    { status: [429], codes: ['rate_limit_error'], kind: 'rate_limited', confirmed: true },
    { status: [529], codes: ['overloaded_error'], kind: 'overloaded', confirmed: true },
    { status: [500, 504], codes: ['api_error', 'timeout_error'], kind: 'server', confirmed: true },
    { status: [413], codes: ['request_too_large'], kind: 'invalid_request', confirmed: true },
  ],
  usage: {
    hit: ['cache_read_input_tokens'],
    write: ['cache_creation_input_tokens'],
    miss: [],
    // input_tokens leaves out cache reads and writes: total = input + read + write.
    inputIncludesCache: false,
    streamNeedsIncludeUsage: false,
    confirmed: true,
  },
  // CA5 (gateway/cache.ts) sets the cache_control markers from this.
  cache: {
    mode: 'both',
    // Differs by model: 512 (newest), 1024, 2048 or 4096; the strictest is listed.
    minTokens: 4096,
    blockTokens: null,
    ttl: ['5m', '1h'],
    writeCostsExtra: true,
    readDiscount: true,
    confirmed: true,
  },
  reasoning: reasoning('with_tools', 'thinking blocks, returned unmodified'),
};

const openai: ProviderProfile = {
  id: 'openai',
  name: 'OpenAI',
  sdk: 'openai',
  vendor: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  regions: null,
  defaultRegion: null,
  secret: 'OPENAI_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with sk-proj- (project), sk-svcacct- (service account) or sk-',
  docsUrl: 'https://platform.openai.com/api-keys',
  keys: [
    { kind: 'project', prefix: 'sk-proj-', usable: true, confirmed: true, distinct: true },
    { kind: 'service_account', prefix: 'sk-svcacct-', usable: true, confirmed: true, distinct: true },
    { kind: 'admin', prefix: 'sk-admin-', usable: false, confirmed: false, distinct: true },
    { kind: 'legacy', prefix: 'sk-', usable: true, confirmed: true, distinct: false },
  ],
  headers: none,
  check: modelsCheck(),
  modelsPath: '/models',
  errors: [
    // Out of credit is a 429, not a 402: told apart by the code.
    {
      status: [429],
      codes: [
        'credit_balance_exhausted',
        'organization_spend_limit_exceeded',
        'project_spend_limit_exceeded',
        'organization_usage_limit_exceeded',
        'insufficient_quota',
      ],
      kind: 'no_credit',
      confirmed: true,
    },
    { status: [429], kind: 'rate_limited', confirmed: true },
    {
      status: [403],
      codes: ['unsupported_country_region_territory'],
      text: /country, region, or territory not supported/i,
      kind: 'region',
      confirmed: false,
    },
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true },
    { status: [503], codes: ['server_is_overloaded'], kind: 'overloaded', confirmed: true },
  ],
  usage: { ...OPENAI_USAGE },
  // TODO(phase-0.1.1): CA11 uses prompt_cache_key and the 30m option on GPT-5.6+.
  cache: autoCache({ minTokens: 1024, blockTokens: 128, ttl: ['in_memory', '24h', '30m'] }),
  reasoning: reasoning('none', 'reasoning items (Responses API only; Chat Completions returns none)'),
};

const google: ProviderProfile = {
  id: 'google',
  name: 'Google',
  sdk: 'google',
  vendor: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  regions: null,
  defaultRegion: null,
  secret: 'GOOGLE_GENERATIVE_AI_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with AIza (older keys) or AQ. (newer keys)',
  docsUrl: 'https://aistudio.google.com/apikey',
  keys: [
    { kind: 'standard', prefix: 'AIza', usable: true, confirmed: true, distinct: true },
    // New AI Studio keys since 2026-05-28; the prefix comes from community threads.
    { kind: 'auth', prefix: 'AQ.', usable: true, confirmed: false, distinct: true },
  ],
  headers: none,
  check: modelsCheck('/models?pageSize=1'),
  modelsPath: '/models',
  errors: [
    // Prepaid credits ran out (was a 429 before 2026; community reports of false 402s).
    { status: [402], kind: 'no_credit', confirmed: true },
    { status: [400], codes: ['api_key_invalid'], kind: 'bad_key', confirmed: false },
    {
      status: [400],
      codes: ['failed_precondition'],
      both: true,
      text: /(billing|prepay)/i,
      kind: 'no_credit',
      confirmed: false,
    },
    {
      status: [400],
      codes: ['failed_precondition'],
      both: true,
      text: /(location|region|country)/i,
      kind: 'region',
      confirmed: false,
    },
    {
      status: [403],
      text: /(api key|unregistered callers|access_token_type_unsupported|api_key_service_blocked)/i,
      kind: 'bad_key',
      confirmed: false,
    },
    { status: [429], codes: ['resource_exhausted'], kind: 'rate_limited', confirmed: true },
    { status: [503], codes: ['unavailable'], kind: 'overloaded', confirmed: true },
  ],
  usage: {
    hit: ['cachedContentTokenCount', 'prompt_tokens_details.cached_tokens', 'total_cached_tokens'],
    write: [],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: false,
    confirmed: false,
  },
  cache: autoCache({ minTokens: 4096, ttl: ['1h'], confirmed: false }),
  reasoning: reasoning('with_tools', 'thought signature on each function call', false),
};

const openrouter: ProviderProfile = {
  id: 'openrouter',
  name: 'OpenRouter',
  sdk: 'openrouter',
  vendor: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  regions: null,
  defaultRegion: null,
  secret: 'OPENROUTER_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with sk-or-v1-',
  docsUrl: 'https://openrouter.ai/keys',
  keys: [{ kind: 'standard', prefix: 'sk-or-v1-', usable: true, confirmed: false, distinct: true }],
  headers: none,
  check: { kind: 'balance', method: 'GET', path: '/key', confirmed: true },
  modelsPath: '/models',
  errors: [
    // Insufficient credits; may carry Retry-After when caused by an in-flight budget.
    { status: [402], kind: 'no_credit', confirmed: true },
    { status: [401], kind: 'bad_key', text: AUTH_BODY, confirmed: true },
    { status: [403], text: /(moderation|flagged)/i, kind: 'invalid_request', confirmed: true },
    { status: [408, 502], kind: 'server', confirmed: true },
    { status: [503], kind: 'server', confirmed: true },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: {
    hit: ['prompt_tokens_details.cached_tokens'],
    write: ['prompt_tokens_details.cache_write_tokens'],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: false, // always included; the flag is a deprecated no-op
    confirmed: true,
  },
  cache: autoCache({ mode: 'both' }),
  reasoning: reasoning('with_tools', 'reasoning_details'),
};

const deepseek: ProviderProfile = {
  id: 'deepseek',
  name: 'DeepSeek',
  sdk: 'compatible',
  vendor: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  regions: null,
  defaultRegion: null,
  secret: 'DEEPSEEK_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with sk-',
  docsUrl: 'https://platform.deepseek.com/api_keys',
  keys: [{ kind: 'standard', prefix: 'sk-', usable: true, confirmed: false, distinct: false }],
  headers: none,
  check: modelsCheck('/models'),
  modelsPath: '/models',
  errors: [
    { status: [401], kind: 'bad_key', text: AUTH_BODY, confirmed: true },
    { status: [402], kind: 'no_credit', confirmed: true },
    { status: [400, 422], kind: 'invalid_request', confirmed: true },
    { status: [429], kind: 'rate_limited', confirmed: true },
    { status: [503], kind: 'overloaded', confirmed: true },
  ],
  usage: {
    hit: ['prompt_cache_hit_tokens', 'prompt_tokens_details.cached_tokens'],
    write: [],
    miss: ['prompt_cache_miss_tokens'],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: true,
  },
  cache: autoCache({ ttl: [] }),
  // With tools, reasoning_content must come back on every later request, or the API answers 400.
  reasoning: reasoning('with_tools', 'reasoning_content'),
};

const moonshot: ProviderProfile = {
  id: 'moonshot',
  name: 'Moonshot (Kimi)',
  sdk: 'compatible',
  vendor: 'moonshot',
  baseUrl: null,
  regions: [
    { id: 'global', label: 'International (platform.kimi.ai)', baseUrl: 'https://api.moonshot.ai/v1' },
    { id: 'china', label: 'China (platform.moonshot.cn)', baseUrl: 'https://api.moonshot.cn/v1' },
  ],
  defaultRegion: 'global',
  secret: 'MOONSHOT_API_KEY',
  regionSecret: 'MOONSHOT_REGION',
  needsKey: true,
  keyHint: 'starts with sk-',
  docsUrl: 'https://platform.kimi.ai/console/api-keys',
  keys: [{ kind: 'standard', prefix: 'sk-', usable: true, confirmed: false, distinct: false }],
  headers: none,
  check: modelsCheck('/models'),
  modelsPath: '/models',
  errors: [
    {
      status: [401],
      codes: ['invalid_authentication_error', 'incorrect_api_key_error'],
      kind: 'bad_key',
      confirmed: true,
      regionHint: true,
    },
    {
      status: [403],
      codes: ['permission_denied_error'],
      both: true,
      text: /(\bip\b|allowlist|whitelist|region|country|not available)/i,
      kind: 'region',
      confirmed: false,
    },
    { status: [403], codes: ['permission_denied_error'], kind: 'model_not_permitted', confirmed: false },
    // "Not found" is also what a model you may not use looks like.
    { status: [404], codes: ['resource_not_found_error'], kind: 'model_not_permitted', confirmed: false },
    { status: [429], codes: ['exceeded_current_quota_error'], kind: 'no_credit', confirmed: true },
    { status: [429], codes: ['engine_overloaded_error'], kind: 'overloaded', confirmed: true },
    { status: [429], codes: ['rate_limit_reached_error'], kind: 'rate_limited', confirmed: true },
    {
      status: [400],
      codes: ['content_filter', 'invalid_request_error'],
      kind: 'invalid_request',
      confirmed: true,
    },
    { status: [500, 504], codes: ['server_error', 'unexpected_output'], kind: 'server', confirmed: true },
  ],
  usage: {
    // Older models also report a top-level cached_tokens.
    hit: ['prompt_tokens_details.cached_tokens', 'cached_tokens'],
    write: ['prompt_tokens_details.cache_write_tokens'],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: true,
  },
  cache: autoCache({ ttl: ['5m', '1h'], writeCostsExtra: true }),
  reasoning: reasoning('always', 'reasoning_content'),
};

const minimax: ProviderProfile = {
  id: 'minimax',
  name: 'MiniMax',
  sdk: 'compatible',
  vendor: 'minimax',
  baseUrl: null,
  regions: [
    { id: 'global', label: 'Global (platform.minimax.io)', baseUrl: 'https://api.minimax.io/v1' },
    { id: 'china', label: 'China (platform.minimax.cn)', baseUrl: 'https://api.minimax.cn/v1' },
  ],
  defaultRegion: 'global',
  secret: 'MINIMAX_API_KEY',
  regionSecret: 'MINIMAX_REGION',
  needsKey: true,
  keyHint: 'a long key; copy all of it',
  docsUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  // A long JWT-style secret (unconfirmed).
  keys: [
    {
      kind: 'standard',
      re: /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/,
      usable: true,
      confirmed: false,
      distinct: true,
    },
  ],
  headers: none,
  check: modelsCheck('/models', false),
  modelsPath: '/models',
  errors: [
    // Errors can come with HTTP 200: base_resp.status_code is the truth (transport unconfirmed).
    { codes: [1008, 2056], kind: 'no_credit', confirmed: true },
    { codes: [2049, 1004], kind: 'bad_key', confirmed: false, regionHint: true },
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true, regionHint: true },
    { codes: [1002], kind: 'rate_limited', confirmed: true },
    { codes: [1000, 1001], kind: 'server', confirmed: true },
    { codes: [1027, 1039, 2013], kind: 'invalid_request', confirmed: true },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: {
    hit: ['prompt_tokens_details.cached_tokens', 'cache_read_input_tokens'],
    write: ['cache_creation_input_tokens'],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: false,
  },
  cache: autoCache({ minTokens: 512, writeCostsExtra: false }),
  // Keep the whole assistant message, <think> included; stripping it breaks tool loops.
  reasoning: reasoning('always', 'reasoning_content (or <think> in content)'),
};

const qwen: ProviderProfile = {
  id: 'qwen',
  name: 'Qwen (Alibaba Model Studio)',
  sdk: 'compatible',
  vendor: 'qwen',
  baseUrl: null,
  // Workspace hosts ({workspace}.{region}.maas.aliyuncs.com) need a custom base URL on the model.
  regions: [
    {
      id: 'singapore',
      label: 'Singapore / international',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
    { id: 'beijing', label: 'China (Beijing)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'us', label: 'US (Virginia)', baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
  ],
  defaultRegion: 'singapore',
  secret: 'DASHSCOPE_API_KEY',
  regionSecret: 'DASHSCOPE_REGION',
  needsKey: true,
  keyHint: 'starts with sk-; a key only works in the region it was made in',
  docsUrl: 'https://modelstudio.console.alibabacloud.com/model/settings/api-key',
  keys: [{ kind: 'standard', prefix: 'sk-', usable: true, confirmed: false, distinct: false }],
  headers: none,
  check: modelsCheck('/models', false),
  modelsPath: '/models',
  errors: [
    // Overdue payment is a 400.
    { codes: ['arrearage'], kind: 'no_credit', confirmed: true },
    { status: [403], codes: ['allocationquota.freetieronly'], kind: 'no_credit', confirmed: true },
    { status: [403], codes: ['model.accessdenied'], kind: 'model_not_permitted', confirmed: true },
    {
      status: [404],
      codes: ['modelnotfound'],
      kind: 'model_not_permitted',
      confirmed: true,
      regionHint: true,
    },
    {
      status: [429],
      codes: ['throttling.ratequota', 'throttling.allocationquota', 'throttling.burstrate', 'throttling'],
      kind: 'rate_limited',
      confirmed: true,
    },
    // A key from another region answers 401 InvalidApiKey: say so when the body does, else a bad key with a region hint.
    { status: [401], text: REGION_BODY, kind: 'region', confirmed: false },
    {
      status: [401],
      codes: ['invalidapikey', 'invalid_api_key'],
      kind: 'bad_key',
      confirmed: true,
      regionHint: true,
    },
  ],
  usage: {
    hit: ['prompt_tokens_details.cached_tokens'],
    write: ['prompt_tokens_details.cache_creation_input_tokens', 'cache_creation_input_tokens'],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: false,
  },
  // Implicit: 1024 minimum, hits at about 20%, no write fee. Explicit cache_control: 125% write, 10% hit.
  cache: autoCache({ mode: 'both', minTokens: 1024, ttl: ['5m'], confirmed: true }),
  reasoning: reasoning('with_tools', 'reasoning_content (with preserve_thinking)'),
};

const zai: ProviderProfile = {
  id: 'zai',
  name: 'Z.ai (GLM)',
  sdk: 'compatible',
  vendor: 'zai',
  baseUrl: null,
  // The Coding Plan's quota only works on https://api.z.ai/api/coding/paas/v4 (give a model that base_url).
  regions: [
    { id: 'international', label: 'International (z.ai)', baseUrl: 'https://api.z.ai/api/paas/v4' },
    { id: 'china', label: 'China (bigmodel.cn)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  ],
  defaultRegion: 'international',
  secret: 'ZAI_API_KEY',
  regionSecret: 'ZAI_REGION',
  needsKey: true,
  keyHint: 'two parts joined by a dot; copy all of it',
  docsUrl: 'https://z.ai/manage-apikey/apikey-list',
  keys: [
    {
      kind: 'standard',
      re: /^[0-9a-f]{20,40}\.[A-Za-z0-9]{8,40}$/,
      usable: true,
      confirmed: false,
      distinct: true,
    },
  ],
  headers: none,
  // No models endpoint is documented: a one-token call on a flash model.
  check: callCheck,
  modelsPath: null,
  errors: [
    // Billing and rate limits share HTTP 429: the body's code tells them apart.
    { status: [429], codes: [1113], kind: 'no_credit', confirmed: true },
    {
      status: [429],
      codes: [1308, 1309, 1310, 1312, 1313, 1314, 1315, 1316, 1317, 1318, 1319, 1320, 1321],
      kind: 'no_credit',
      confirmed: true,
    },
    // The plan does not include this model: still a 429.
    { status: [429], codes: [1311], kind: 'model_not_permitted', confirmed: true },
    { status: [429], codes: [1305], kind: 'overloaded', confirmed: true },
    { status: [429], codes: [1302], kind: 'rate_limited', confirmed: true },
    { status: [403], codes: [1220], kind: 'model_not_permitted', confirmed: true },
    { status: [401], codes: [1000, 1001, 1003, 1005], kind: 'bad_key', confirmed: true, regionHint: true },
    {
      status: [400],
      codes: [1210, 1211, 1212, 1213, 1214, 1215, 1261],
      kind: 'invalid_request',
      confirmed: true,
    },
  ],
  usage: {
    hit: ['prompt_tokens_details.cached_tokens'],
    write: [],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: true,
  },
  cache: autoCache({ confirmed: false }),
  reasoning: reasoning('with_tools', 'reasoning_content (complete and unmodified)'),
};

const xai: ProviderProfile = {
  id: 'xai',
  name: 'xAI (Grok)',
  sdk: 'compatible',
  vendor: 'xai',
  baseUrl: 'https://api.x.ai/v1',
  regions: null,
  defaultRegion: null,
  secret: 'XAI_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with xai-',
  docsUrl: 'https://console.x.ai',
  keys: [{ kind: 'standard', prefix: 'xai-', usable: true, confirmed: false, distinct: true }],
  headers: none,
  check: modelsCheck('/models'),
  modelsPath: '/models',
  errors: [
    // Observed, not documented: 403 "team doesn't have any credits".
    { status: [403], text: CREDIT_BODY, kind: 'no_credit', confirmed: false },
    // Observed: a wrong key answered as 400 "Incorrect API key provided".
    { status: [400], text: /incorrect api key/i, kind: 'bad_key', confirmed: false },
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: { ...OPENAI_USAGE, write: [], confirmed: true },
  cache: autoCache({ routingHeader: 'x-grok-conv-id' }),
  reasoning: reasoning('none', null, false),
};

const mistral: ProviderProfile = {
  id: 'mistral',
  name: 'Mistral',
  sdk: 'compatible',
  vendor: 'mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  regions: null,
  defaultRegion: null,
  secret: 'MISTRAL_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'a 32-character key with no prefix',
  docsUrl: 'https://console.mistral.ai/api-keys',
  keys: [{ kind: 'standard', re: /^[A-Za-z0-9]{32}$/, usable: true, confirmed: false, distinct: false }],
  headers: none,
  check: modelsCheck('/models'),
  modelsPath: '/models',
  errors: [
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true },
    { status: [402], kind: 'no_credit', confirmed: false },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: { ...OPENAI_USAGE, write: [] },
  cache: autoCache({ confirmed: true }),
  reasoning: reasoning('none', null, false),
};

const groq: ProviderProfile = {
  id: 'groq',
  name: 'Groq',
  sdk: 'compatible',
  vendor: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  regions: null,
  defaultRegion: null,
  secret: 'GROQ_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with gsk_',
  docsUrl: 'https://console.groq.com/keys',
  keys: [{ kind: 'standard', prefix: 'gsk_', usable: true, confirmed: false, distinct: true }],
  headers: none,
  check: modelsCheck(),
  modelsPath: '/models',
  errors: [
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true },
    // Flex tier out of capacity.
    { status: [498], kind: 'overloaded', confirmed: true },
    { status: [413], kind: 'invalid_request', confirmed: true },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: { ...OPENAI_USAGE, write: [], confirmed: false },
  // Only the GPT-OSS models cache; 50% off hits, idle for 2 hours expires them.
  cache: autoCache({ minTokens: 128, ttl: ['2h'], confirmed: true }),
  reasoning: reasoning('none', 'message.reasoning', false),
};

const together: ProviderProfile = {
  id: 'together',
  name: 'Together AI',
  sdk: 'compatible',
  vendor: 'together',
  baseUrl: 'https://api.together.xyz/v1',
  regions: null,
  defaultRegion: null,
  secret: 'TOGETHER_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'a long key with no fixed start',
  docsUrl: 'https://api.together.ai/settings/api-keys',
  keys: [],
  headers: none,
  check: modelsCheck(),
  modelsPath: '/models',
  errors: [
    { status: [402], kind: 'no_credit', confirmed: true },
    // Together answers 403 when the context is too long.
    {
      status: [403],
      text: /(context length|max_tokens|maximum context)/i,
      kind: 'invalid_request',
      confirmed: true,
    },
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: {
    // Some models report a top-level cached_tokens: read both.
    hit: ['prompt_tokens_details.cached_tokens', 'cached_tokens'],
    write: [],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: false,
  },
  cache: autoCache({ ttl: ['1h'], confirmed: false }),
  reasoning: reasoning('unknown', null, false),
};

const fireworks: ProviderProfile = {
  id: 'fireworks',
  name: 'Fireworks',
  sdk: 'compatible',
  vendor: 'fireworks',
  baseUrl: 'https://api.fireworks.ai/inference/v1',
  regions: null,
  defaultRegion: null,
  secret: 'FIREWORKS_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with fw_',
  docsUrl: 'https://fireworks.ai/account/api-keys',
  keys: [{ kind: 'standard', prefix: 'fw_', usable: true, confirmed: false, distinct: true }],
  headers: none,
  check: modelsCheck('/models', false),
  modelsPath: '/models',
  errors: [
    // Observed: 412 for a spending limit or no payment method.
    { status: [412], kind: 'no_credit', confirmed: false },
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: {
    // The counts also arrive in response headers (fireworks-cached-prompt-tokens), which this reader does not see.
    hit: ['prompt_tokens_details.cached_tokens'],
    write: [],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: false,
  },
  cache: autoCache({ routingHeader: 'x-session-affinity', confirmed: false }),
  reasoning: reasoning('unknown', 'reasoning_content', false),
};

const cerebras: ProviderProfile = {
  id: 'cerebras',
  name: 'Cerebras',
  sdk: 'compatible',
  vendor: 'cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
  regions: null,
  defaultRegion: null,
  secret: 'CEREBRAS_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with csk-',
  docsUrl: 'https://cloud.cerebras.ai',
  keys: [{ kind: 'standard', prefix: 'csk-', usable: true, confirmed: false, distinct: true }],
  headers: none,
  check: modelsCheck(),
  modelsPath: '/models',
  errors: [
    { status: [402], kind: 'no_credit', confirmed: true },
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: { ...OPENAI_USAGE, write: [] },
  // Caching saves time, not money: a hit is not a saving.
  cache: autoCache({ blockTokens: 128, ttl: ['5m'], readDiscount: false }),
  reasoning: reasoning('unknown', null, false),
};

const cloudflare: ProviderProfile = {
  id: 'cloudflare',
  name: 'Cloudflare Workers AI',
  sdk: 'compatible',
  vendor: 'cloudflare',
  // https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1: needs your account ID, so a model gives its base_url.
  baseUrl: null,
  regions: null,
  defaultRegion: null,
  secret: 'CLOUDFLARE_API_TOKEN',
  regionSecret: null,
  needsKey: true,
  keyHint: 'a Cloudflare API token',
  docsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  keys: [],
  headers: none,
  check: { kind: 'call', method: 'POST', path: '/chat/completions', confirmed: false },
  modelsPath: null,
  errors: [
    { status: [401, 403], codes: [10000, 9106, 9109], kind: 'bad_key', confirmed: false },
    // Daily free allocation of neurons used up (code from memory).
    { codes: [4006], kind: 'no_credit', confirmed: false },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: { ...OPENAI_USAGE, write: [], confirmed: false },
  cache: autoCache({ routingHeader: 'x-session-affinity', confirmed: false }),
  reasoning: reasoning('unknown', null, false),
};

const perplexity: ProviderProfile = {
  id: 'perplexity',
  name: 'Perplexity',
  sdk: 'compatible',
  vendor: 'perplexity',
  // Sonar chat ended 2026-09-27. The Orchestrator API (private preview) speaks OpenAI Chat here.
  baseUrl: 'https://api.perplexity.ai/router/v1',
  regions: null,
  defaultRegion: null,
  secret: 'PERPLEXITY_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'starts with pplx-',
  docsUrl: 'https://www.perplexity.ai/settings/api',
  keys: [{ kind: 'standard', prefix: 'pplx-', usable: true, confirmed: false, distinct: true }],
  headers: none,
  check: modelsCheck('/models', false),
  modelsPath: '/models',
  errors: [
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true },
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: { ...OPENAI_USAGE, write: [], confirmed: false },
  cache: { ...autoCache({ confirmed: false }), mode: 'automatic' },
  reasoning: reasoning('unknown', null, false),
};

const cohere: ProviderProfile = {
  id: 'cohere',
  name: 'Cohere',
  sdk: 'compatible',
  vendor: 'cohere',
  // The OpenAI-compatible API (unconfirmed this pass); the native v2 chat is a different shape.
  baseUrl: 'https://api.cohere.ai/compatibility/v1',
  regions: null,
  defaultRegion: null,
  secret: 'COHERE_API_KEY',
  regionSecret: null,
  needsKey: true,
  keyHint: 'a long key with no fixed start',
  docsUrl: 'https://dashboard.cohere.com/api-keys',
  keys: [],
  headers: none,
  check: modelsCheck('/models', false),
  modelsPath: '/models',
  errors: [
    { status: [401], text: AUTH_BODY, kind: 'bad_key', confirmed: true },
    // Trial keys are rate limited, not out of credit.
    { status: [429], kind: 'rate_limited', confirmed: true },
  ],
  usage: {
    hit: ['cached_tokens', 'prompt_tokens_details.cached_tokens'],
    write: [],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: false,
  },
  cache: autoCache({ confirmed: false }),
  reasoning: reasoning('none', 'tool_plan', false),
};

/** Ollama, LM Studio and vLLM on this computer or your network. No key, no bill. */
const ollama: ProviderProfile = {
  id: 'ollama',
  name: 'Local server (Ollama, LM Studio, vLLM)',
  sdk: 'compatible',
  vendor: null,
  baseUrl: 'http://localhost:11434/v1',
  regions: null,
  defaultRegion: null,
  secret: null,
  regionSecret: null,
  needsKey: false,
  keyHint: 'no key needed',
  docsUrl: null,
  keys: [],
  headers: none,
  check: modelsCheck(),
  modelsPath: '/models',
  errors: [],
  usage: {
    // Ollama reports none; vLLM only with --enable-prompt-tokens-details.
    hit: ['prompt_tokens_details.cached_tokens'],
    write: [],
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: false,
  },
  cache: { ...autoCache({ confirmed: false }), readDiscount: false },
  reasoning: reasoning('none', 'reasoning', false),
};

/**
 * Any other OpenAI-compatible endpoint. Caching is assumed automatic; the
 * cache read is taken from every name providers are known to use, and a call
 * that carries none is reported as "not reported" (CA0), never as zero. Errors
 * are read conservatively: a key is only rejected on a 401 or 403 whose body
 * sounds like authentication.
 */
const generic: ProviderProfile = {
  id: 'generic',
  name: 'OpenAI-compatible endpoint',
  sdk: 'compatible',
  vendor: null,
  baseUrl: null,
  regions: null,
  defaultRegion: null,
  secret: null,
  regionSecret: null,
  needsKey: false,
  keyHint: 'whatever your endpoint gives you',
  docsUrl: null,
  keys: [],
  headers: none,
  check: modelsCheck('/models', false),
  modelsPath: '/models',
  errors: [],
  usage: {
    hit: ALL_HIT_FIELDS,
    write: ALL_WRITE_FIELDS,
    miss: [],
    inputIncludesCache: true,
    streamNeedsIncludeUsage: true,
    confirmed: false,
  },
  cache: autoCache({ confirmed: false }),
  reasoning: reasoning('unknown', null, false),
};

/** Every provider with a profile, in the order the Cockpit lists them. */
export const PROFILES: readonly ProviderProfile[] = [
  anthropic,
  openai,
  google,
  openrouter,
  deepseek,
  moonshot,
  minimax,
  qwen,
  zai,
  xai,
  mistral,
  groq,
  together,
  fireworks,
  cerebras,
  cloudflare,
  perplexity,
  cohere,
  ollama,
  generic,
];

/** Other names for the same profile (models.yaml may say lmstudio or vllm). */
const ALIASES: Record<string, string> = {
  lmstudio: 'ollama',
  'lm-studio': 'ollama',
  vllm: 'ollama',
  dashscope: 'qwen',
  alibaba: 'qwen',
  kimi: 'moonshot',
  glm: 'zai',
  'z-ai': 'zai',
  grok: 'xai',
};

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));

/** The profile for a provider name; the generic one for any name that has none. */
export function profileFor(provider: string): ProviderProfile {
  return BY_ID.get(provider) ?? BY_ID.get(ALIASES[provider] ?? '') ?? generic;
}

/** The profile for a provider name, or undefined when there is none (unlike profileFor, never the generic one). */
export function knownProfile(provider: string): ProviderProfile | undefined {
  return BY_ID.get(provider) ?? BY_ID.get(ALIASES[provider] ?? '');
}

export const GENERIC_PROFILE = generic;

/** Provider id to the secret that holds its key (replaces the per-provider switch). */
export const DEFAULT_SECRET: Record<string, string> = Object.fromEntries(
  PROFILES.filter((p) => p.secret).map((p) => [p.id, p.secret as string]),
);

/** The first-class key-billed providers that Settings → API keys can save (PV1). */
export const FIRST_CLASS_IDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'deepseek',
  'moonshot',
  'minimax',
  'zai',
  'qwen',
  'xai',
  'mistral',
] as const;

// ---- Regions and addresses ---------------------------------------------

/** The region a profile uses: the one named when it exists, else the default; null when it has none. */
export function regionOf(profile: ProviderProfile, region?: string | null): ProviderRegion | null {
  if (!profile.regions) return null;
  return (
    profile.regions.find((r) => r.id === region) ??
    profile.regions.find((r) => r.id === profile.defaultRegion) ??
    profile.regions[0] ??
    null
  );
}

export const isRegion = (profile: ProviderProfile, region: string): boolean =>
  !!profile.regions?.some((r) => r.id === region);

/** Where to call: the region's address, else the profile's one address, else null. */
export function baseUrlFor(profile: ProviderProfile, region?: string | null): string | null {
  return regionOf(profile, region)?.baseUrl ?? profile.baseUrl;
}

/** The other regions' labels, for "try the China site". */
export function otherRegions(profile: ProviderProfile, region?: string | null): ProviderRegion[] {
  const here = regionOf(profile, region);
  return (profile.regions ?? []).filter((r) => r.id !== here?.id);
}

// ---- Keys ---------------------------------------------------------------

export interface RecognisedKey {
  provider: string;
  kind: string;
  /** Set when the shape says which region (none do today: keys of two regions look alike). */
  region?: string;
  /** False: an admin key, which cannot send a message. */
  usable: boolean;
  confirmed: boolean;
}

const matches = (p: KeyPattern, key: string): boolean =>
  p.prefix ? key.startsWith(p.prefix) : p.re ? p.re.test(key) : false;

/**
 * What a key is, from its shape alone. Only shapes that one provider uses are
 * recognised by themselves (sk-ant-, sk-proj-, AIza...); a bare `sk-` is
 * DeepSeek's, Moonshot's, Qwen's and OpenAI's, so it is only read when you say
 * which provider (`within`). Returns the provider, the kind and nothing of the
 * key itself.
 */
export function recogniseKey(rawKey: string, within?: string): RecognisedKey | null {
  const key = rawKey.trim();
  if (!key) return null;
  const distinct: { profile: ProviderProfile; pattern: KeyPattern }[] = [];
  for (const profile of PROFILES)
    for (const pattern of profile.keys) if (pattern.distinct) distinct.push({ profile, pattern });
  // Longest prefix first: sk-ant-api03- before anything shorter; regular expressions last.
  distinct.sort((a, b) => (b.pattern.prefix?.length ?? 0) - (a.pattern.prefix?.length ?? 0));
  for (const { profile, pattern } of distinct)
    if (matches(pattern, key))
      return {
        provider: profile.id,
        kind: pattern.kind,
        usable: pattern.usable,
        confirmed: pattern.confirmed,
      };
  if (within) {
    const own = knownProfile(within);
    const pattern = own?.keys.find((p) => !p.distinct && matches(p, key));
    if (own && pattern)
      return { provider: own.id, kind: pattern.kind, usable: pattern.usable, confirmed: pattern.confirmed };
  }
  return null;
}

// ---- Usage and cache ----------------------------------------------------

/** A number at a dotted path of a raw usage object, or undefined. */
export function numberAt(obj: unknown, path: string): number | undefined {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : undefined;
}

/** The first of `paths` that holds a number. */
export function firstNumber(obj: unknown, paths: readonly string[]): number | undefined {
  for (const p of paths) {
    const n = numberAt(obj, p);
    if (n !== undefined) return n;
  }
  return undefined;
}

// ---- The Cockpit's list --------------------------------------------------

/** First-class providers a key can be saved for via /credentials/:id. */
const CREDENTIAL_IDS = new Set<string>(FIRST_CLASS_IDS);

export function providerInfo(p: ProviderProfile) {
  return {
    id: p.id,
    name: p.name,
    regions: p.regions ? p.regions.map((r) => ({ id: r.id, label: r.label })) : null,
    default_region: p.defaultRegion,
    key_hint: p.keyHint,
    docs_url: p.docsUrl,
    has_models_list: p.modelsPath !== null,
    credential_id: CREDENTIAL_IDS.has(p.id) ? p.id : null,
    needs_key: p.needsKey,
  };
}
