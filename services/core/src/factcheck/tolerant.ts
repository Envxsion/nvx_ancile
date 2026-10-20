/**
 * ------------------------------------------------------------------
 *  Title    |  Reading a model's JSON reply tolerantly
 *  Ref      |  DESIGN.md §10 · prompts/factcheck/*
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A model that understood the task but dressed its answer
 *           |  a little differently ({"claimVerdict": {...}}, "SUPPORTED",
 *           |  confidence 85) still gave an answer. Read it before
 *           |  throwing it away, so one model's habit does not walk the
 *           |  whole chain and spend a call per model.
 *  How      |  parseJsonValue finds the object (or list) in the text.
 *           |  tolerantVerdict / tolerantClaims unwrap a single wrapper
 *           |  key, accept the usual synonyms for a field, and coerce
 *           |  the enums without regard to case. They never invent a
 *           |  value: what cannot be read is left for the schema to
 *           |  refuse, and the caller then asks once more (steps.ts).
 * ------------------------------------------------------------------
 */

/** How the message that asks a model to answer again begins; the offline model reads the first prompt past it. */
export const REPAIR_LEAD = 'That reply could not be used';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The first JSON object (or, failing that, list) in a reply, fences and chatter around it ignored. */
export function parseJsonValue(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(t);
  if (whole !== undefined && typeof whole === 'object' && whole !== null) return whole;
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = t.indexOf(open);
    const end = t.lastIndexOf(close);
    if (start >= 0 && end > start) {
      const v = tryParse(t.slice(start, end + 1));
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/**
 * {"claimVerdict": {...}} to {...}: while an object has one key, that key is not a field we know, and
 * its value is an object (or JSON text of one), look inside. At most three layers.
 */
export function unwrap(value: unknown, known: readonly string[]): unknown {
  let v = value;
  for (let depth = 0; depth < 3; depth++) {
    if (!isObj(v)) break;
    const keys = Object.keys(v);
    if (keys.length !== 1 || known.includes(keys[0] as string)) break;
    let inner = v[keys[0] as string];
    if (typeof inner === 'string') inner = parseJsonValue(inner);
    if (!isObj(inner)) break;
    v = inner;
  }
  return v;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .replace(/[."']/g, '')
    .trim();

const SUPPORTED = new Set([
  'supported',
  'support',
  'supports',
  'true',
  'yes',
  'correct',
  'entailed',
  'verified',
  'confirmed',
  'accurate',
  'holds',
]);
const CONTRADICTED = new Set([
  'contradicted',
  'contradict',
  'contradicts',
  'false',
  'no',
  'incorrect',
  'refuted',
  'wrong',
  'inaccurate',
  'disproved',
  'doesnt hold',
]);
const INSUFFICIENT = new Set([
  'insufficient',
  'insufficient evidence',
  'unverified',
  'unclear',
  'unknown',
  'unsure',
  'uncertain',
  'neutral',
  'inconclusive',
  'cannot tell',
  'cant tell',
  'not enough information',
  'not enough info',
  'partly',
  'partial',
  'mixed',
  'nei',
]);

/** supported, contradicted or insufficient from the usual ways a model says it; undefined when it says none. */
export function coerceStance(v: unknown): 'supported' | 'contradicted' | 'insufficient' | undefined {
  if (v === true) return 'supported';
  if (v === false) return 'contradicted';
  if (typeof v !== 'string') return undefined;
  const w = norm(v);
  if (SUPPORTED.has(w)) return 'supported';
  if (CONTRADICTED.has(w)) return 'contradicted';
  if (INSUFFICIENT.has(w)) return 'insufficient';
  return undefined;
}

function itemStance(v: unknown): 'supports' | 'contradicts' | 'neutral' | undefined {
  const s = coerceStance(v);
  if (s === 'supported') return 'supports';
  if (s === 'contradicted') return 'contradicts';
  if (s === 'insufficient') return 'neutral';
  return undefined;
}

function confidenceOf(v: unknown): number | undefined {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(%?)\s*$/.exec(v);
    if (!m) return undefined;
    n = Number(m[1]) / (m[2] ? 100 : 1);
    if (m[2]) return n >= 0 && n <= 1 ? n : undefined;
  } else return undefined;
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (n <= 1) return n;
  return n <= 100 ? n / 100 : undefined;
}

export const VERDICT_FIELDS = ['stance', 'evidence', 'rationale', 'confidence'] as const;

/** A claim verdict as the schema expects it, from a reply that may be dressed differently. */
export function tolerantVerdict(raw: unknown): unknown {
  const v = unwrap(raw, VERDICT_FIELDS);
  if (!isObj(v)) return v;
  const stance = coerceStance(
    v.stance ?? v.verdict ?? v.result ?? v.label ?? v.judgement ?? v.judgment ?? v.answer,
  );
  const rationale = v.rationale ?? v.reasoning ?? v.explanation ?? v.reason;
  const evidence = Array.isArray(v.evidence)
    ? v.evidence.flatMap((e) => {
        if (typeof e === 'string') return [{ ref: e }];
        if (!isObj(e)) return [];
        const stanceOf = itemStance(e.stance ?? e.verdict ?? e.relation);
        return [
          {
            ref: e.ref ?? e.id ?? e.source ?? '',
            ...(typeof e.quote === 'string' && { quote: e.quote }),
            ...(stanceOf && { stance: stanceOf }),
          },
        ];
      })
    : [];
  const confidence = confidenceOf(v.confidence);
  return {
    ...(stance && { stance }),
    evidence,
    rationale: typeof rationale === 'string' ? rationale : rationale == null ? '' : String(rationale),
    ...(confidence !== undefined && { confidence }),
  };
}

/** The claim list as the schema expects it: a bare list, or a list under another name, becomes { claims }. */
export function tolerantClaims(raw: unknown): unknown {
  if (Array.isArray(raw)) return { claims: raw.map(claimItem) };
  const v = unwrap(raw, ['claims']);
  if (!isObj(v)) return v;
  let list: unknown = v.claims;
  if (list === undefined) {
    const lists = Object.values(v).filter(Array.isArray);
    if (lists.length === 1) list = lists[0];
  }
  return Array.isArray(list) ? { claims: list.map(claimItem) } : v;
}

function claimItem(c: unknown): unknown {
  if (typeof c === 'string') return { text: c, checkable: true };
  if (!isObj(c)) return c;
  const { claim, statement, start, end, ...rest } = c;
  return {
    ...rest,
    text: c.text ?? claim ?? statement,
    char_start: c.char_start ?? start,
    char_end: c.char_end ?? end,
  };
}
