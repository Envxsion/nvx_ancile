/**
 * ------------------------------------------------------------------
 *  Title    |  The help guide: shapes, search and citations
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything a person needs to use NVX Ancile well, in
 *           |  the app, offline, and searchable from the palette.
 *  How      |  The article text is not here: it loads on demand from
 *           |  help/coreGuide.ts and help/providersGuide.ts
 *           |  (help/lazyGuide.ts adds them with registerChapter). What
 *           |  stays in the first download is small: the shapes, search
 *           |  (searchHelp), section anchors and citeGuide. Each article
 *           |  may name a tour that shows it on the real screen, and
 *           |  error codes from docs/errors.md point at the article
 *           |  that explains them (ERROR_ARTICLES).
 *  Note     |  Copy rules: plain, sentence case, British spelling, no
 *           |  em dashes, "NVX Ancile" in full where it names the app.
 * ------------------------------------------------------------------
 */

export interface ArticleSource {
  title: string;
  url: string;
}

export interface Article {
  id: string;
  title: string;
  summary: string;
  body: string;
  keywords?: string;
  tour?: string;
  /** Where the facts in this article were read. Listed at its foot. */
  sources?: ArticleSource[];
  /** An ISO date: when those sources were last read. */
  checked?: string;
  /**
   * Sentences of the body (exactly as written) or section ids that are not yet
   * confirmed at the vendor's own page. Each is shown with a "Not yet confirmed" mark.
   */
  unconfirmed?: string[];
  /** What to read next: article ids, or "id#section" to land on a section. */
  related?: string[];
}

export interface Chapter {
  id: string;
  title: string;
  articles: Article[];
}

export const CHAPTERS: Chapter[] = [];

export const ARTICLES: Article[] = [];

export function articleById(id: string): { chapter: Chapter; article: Article } | null {
  for (const chapter of CHAPTERS) {
    const article = chapter.articles.find((a) => a.id === id);
    if (article) return { chapter, article };
  }
  return null;
}

/** Error codes (docs/errors.md) → the article that explains them. */
export const ERROR_ARTICLES: Record<string, string> = {
  'privacy.denied': 'private-notebooks',
  'privacy.locked': 'private-notebooks',
  'decisions.local_url_invalid': 'spend-less-on-decisions',
  'openrouter.endpoints_unavailable': 'openrouter-quality',
  'openrouter.model_invalid': 'openrouter-quality',
  'routing.no_chat_model': 'fact-checking',
  'factcheck.needs_choice': 'fact-checking',
  'factcheck.model_not_ready': 'fact-checking',
  'factcheck.judge_not_allowed': 'fact-checking',
  'factcheck.bad_output': 'fact-checking',
  'factcheck.evidence_unavailable': 'fact-checking',
  'model.needs_key': 'models',
  'model.pinned_unavailable': 'models',
  'model.not_chat': 'models',
  'run.already_running': 'first-thread',
  'thread.busy': 'first-thread',
  'permission.denied': 'approvals',
  'permission.pattern_too_broad': 'approvals',
  'lab.unavailable': 'lab',
  'lab.failed': 'lab',
  'lab.undo_unavailable': 'lab',
  'extract.scanned_pdf': 'source-failed',
  'extract.fetch_failed': 'source-failed',
  'embed.unavailable': 'source-failed',
  'mcp.name_taken': 'mcp-servers',
  'mcp.read_only': 'mcp-servers',
  'mcp.secret_missing': 'mcp-servers',
  'mcp.tier_not_allowed': 'mcp-servers',
  'claude_code.not_installed': 'claude-code',
  'claude_code.signed_out': 'claude-code',
  'claude_code.session_busy': 'claude-code',
  'claude_code.plan_limit': 'claude-code',
  'claude_code.unverified': 'claude-code',
  'claude_code.branch_unmapped': 'claude-code',
  'claude_code.version_old': 'claude-code',
  'claude_code.sdk_unavailable': 'claude-code',
  'claude_code.install_failed': 'claude-code',
  'claude_code.folder_excluded': 'claude-code',
};

/**
 * Add a chapter that was loaded on demand (help/lazyGuide.ts). The chapter and
 * article lists are the same arrays as before, so search, the contents and
 * `articleById` see it at once. Registering a chapter again replaces it.
 */
