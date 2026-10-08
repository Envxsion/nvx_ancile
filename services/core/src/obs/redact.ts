/**
 * ------------------------------------------------------------------
 *  Title    |  Redaction
 *  Ref      |  DESIGN.md §5.8, §11.3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keys, tokens and passwords never reach a log line, an
 *           |  error body or "copy debug info". Applied to structured
 *           |  data by key name and to free text by shape.
 * ------------------------------------------------------------------
 */

const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|password|passphrase|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|.*_key|.*_token|.*_secret)$/i;

const TEXT_PATTERNS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-…'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{16,}/g, 'sk-…'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza…'],
  [/\brpa_[A-Za-z0-9]{16,}/g, 'rpa_…'],
  [/\bhf_[A-Za-z0-9]{20,}/g, 'hf_…'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, 'gh…'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer …'],
  [/\b(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, '$1…@'],
  [/\bNVX-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}\b/g, 'NVX-…'],
];

export function redactText(text: string): string {
  let out = text;
  for (const [re, repl] of TEXT_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Keep the last four characters so a person can tell which key it was. */
export function maskSecret(value: string): string {
  return value.length <= 4 ? '…' : `…${value.slice(-4)}`;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) && typeof v === 'string' ? maskSecret(v) : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
