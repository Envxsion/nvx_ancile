/**
 * ------------------------------------------------------------------
 *  Title    |  Artifacts
 *  Ref      |  docs/artifacts.md · ROADMAP.md "Final run before v1" (B)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  What an artifact is, how one is found in a model's
 *           |  answer, what Core lists per thread, and the only
 *           |  messages a sandboxed artifact may send its parent.
 *  How      |  parseArtifacts() is shared by Core (the per-thread
 *           |  list with versions) and the Cockpit (the card in the
 *           |  answer), so both agree on keys and content. It finds
 *           |  two forms:
 *           |    ```html artifact id="pricing" title="Pricing table"
 *           |    <antArtifact identifier="x" type="text/html" title="…">
 *           |  An artifact still being written (no closing fence or
 *           |  tag yet) is returned with complete: false.
 *  Note     |  A version is one answer's copy of an artifact: the same
 *           |  key in a later answer, or in a regenerated one, is the
 *           |  next version.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

export const ArtifactType = z.enum(['html', 'svg', 'react', 'mermaid', 'markdown', 'code']);
export type ArtifactType = z.infer<typeof ArtifactType>;

/** Longest artifact the Cockpit renders (characters). Longer ones show as code. */
export const ARTIFACT_MAX_CHARS = 512 * 1024;

export interface ParsedArtifact {
  /** Stable within a thread: the identifier, else the title's slug, else type and position. */
  key: string;
  type: ArtifactType;
  title: string;
  /** For code artifacts (and the source of the others): the language to highlight. */
  language: string | null;
  content: string;
  /** False while the answer is still writing it. */
  complete: boolean;
  /** [start, end) of the whole artifact (markers included) in the text. */
  start: number;
  end: number;
}

export type ArtifactPiece = { kind: 'text'; text: string } | { kind: 'artifact'; artifact: ParsedArtifact };

const LANG_TYPE: Record<string, ArtifactType> = {
  html: 'html',
  htm: 'html',
  svg: 'svg',
  jsx: 'react',
  tsx: 'react',
  react: 'react',
  mermaid: 'mermaid',
  mmd: 'mermaid',
  markdown: 'markdown',
  md: 'markdown',
};

const MIME_TYPE: Record<string, ArtifactType> = {
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'application/vnd.ant.react': 'react',
  'application/vnd.ant.mermaid': 'mermaid',
  'text/markdown': 'markdown',
  'application/vnd.ant.code': 'code',
};

const TYPE_TITLE: Record<ArtifactType, string> = {
  html: 'Web page',
  svg: 'Image',
  react: 'Component',
  mermaid: 'Diagram',
  markdown: 'Document',
  code: 'Code',
};

/** key="value", key='value' or key=value pairs. */
function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const k = (m[1] as string).toLowerCase();
    out[k] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 64);
}

function typeOf(lang: string | null, explicit: string | undefined): ArtifactType {
  const e = explicit?.toLowerCase();
  if (e && (ArtifactType.options as string[]).includes(e)) return e as ArtifactType;
  if (e && MIME_TYPE[e]) return MIME_TYPE[e];
  return (lang && LANG_TYPE[lang.toLowerCase()]) || 'code';
}

interface Raw {
  start: number;
  end: number;
  type: ArtifactType;
  language: string | null;
  id: string | undefined;
  title: string | undefined;
  content: string;
  complete: boolean;
}