export function registerChapter(chapter: Chapter): void {
  const at = CHAPTERS.findIndex((c) => c.id === chapter.id);
  if (at >= 0) {
    const old = CHAPTERS[at];
    if (old)
      for (const a of old.articles) {
        const i = ARTICLES.indexOf(a);
        if (i >= 0) ARTICLES.splice(i, 1);
      }
    CHAPTERS.splice(at, 1, chapter);
  } else CHAPTERS.push(chapter);
  ARTICLES.push(...chapter.articles);
}

/** Words that carry no meaning in a question such as "does Mistral train on my data". */
const STOP = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'does',
  'for',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
]);

/** Plain-text search over titles, summaries, keywords and bodies, best first. */
export function searchHelp(q: string): Article[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !STOP.has(w));
  const terms = meaningful.length ? meaningful : words;
  if (!terms.length) return [];
  return ARTICLES.map((a) => {
    const title = a.title.toLowerCase();
    const meta = `${a.summary} ${a.keywords ?? ''}`.toLowerCase();
    const body = a.body.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 6;
      else if (meta.includes(t)) score += 3;
      else if (body.includes(t)) score += 1;
      else return { a, score: -1 };
    }
    return { a, score };
  })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}

/* ---- Sections and citations -------------------------------------------- */

/** A stable anchor for a heading: lower case, letters and digits, one hyphen between words. */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface Section {
  id: string;
  title: string;
}

/**
 * The `###` headings of a body, each with its anchor. Two headings that make the
 * same slug get -2, -3 and so on, in order, so an anchor never moves unless a
 * heading above it with the same name is added or removed.
 */
export function sectionsOf(body: string): Section[] {
  const seen = new Map<string, number>();
  const out: Section[] = [];
  for (const line of body.split('\n')) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (!m?.[1]) continue;
    const title = m[1];
    const base = slugOf(title) || 'section';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ id: n === 1 ? base : `${base}-${n}`, title });
  }
  return out;
}

/** What the "Not yet confirmed" mark is in the markdown; the guide draws it as a quiet label. */
export const NOT_CONFIRMED_HREF = '#not-confirmed';
const MARK = ` [Not yet confirmed](${NOT_CONFIRMED_HREF})`;

/**
 * The body with a "Not yet confirmed" mark after each unconfirmed sentence. An entry
 * that is a section id (not a sentence of the body) marks the whole section, under its heading.
 */
export function markUnconfirmed(body: string, unconfirmed: readonly string[] | undefined): string {
  if (!unconfirmed?.length) return body;
  const inserts: { at: number; text: string }[] = [];
  const sections = sectionsOf(body);
  for (const u of unconfirmed) {
    const at = body.indexOf(u);
    if (at >= 0) {
      inserts.push({ at: at + u.length, text: MARK });
      continue;
    }
    const sec = sections.find((s) => s.id === u);
    if (!sec) continue;
    const heading = body.indexOf(`### ${sec.title}`);
    if (heading < 0) continue;
    const eol = body.indexOf('\n', heading);
    inserts.push({
      at: eol < 0 ? body.length : eol,
      text: `\n\n[Not yet confirmed](${NOT_CONFIRMED_HREF}) Facts in this section are not yet confirmed.`,
    });
  }
  let out = body;
  for (const { at, text } of inserts.sort((x, y) => y.at - x.at))
    out = out.slice(0, at) + text + out.slice(at);
  return out;
}

export interface GuideCitation {
  /** The article's title. */
  title: string;
  /** The section's heading, or null for the article as a whole. */
  section: string | null;
  /** The in-app route that opens the guide there, with the section as the hash. */
  url: string;
  /** An ISO date the article's sources were last read, or null when it has none. */
  checked: string | null;
}

/**
 * Point at a place in the guide, for an answer that quotes it (Ctrl K questions, K2).
 * `null` when the article or the section does not exist, so a citation never points nowhere.
 * Articles in a chapter that loads on demand are only found once help/lazyGuide.ts has loaded it.
 */
export function citeGuide(articleId: string, sectionId?: string): GuideCitation | null {
  const found = articleById(articleId);
  if (!found) return null;
  const { article } = found;
  const section = sectionId ? sectionsOf(article.body).find((s) => s.id === sectionId) : undefined;
  if (sectionId && !section) return null;
  return {
    title: article.title,
    section: section?.title ?? null,
    url: `/open/help?topic=${encodeURIComponent(article.id)}${section ? `#${section.id}` : ''}`,
    checked: article.checked ?? null,
  };
}