/** <antArtifact …>…</antArtifact> (Claude's own form), case-insensitive. */
function antArtifacts(text: string): Raw[] {
  const out: Raw[] = [];
  const open = /<antArtifact\b([^>]*)>/gi;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const a = attrs(m[1] ?? '');
    const bodyStart = m.index + m[0].length;
    const close = /<\/antArtifact\s*>/i.exec(text.slice(bodyStart));
    const bodyEnd = close ? bodyStart + close.index : text.length;
    const end = close ? bodyEnd + close[0].length : text.length;
    const language = a.language ?? null;
    out.push({
      start: m.index,
      end,
      type: typeOf(language, a.type),
      language,
      id: a.identifier ?? a.id,
      title: a.title,
      content: text.slice(bodyStart, bodyEnd).replace(/^\r?\n/, '').replace(/\r?\n$/, ''),
      complete: Boolean(close),
    });
    open.lastIndex = end;
  }
  return out;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([\w+#.-]+)[ \t]+artifact\b(.*)$/;

/** Fenced blocks whose info string says `artifact`, outside the given ranges. */
function fencedArtifacts(text: string, skip: Raw[]): Raw[] {
  const out: Raw[] = [];
  const inSkip = (i: number) => skip.some((r) => i >= r.start && i < r.end);
  let at = 0;
  // Ordinary fences are tracked too, so an "artifact" line inside one is not taken for a marker.
  let plainFence: { ch: string; len: number } | null = null;
  while (at <= text.length) {
    const nl = text.indexOf('\n', at);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(at, lineEnd).replace(/\r$/, '');
    const next = nl === -1 ? text.length + 1 : nl + 1;
    if (inSkip(at)) {
      at = next;
      continue;
    }
    if (plainFence) {
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (c && c[1]?.[0] === plainFence.ch && (c[1]?.length ?? 0) >= plainFence.len) plainFence = null;
      at = next;
      continue;
    }
    const m = FENCE_OPEN.exec(line);
    if (!m) {
      const plain = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (plain) plainFence = { ch: plain[1]?.[0] as string, len: plain[1]?.length ?? 3 };
      at = next;
      continue;
    }
    const fence = m[2] as string;
    const ch = fence[0] as string;
    const a = attrs(m[4] ?? '');
    const bodyStart = Math.min(next, text.length);
    // Find the closing fence: the same character, at least as long, nothing after it.
    let scan = bodyStart;
    let closeAt = -1;
    let closeEnd = text.length;
    while (scan < text.length) {
      const n2 = text.indexOf('\n', scan);
      const e2 = n2 === -1 ? text.length : n2;
      const l2 = text.slice(scan, e2).replace(/\r$/, '');
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l2);
      if (c && c[1]?.[0] === ch && (c[1]?.length ?? 0) >= fence.length) {
        closeAt = scan;
        closeEnd = e2;
        break;
      }
      scan = n2 === -1 ? text.length : n2 + 1;
    }
    const complete = closeAt !== -1;
    const bodyEnd = complete ? closeAt : text.length;
    const language = (m[3] as string).toLowerCase();
    out.push({
      start: at,
      end: complete ? closeEnd : text.length,
      type: typeOf(language, a.type),
      language,
      id: a.id ?? a.identifier,
      title: a.title,
      content: text.slice(bodyStart, bodyEnd).replace(/\r?\n$/, ''),
      complete,
    });
    at = complete ? closeEnd + 1 : text.length + 1;
  }
  return out;
}

/** Every artifact in one answer's text, in order. */
export function findArtifacts(text: string): ParsedArtifact[] {
  const ant = antArtifacts(text);
  const all = [...ant, ...fencedArtifacts(text, ant)].sort((a, b) => a.start - b.start);
  const used = new Map<string, number>();
  return all.map((r) => {
    const title = r.title?.trim() || TYPE_TITLE[r.type];
    let base = (r.id && slugify(r.id)) || (r.title && slugify(r.title)) || r.type;
    if (!base) base = r.type;
    // Two artifacts in one answer never share a key: the second is "-2".
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const key = n > 1 ? `${base}-${n}` : base;
    return {
      key,
      type: r.type,
      title,
      language: r.language ?? (r.type === 'react' ? 'jsx' : r.type === 'code' ? null : r.type),
      content: r.content,
      complete: r.complete,
      start: r.start,
      end: r.end,
    };
  });
}

/** The answer's text split around its artifacts (text pieces keep their exact characters). */
export function splitArtifacts(text: string): ArtifactPiece[] {
  const found = findArtifacts(text);
  if (!found.length) return [{ kind: 'text', text }];
  const out: ArtifactPiece[] = [];
  let at = 0;
  for (const a of found) {
    if (a.start > at) out.push({ kind: 'text', text: text.slice(at, a.start) });
    out.push({ kind: 'artifact', artifact: a });
    at = a.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/* ---- Core: the thread's artifacts, with versions ------------------------ */

export const ArtifactVersion = z.object({
  /** 1-based, oldest first. */
  version: z.number().int().positive(),
  message_id: z.string(),
  created_at: z.string(),
  type: ArtifactType,
  title: z.string(),
  language: z.string().nullable(),
  content: z.string(),
  /** The answer that made it is on the branch you are reading. */
  on_path: z.boolean().optional(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersion>;

export const ThreadArtifact = z.object({
  key: z.string(),
  /** From the latest version. */
  type: ArtifactType,
  title: z.string(),
  /** The person allowed this artifact to reach the network (off by default). */
  allow_network: z.boolean(),
  network_changed_at: z.string().nullable(),
  versions: z.array(ArtifactVersion),
});
export type ThreadArtifact = z.infer<typeof ThreadArtifact>;

export const ThreadArtifacts = z.object({ items: z.array(ThreadArtifact) });
export type ThreadArtifacts = z.infer<typeof ThreadArtifacts>;

export const ArtifactNetworkRequest = z.object({ allow: z.boolean() });
export type ArtifactNetworkRequest = z.infer<typeof ArtifactNetworkRequest>;

export const ArtifactNetwork = z.object({
  key: z.string(),
  allow_network: z.boolean(),
  network_changed_at: z.string().nullable(),
});
export type ArtifactNetwork = z.infer<typeof ArtifactNetwork>;

/* ---- The sandbox protocol: artifact frame → Cockpit ---------------------- */

/** Every message an artifact frame may send. Anything else is dropped unread. */
export const ARTIFACT_CHANNEL = 'nvx-ancile-artifact';

export const ArtifactFrameMessage = z.discriminatedUnion('kind', [
  z.object({
    channel: z.literal(ARTIFACT_CHANNEL),
    nonce: z.string().min(8).max(64),
    kind: z.literal('size'),
    height: z.number().finite().min(0).max(100_000),
  }),
  z.object({
    channel: z.literal(ARTIFACT_CHANNEL),
    nonce: z.string().min(8).max(64),
    kind: z.literal('copy'),
    text: z.string().max(1_000_000),
  }),
  z.object({
    channel: z.literal(ARTIFACT_CHANNEL),
    nonce: z.string().min(8).max(64),
    kind: z.literal('download'),
    name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\\/:*?"<>|\0]+$/),
    mime: z.enum([
      'text/plain',
      'text/csv',
      'text/markdown',
      'application/json',
      'image/svg+xml',
      'image/png',
      'text/html',
    ]),
    /** Text, or base64 for image/png. */
    data: z.string().max(5_000_000),
  }),
  z.object({
    channel: z.literal(ARTIFACT_CHANNEL),
    nonce: z.string().min(8).max(64),
    kind: z.literal('error'),
    message: z.string().max(2_000),
  }),
]);
export type ArtifactFrameMessage = z.infer<typeof ArtifactFrameMessage>;
