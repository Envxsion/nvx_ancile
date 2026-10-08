/**
 * ------------------------------------------------------------------
 *  Title    |  Sample-data seeder
 *  Ref      |  scripts/seed.mjs (entry), scripts/seed/world.mjs (data)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Turn the world in scripts/seed/world.mjs into real rows:
 *           |  notebooks and genuinely ingested sources, threads with
 *           |  edited and regenerated branches, citations that point
 *           |  at real chunks, fact-checks scored with Core's own
 *           |  formula, memory committed through the memory routes, a
 *           |  merge made by the merge route, and one approval that is
 *           |  really waiting.
 *  How      |  Core's HTTP API wherever a route exists (sources, search,
 *           |  memory, merge, approvals); SQL for history no route can
 *           |  write (backdated, finished turns with chosen models).
 *           |  Everything this creates carries "SEED" in its id or is
 *           |  listed in core.settings['seed.manifest'], and --reset
 *           |  removes exactly that.
 *  Note     |  Re-running resets first, so dates stay fresh and nothing
 *           |  is doubled.
 * ------------------------------------------------------------------
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ClaimEvidence, Part, RetrievalTrace, SearchHit, SearchResponse } from '@nvx/contracts';
import postgres from 'postgres';
import {
  type CheckedClaim,
  type ClaimOutcome,
  countVerdicts,
  isSealed,
  messageScore,
  scoreOutcome,
  toStored,
} from '../src/factcheck/pipeline';
import { DEFAULT_WEIGHTS, type VerifierVerdict } from '../src/factcheck/score';

/* ---- World shapes (scripts/seed/world.mjs) ----------------------------------- */

type ModelKey = 'sonnet' | 'opus' | 'haiku' | 'gpt' | 'gemini';
type Cite = [sourceKey: string, query: string];

interface SeedSource {
  key: string;
  file: string;
  title: string;
  upload?: string;
}
interface SeedNotebook {
  key: string;
  title: string;
  slug: string;
  color: string;
  description: string;
  daysAgo: number;
  pinned?: boolean;
  grounded?: boolean;
  sources: SeedSource[];
}
interface SeedMessage {
  k: string;
  p: string | null;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  model?: ModelKey;
  editOf?: string;
  cites?: Record<string, Cite>;
  fallback?: { from: ModelKey; reason: string; detail: string };
  tools?: { tool: string; args: unknown; ok: boolean; result: unknown }[];
  compacted?: boolean;
}
interface SeedClaim {
  text: string;
  importance: number;
  verdict: VerifierVerdict;
  evidence: [
    sourceKey: string,
    query: string,
    stance: 'supports' | 'contradicts' | 'neutral',
    score: number,
  ][];
  rationale: string;
}
interface SeedThread {
  key: string;
  notebook: string | null;
  title: string;
  daysAgo: number;
  hour: number;
  head: string;
  pinned?: boolean;
  archived?: boolean;
  draft?: string;
  messages: SeedMessage[];
  branches?: { name: string; color: string; fork: string; head: string }[];
  merge?: { title: string; a: string; b: string; picks: string[] };
  compaction?: { upto: string; summary: string; tokensBefore: number; tokensAfter: number };
  factchecks?: { message: string; verifier: ModelKey; claims: SeedClaim[] }[];
  approval?: { ask: string; intro: string; path: string; content: string };
}
interface World {
  MODELS: Record<ModelKey, string>;
  NOTEBOOKS: SeedNotebook[];
  THREADS: SeedThread[];
  MEMORY: {
    user: Record<string, (string | number)[][]>;
    projects: Record<string, Record<string, string[]>>;
    failures: Record<string, { title: string; lessons: string[] }>;
    models: Record<string, { title: string; quirks: string[] }>;
  };
  PROPOSALS: {
    kind: string;
    target: string;
    section: string;
    text: string;
    rationale: string;
    confidence: number;
    provenance: string;
    thread: string;
    message: string;
    hoursAgo: number;
  }[];
  NOTES: {
    notebook: string;
    title: string;
    daysAgo: number;
    kind?: 'human';
    content?: string;
    pinned?: boolean;
    fromThread?: string;
    fromMessage?: string;
  }[];
  GRANTS: {
    action: string;
    resource: string;
    scope: string;
    uses: number;
    daysAgo: number;
    effect?: 'deny';
    notebook?: string;
  }[];
  DECISIONS: {
    action: string;
    resource: string;
    tier: string;
    outcome: string;
    daysAgo: number;
    grant?: number;
  }[];
  NOTIFICATIONS: {
    kind: string;
    level: string;
    title: string;
    body: string;
    hoursAgo: number;
    read?: boolean;
  }[];
}

interface Manifest {
  version: 1;
  seeded_at: string;
  sources: string[];
  threads: string[];
  memory_created: string[];
}

/* ---- Setup ----------------------------------------------------------------------- */

const ROOT = process.env.ANCILE_SEED_ROOT ?? join(process.cwd(), '..', '..');
const API = process.env.ANCILE_SEED_API ?? 'http://127.0.0.1:7700/api/v1';
const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('DATABASE_URL is not set. Run this through `pnpm seed`.');
  process.exit(1);
}
const sql = postgres(DB, { max: 4, onnotice: () => undefined });
const world = (await import(pathToFileURL(join(ROOT, 'scripts', 'seed', 'world.mjs')).href)) as World;

const MANIFEST_KEY = 'seed.manifest';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PRICE: Record<ModelKey, [number, number]> = {
  sonnet: [3, 15],
  opus: [15, 75],
  haiku: [1, 5],
  gpt: [5, 20],
  gemini: [2.5, 15],
};
const NAMES: Record<ModelKey, string> = {
  sonnet: 'Claude Sonnet 5.5',
  opus: 'Claude Opus 5.5',
  haiku: 'Claude Haiku 4.5',
  gpt: 'GPT-5.5',
  gemini: 'Gemini 3 Pro',
};
/** Thresholds from config/factcheck.yaml, so seeded verdicts match what Core would decide. */
const SCORE_CFG = { weights: DEFAULT_WEIGHTS, thresholds: { contradict: 0.6, verified: 0.6 } };

const sid = (prefix: string) =>
  `${prefix}_SEED${Array.from(randomBytes(22), (b) => CROCKFORD[b % 32]).join('')}`;
const traceId = () => randomBytes(16).toString('hex');
const log = (msg: string) => console.log(`  ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  // In development Core restarts whenever its code changes; wait it out
  // rather than stop halfway (a request that never reached Core is safe to repeat).
  let res: Response | undefined;
  for (let attempt = 0; !res; attempt++) {
    try {
      res = await fetch(API + path, {
        method,
        headers: body instanceof FormData ? {} : { 'content-type': 'application/json' },
        body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt >= 30) throw err;
      await sleep(1000);
    }
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** A moment `daysAgo` days back at `hour`:00 local time, plus `minutes`. */
function when(daysAgo: number, hour: number, minutes = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  // Never in the future: if that hour has not come yet today, start two hours ago.
  const cap = Date.now() - 2 * 3_600_000;
  if (d.getTime() > cap) d.setTime(cap);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

const tokens = (s: string) => Math.ceil(s.length / 4);

/* ---- Reset ------------------------------------------------------------------------ */

async function reset(): Promise<void> {
  const rows = await sql<{ value: Manifest }[]>`select value from core.settings where key = ${MANIFEST_KEY}`;
  const manifest = rows[0]?.value;
  const threadIds = [
    ...new Set([
      ...(manifest?.threads ?? []),
      ...(await sql<{ id: string }[]>`select id from core.threads where id like 'thr\\_SEED%'`).map(
        (r) => r.id,
      ),
    ]),
  ];
  if (!manifest && threadIds.length === 0) {
    const nb = await sql`select 1 from core.notebooks where id like 'nbk\\_SEED%' limit 1`;
    if (nb.length === 0) return;
  }
  console.log('Removing the sample data');

  if (threadIds.length) {
    const runIds = (
      await sql<{ id: string }[]>`select id from core.runs where thread_id = any(${threadIds})`
    ).map((r) => r.id);
    const msgIds = (
      await sql<{ id: string }[]>`select id from core.messages where thread_id = any(${threadIds})`
    ).map((r) => r.id);
    const fcRuns = (
      await sql<
        { run_id: string | null }[]
      >`select run_id from core.factchecks where message_id = any(${msgIds})`
    )
      .map((r) => r.run_id)
      .filter((x): x is string => !!x);
    const allRuns = [...runIds, ...fcRuns];
    await sql.begin(async (tx) => {
      await tx`delete from core.claims where factcheck_id in (select id from core.factchecks where message_id = any(${msgIds}))`;
      await tx`delete from core.factchecks where message_id = any(${msgIds})`;
      await tx`delete from core.summaries where thread_id = any(${threadIds})`;
      await tx`delete from core.branches where thread_id = any(${threadIds})`;
      await tx`delete from core.drafts where thread_id = any(${threadIds})`;
      await tx`delete from core.approvals where run_id = any(${allRuns})`;
      await tx`delete from core.run_events where run_id = any(${allRuns})`;
      await tx`delete from core.run_steps where run_id = any(${allRuns})`;
      await tx`update core.threads set root_message_id = null, active_head_id = null where id = any(${threadIds})`;
      await tx`delete from core.messages where thread_id = any(${threadIds})`;
      await tx`delete from core.runs where id = any(${allRuns})`;
      await tx`delete from core.threads where id = any(${threadIds})`;
    });
    log(`${threadIds.length} threads`);
  }

  for (const id of manifest?.sources ?? []) await api('DELETE', `/sources/${id}`).catch(() => undefined);
  if (manifest?.sources.length) log(`${manifest.sources.length} sources`);

  await sql`delete from core.notes where id like 'not\\_SEED%'`;
  // A notebook goes only if nothing of yours was added to it.
  const kept = await sql<{ id: string; title: string }[]>`
    select n.id, n.title from core.notebooks n
    where n.id like 'nbk\\_SEED%'
      and (exists (select 1 from core.threads t where t.notebook_id = n.id)
        or exists (select 1 from core.notes x where x.notebook_id = n.id))`;
  await sql`
    delete from core.notebooks n where n.id like 'nbk\\_SEED%'
      and not exists (select 1 from core.threads t where t.notebook_id = n.id)
      and not exists (select 1 from core.notes x where x.notebook_id = n.id)`;
  for (const k of kept) log(`kept the notebook "${k.title}": it has your own threads or notes in it`);

  await sql`delete from core.grants where id like 'gnt\\_SEED%'`;
  await sql`delete from core.notifications where id like 'ntf\\_SEED%'`;
  await sql`delete from core.memory_proposals where id like 'mpr\\_SEED%'`;
  // The decision log is append-only for the application; the sample rows are
  // the one exception, removed with the trigger paused inside one transaction.
  await sql
    .begin(async (tx) => {
      await tx`alter table core.decisions disable trigger decisions_append_only`;
      await tx`delete from core.decisions where id like 'dec\\_SEED%'`;
      await tx`alter table core.decisions enable trigger decisions_append_only`;
    })
    .catch((err) => log(`left the sample decisions in the log (${(err as Error).message})`));

  // Memory: take out the seeded entries, leave everything else exactly as it is.
  const files = await api<{ items: { path: string; version: string }[] }>('GET', '/memory/files').catch(
    () => ({
      items: [],
    }),
  );
  let cleaned = 0;
  for (const f of files.items) {
    const file = await api<{ content: string; version: string }>('GET', `/memory/files/${f.path}`);
    // Drop each seeded line, and the blank line seeding put beside it.
    const lines = file.content.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/<!--[^>]*\bseed:1\b[^>]*-->/.test(lines[i] as string)) {
        out.push(lines[i] as string);
        continue;
      }
      if (out.at(-1)?.trim() === '' && lines[i + 1]?.trim() === '') i++;
    }
    const next = out.join('\n');
    if (next === file.content) continue;
    // A file seeding created holds nothing but headings once its entries go: remove it.
    const kept =
      f.path === 'AGENTS.md' || f.path === 'USER.md' || /(^|\/)(README|_template)\.md$/i.test(f.path);
    const body = next.replace(/^---\n[\s\S]*?\n---\n/, '');
    if (!kept && body.split('\n').every((l) => !l.trim() || /^#{1,6}\s/.test(l))) {
      await api('DELETE', `/memory/files/${f.path}`);
      cleaned++;
      continue;
    }
    await api('PUT', `/memory/files/${f.path}`, {
      content: next,
      base_sha: file.version,
      message: 'remove sample entries',
    });
    cleaned++;
  }
  if (cleaned) log(`sample entries out of ${cleaned} memory files`);

  await sql`delete from core.settings where key = ${MANIFEST_KEY}`;
}

/* ---- Seed --------------------------------------------------------------------------- */

interface Ctx {
  userId: string;
  workspaceId: string;
  notebooks: Map<string, { id: string; slug: string; sources: Map<string, { id: string; title: string }> }>;
  /** thread key → { id, message key → id } */
  threads: Map<string, { id: string; msgs: Map<string, string>; texts: Map<string, string> }>;
  manifest: Manifest;
  searchCache: Map<string, SearchHit[]>;
}

async function search(ctx: Ctx, notebookId: string, sourceId: string, query: string): Promise<SearchHit[]> {
  const key = `${sourceId}|${query}`;
  const cached = ctx.searchCache.get(key);
  if (cached) return cached;
  const res = await api<SearchResponse>('POST', '/search', {
    query,
    notebook_id: notebookId,
    source_ids: [sourceId],
    k: 4,
  });
  ctx.searchCache.set(key, res.hits);
  if (res.hits.length === 0) throw new Error(`no passage found for "${query}"`);
  return res.hits;
}

/** The sentence of a passage that best matches the query, with its offset in the source. */
function bestQuote(hit: SearchHit, query: string): { quote: string; start: number; end: number } {
  const words = new Set(query.toLowerCase().match(/[a-z0-9£%.,]+/g) ?? []);
  let best = { quote: hit.text, start: hit.char_start, end: hit.char_end, score: -1 };
  const re = /[^.!?\n]+[.!?]?/g;
  for (let m = re.exec(hit.text); m; m = re.exec(hit.text)) {
    const s = m[0];
    const trimmed = s.trim();
    if (trimmed.length < 12) continue;
    const score = (trimmed.toLowerCase().match(/[a-z0-9£%.,]+/g) ?? []).filter((w) => words.has(w)).length;
    if (score > best.score) {
      const lead = s.indexOf(trimmed);
      const start = hit.char_start + m.index + lead;
      best = { quote: trimmed, start, end: start + trimmed.length, score };
    }
  }
  return { quote: best.quote, start: best.start, end: best.end };
}

async function seedNotebooks(ctx: Ctx): Promise<void> {
  console.log('Notebooks and sources');
  for (const nb of world.NOTEBOOKS) {
    const id = sid('nbk');
    const taken =
      await sql`select 1 from core.notebooks where workspace_id = ${ctx.workspaceId} and slug = ${nb.slug}`;
    const slug = taken.length ? `${nb.slug}-sample` : nb.slug;
    const created = when(nb.daysAgo, 9);
    await sql`
      insert into core.notebooks (id, workspace_id, title, slug, description, color, memory_path, settings,
        pinned_at, last_opened_at, created_at, updated_at)
      values (${id}, ${ctx.workspaceId}, ${nb.title}, ${slug}, ${nb.description}, ${nb.color}, ${`notebooks/${slug}`},
        ${sql.json({ seed: true, ...(nb.grounded && { grounded: true }) })},
        ${nb.pinned ? created : null}, ${when(0, 7)}, ${created}, ${created})`;
    const sources = new Map<string, { id: string; title: string }>();
    for (const s of nb.sources) {
      const path = join(ROOT, 'scripts', 'seed', 'sources', s.file);
      let created: { id: string; title: string };
      if (s.upload) {
        const form = new FormData();
        form.set('file', new Blob([readFileSync(path)], { type: s.upload }), s.file);
        form.set('notebook_id', id);
        form.set('title', s.title);
        created = await api('POST', '/sources', form);
      } else {
        created = await api('POST', '/sources', {
          kind: 'text',
          notebook_id: id,
          title: s.title,
          text: readFileSync(path, 'utf8'),
        });
      }
      sources.set(s.key, { id: created.id, title: s.title });
      ctx.manifest.sources.push(created.id);
    }
    ctx.notebooks.set(nb.key, { id, slug, sources });
    log(`${nb.title}: ${nb.sources.length} sources`);
  }
  await saveManifest(ctx);

  // Wait until every source has been read, chunked and indexed.
  const deadline = Date.now() + 4 * 60_000;
  for (const [key, nb] of ctx.notebooks) {
    for (;;) {
      const list = await api<{ items: { id: string; status: string; title: string }[] }>(
        'GET',
        `/notebooks/${nb.id}/sources`,
      );
      const waiting = list.items.filter((s) => s.status !== 'ready' && s.status !== 'failed');
      const failed = list.items.filter((s) => s.status === 'failed');
      if (failed.length)
        throw new Error(`source failed to ingest in ${key}: ${failed.map((f) => f.title).join(', ')}`);
      if (waiting.length === 0) break;
      if (Date.now() > deadline) throw new Error(`sources still being read after 4 minutes in ${key}`);
      await sleep(1500);
    }
  }
  // Sources arrived with their notebook, a day or two after it was made.
  for (const def of world.NOTEBOOKS) {
    const nb = ctx.notebooks.get(def.key);
    const ids = [...(nb?.sources.values() ?? [])].map((s) => s.id);
    const added = when(Math.max(0, def.daysAgo - 1), 10);
    await sql`update knowledge.sources set created_at = ${added}, updated_at = ${added}, fetched_at = ${added}
      where id = any(${ids})`.catch(() => undefined);
  }
  log('every source is read and searchable');
}

function partsFor(m: SeedMessage, text: string, citeParts: Part[]): Part[] {
  const parts: Part[] = [];
  for (const [i, t] of (m.tools ?? []).entries()) {
    const callId = `call_seed_${m.k}_${i}`;
    parts.push({ type: 'tool_call', call_id: callId, tool: t.tool, args: t.args });
    parts.push({ type: 'tool_result', call_id: callId, ok: t.ok, result: t.result });
  }
  parts.push({ type: 'text', text });
  return [...parts, ...citeParts];
}

async function seedThread(ctx: Ctx, t: SeedThread): Promise<void> {
  const id = sid('thr');
  const nb = t.notebook ? ctx.notebooks.get(t.notebook) : undefined;
  const msgs = new Map<string, string>();
  const texts = new Map<string, string>();
  for (const m of t.messages) msgs.set(m.k, sid('msg'));
  const start = when(t.daysAgo, t.hour);
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
  const last = Math.max(...t.messages.map((m) => m.at));

  await sql`
    insert into core.threads (id, workspace_id, notebook_id, title, title_source, root_message_id, active_head_id,
      settings, pinned_at, archived_at, created_at, updated_at)
    values (${id}, ${ctx.workspaceId}, ${nb?.id ?? null}, ${t.title}, 'user', null, null, ${sql.json({})},
      ${t.pinned ? at(last) : null}, ${t.archived ? at(last + 60) : null}, ${start}, ${at(last)})`;
  ctx.manifest.threads.push(id);

  const summaryId = t.compaction ? sid('sum') : null;
  for (const m of t.messages) {
    const msgId = msgs.get(m.k) as string;
    const parentId = m.p ? (msgs.get(m.p) as string) : null;
    let provenance: Record<string, unknown> = {};
    const citeParts: Part[] = [];

    if (m.role === 'assistant') {
      const model = m.model ?? 'sonnet';
      const answered = world.MODELS[model];
      const requested = m.fallback ? world.MODELS[m.fallback.from] : answered;
      provenance = {
        chain: m.fallback ? [requested, answered] : [answered],
        attempts: m.fallback
          ? [{ model: requested, reason: m.fallback.reason, detail: m.fallback.detail }]
          : [],
        model_name: NAMES[model],
      };
      if (m.cites && Object.keys(m.cites).length && nb) {
        const hits: RetrievalTrace['hits'] = [];
        const used = new Set<string>();
        let firstExtra: SearchHit | undefined;
        const markers = Object.keys(m.cites)
          .map(Number)
          .sort((a, b) => a - b);
        for (const n of markers) {
          const [sourceKey, query] = m.cites[String(n)] as Cite;
          const src = nb.sources.get(sourceKey);
          if (!src) throw new Error(`${t.key}/${m.k}: unknown source ${sourceKey}`);
          const found = await search(ctx, nb.id, src.id, query);
          const hit = found[0] as SearchHit;
          firstExtra ??= found.find((h) => h.chunk_id !== hit.chunk_id);
          used.add(hit.chunk_id);
          hits.push({
            marker: n,
            kind: hit.kind,
            chunk_id: hit.chunk_id,
            source_id: hit.source_id,
            source_title: src.title,
            page: hit.page,
            score: hit.score,
            rerank_score: hit.rerank_score,
            ranks: hit.ranks,
            cited: true,
          });
          citeParts.push({
            type: 'citation_ref',
            marker: n,
            chunk_id: hit.chunk_id,
            source_id: hit.source_id,
            char_start: hit.char_start,
            char_end: hit.char_end,
            quote: hit.text.slice(0, 600),
          });
        }
        // Retrieval always finds a little more than the answer uses.
        if (firstExtra && !used.has(firstExtra.chunk_id)) {
          hits.push({
            marker: markers.length + 1,
            kind: firstExtra.kind,
            chunk_id: firstExtra.chunk_id,
            source_id: firstExtra.source_id,
            source_title: firstExtra.source_title,
            page: firstExtra.page,
            score: firstExtra.score,
            rerank_score: firstExtra.rerank_score,
            ranks: firstExtra.ranks,
            cited: false,
          });
        }
        const question = t.messages.find((x) => x.k === m.p)?.text ?? '';
        provenance.retrieval = {
          query: question.slice(0, 400),
          notebook_id: nb.id,
          mode: 'hybrid',
          embedder: 'local/bge-small-en-v1.5',
          ms: 120 + Math.floor(Math.random() * 180),
          hits,
          invalid_markers: 0,
          grounded: true,
        } satisfies RetrievalTrace;
      }
      if (m.compacted && t.compaction && summaryId) {
        provenance.compaction = {
          summary_id: summaryId,
          upto_message_id: msgs.get(t.compaction.upto),
          tokens_before: t.compaction.tokensBefore,
          tokens_after: t.compaction.tokensAfter,
        };
      }
    }

    texts.set(m.k, m.text);
    const parts = m.role === 'assistant' ? partsFor(m, m.text, citeParts) : [{ type: 'text', text: m.text }];
    const model = m.model ?? 'sonnet';
    // Every turn sees the path before it: count it for a believable input size.
    const usage =
      m.role === 'assistant'
        ? (() => {
            const input =
              700 +
              tokens(
                t.messages
                  .filter((x) => x.at <= m.at)
                  .map((x) => x.text)
                  .join(''),
              );
            const output = tokens(m.text);
            const [pin, pout] = PRICE[model];
            return {
              input_tokens: input,
              output_tokens: output,
              cached_tokens: m.at > 2 ? Math.floor(input * 0.6) : 0,
              cost_usd: Number(((input * pin + output * pout) / 1e6).toFixed(5)),
            };
          })()
        : null;

    await sql`
      insert into core.messages (id, thread_id, parent_id, role, parts, model_id, requested_model_id, status,
        edit_of_id, provenance, usage, run_id, trace_id, created_at)
      values (${msgId}, ${id}, ${parentId}, ${m.role}, ${sql.json(parts as never)},
        ${m.role === 'assistant' ? world.MODELS[model] : null},
        ${m.role === 'assistant' ? (m.fallback ? world.MODELS[m.fallback.from] : world.MODELS[model]) : null},
        'complete', ${m.editOf ? (msgs.get(m.editOf) ?? null) : null}, ${sql.json(provenance as never)},
        ${usage ? sql.json(usage) : null}, null, ${traceId()}, ${at(m.at)})`;
  }

  const root = msgs.get(t.messages[0]?.k ?? '') ?? null;
  await sql`update core.threads set root_message_id = ${root}, active_head_id = ${msgs.get(t.head) ?? null} where id = ${id}`;

  for (const b of t.branches ?? []) {
    const head = t.messages.find((m) => m.k === b.head);
    await sql`
      insert into core.branches (id, thread_id, head_message_id, fork_message_id, name, color, created_by, created_at)
      values (${sid('brn')}, ${id}, ${msgs.get(b.head) as string}, ${msgs.get(b.fork) as string}, ${b.name},
        ${b.color}, 'user', ${at((head?.at ?? 0) + 1)})`;
  }

  if (t.compaction && summaryId) {
    const upto = t.messages.find((m) => m.k === t.compaction?.upto);
    await sql`
      insert into core.summaries (id, thread_id, upto_message_id, kind, content, tokens, model_id, created_at)
      values (${summaryId}, ${id}, ${msgs.get(t.compaction.upto) as string}, 'compaction', ${t.compaction.summary},
        ${tokens(t.compaction.summary)}, ${world.MODELS.haiku}, ${at((upto?.at ?? 0) + 15)})`;
  }

  if (t.draft) {
    await sql`
      insert into core.drafts (thread_id, parent_id, user_id, content, updated_at)
      values (${id}, ${msgs.get(t.head) as string}, ${ctx.userId}, ${sql.json({ text: t.draft })}, ${at(last + 30)})
      on conflict (thread_id, parent_id, user_id) do update set content = excluded.content`;
  }

  ctx.threads.set(t.key, { id, msgs, texts });
  for (const f of t.factchecks ?? []) await seedFactcheck(ctx, t, f, nb?.id ?? null, at);
  const forks = new Set(t.messages.map((m) => m.p)).size < t.messages.length ? ' (branching)' : '';
  log(`${t.title}${forks}`);
}

async function seedFactcheck(
  ctx: Ctx,
  t: SeedThread,
  f: NonNullable<SeedThread['factchecks']>[number],
  notebookId: string | null,
  at: (m: number) => Date,
): Promise<void> {
  const th = ctx.threads.get(t.key);
  const nb = t.notebook ? ctx.notebooks.get(t.notebook) : undefined;
  if (!th || !nb || !notebookId) throw new Error(`fact-check in ${t.key} needs a notebook`);
  const messageId = th.msgs.get(f.message) as string;
  const answer = th.texts.get(f.message) as string;
  const checked: CheckedClaim[] = [];
  for (const c of f.claims) {
    const start = answer.indexOf(c.text);
    if (start < 0) throw new Error(`${t.key}/${f.message}: claim not found in the answer: "${c.text}"`);
    const evidence: ClaimEvidence[] = [];
    for (const [sourceKey, query, stance, score] of c.evidence) {
      const src = nb.sources.get(sourceKey);
      if (!src) throw new Error(`unknown source ${sourceKey}`);
      const hit = (await search(ctx, notebookId, src.id, query))[0] as SearchHit;
      const q = bestQuote(hit, query);
      evidence.push({
        kind: 'chunk',
        ref: hit.chunk_id,
        source_id: hit.source_id,
        source_title: src.title,
        page: hit.page,
        char_start: q.start,
        char_end: q.end,
        quote: q.quote,
        stance,
        score,
      });
    }
    const outcome: ClaimOutcome = {
      claim: {
        text: c.text,
        charStart: start,
        charEnd: start + c.text.length,
        importance: c.importance,
        checkable: true,
      },
      evidence,
      coverage: c.verdict === 'supported' ? 0.92 : c.verdict === 'contradicted' ? 0.85 : 0.35,
      verdict: c.verdict,
      rationale: c.rationale,
    };
    checked.push(scoreOutcome(outcome, SCORE_CFG));
  }
  const stored = checked.map((c) => toStored(c, sid('clm')));
  const counts = countVerdicts(stored);
  const confidence = messageScore(checked);
  const sealed = isSealed(counts);
  const fcId = sid('fck');
  const msg = t.messages.find((m) => m.k === f.message);
  const doneAt = at((msg?.at ?? 0) + 2);
  await sql.begin(async (tx) => {
    await tx`
      insert into core.factchecks (id, message_id, status, confidence, verifier_model_id, run_id, scope, created_at, finished_at)
      values (${fcId}, ${messageId}, 'done', ${confidence}, ${world.MODELS[f.verifier]}, null,
        ${tx.json({ notebook_id: notebookId, web: false })}, ${doneAt}, ${doneAt})`;
    for (const [seq, c] of stored.entries()) {
      await tx`
        insert into core.claims (id, factcheck_id, seq, text, char_start, char_end, importance, verdict, confidence,
          support, agreement, retrieval, evidence, rationale)
        values (${c.id}, ${fcId}, ${seq}, ${c.text}, ${c.char_start}, ${c.char_end}, ${c.importance}, ${c.verdict},
          ${c.confidence}, ${c.support}, ${c.agreement}, ${c.retrieval}, ${tx.json(c.evidence as never)}, ${c.rationale})`;
    }
    await tx`
      update core.messages set provenance = provenance || ${tx.json({
        factcheck: { id: fcId, status: 'done', confidence, sealed },
      })}
      where id = ${messageId}`;
  });
  const verdicts = stored.map((c) => c.verdict).join(', ');
  const expected = f.claims
    .map((c) =>
      c.verdict === 'supported' ? 'verified' : c.verdict === 'contradicted' ? 'contradicted' : 'unverified',
    )
    .join(', ');
  if (verdicts !== expected)
    console.warn(`  ! ${t.key}/${f.message}: scored ${verdicts}, expected ${expected}`);
}

/* ---- Memory -------------------------------------------------------------------------- */

const day = (d: Date) => d.toISOString().slice(0, 10);
const trailer = (key: string, extra: Record<string, string | number>) =>
  `<!-- ${[`m:${key}`, ...Object.entries(extra).map(([k, v]) => `${k}:${v}`), 'seed:1'].join(' ')} -->`;
const mkey = () => sid('m').slice(6, 18);

/** Put bullets under `## section`, creating the section if the file lacks it. */
function addToSection(content: string, section: string, bullets: string[]): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase());
  if (at < 0) {
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}${eol}${eol}## ${section}${eol}${eol}${bullets.join(eol)}${eol}`;
  }
  let end = at + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end] as string)) end++;
  let insert = end;
  while (insert > at + 1 && (lines[insert - 1] as string).trim() === '') insert--;
  const before = lines.slice(0, insert);
  if ((before.at(-1) ?? '').trim() !== '' && !(before.at(-1) as string).startsWith('- ')) before.push('');
  const after = lines.slice(insert);
  if (after.length && (after[0] as string).trim() !== '') after.unshift('');
  return [...before, ...bullets, ...after].join(eol);
}

async function putMemory(path: string, content: string, message: string): Promise<string> {
  const current = await api<{ content: string; version: string }>('GET', `/memory/files/${path}`).catch(
    () => null,
  );
  const res = await api<{ version: string }>('PUT', `/memory/files/${path}`, {
    content,
    base_sha: current?.version ?? null,
    message,
  });
  return res.version;
}

async function seedMemory(ctx: Ctx): Promise<string> {
  console.log('Memory');
  const M = world.MEMORY;
  const src = (thread: string, k: string) => ctx.threads.get(thread)?.msgs.get(k) ?? 'manual';

  // USER.md: add to what is there; never replace it.
  const user = await api<{ content: string; version: string }>('GET', '/memory/files/USER.md');
  let content = user.content;
  const keys = new Map<string, string>();
  const sources = ['pricing:u1', 'quotes:u1', 'sizing:u1', 'opening:u1', 'scans:u2'];
  let i = 0;
  for (const [section, entries] of Object.entries(M.user)) {
    if (section === 'Superseded') continue;
    const bullets = entries.map(([text, conf, daysAgo, flag]) => {
      const key = mkey();
      if (flag === 'supersedes') keys.set('supersedes', key);
      const [th, mk] = (sources[i++ % sources.length] as string).split(':') as [string, string];
      return `- ${text} ${trailer(key, { conf: conf as number, src: src(th, mk), at: day(when(daysAgo as number, 12)) })}`;
    });
    content = addToSection(content, section, bullets);
  }
  for (const [text, daysAgo] of M.user.Superseded ?? []) {
    const by = keys.get('supersedes') ?? mkey();
    content = addToSection(content, 'Superseded', [
      `- ~~${text}~~ ${trailer(mkey(), { superseded_by: by, at: day(when(daysAgo as number, 12)) })}`,
    ]);
  }
  const userVersion = await putMemory('USER.md', content, 'sample preferences');
  log('USER.md: preferences, writing, code, and one superseded belief');

  // One file per notebook, as capture would have built it.
  for (const [nbKey, sections] of Object.entries(M.projects)) {
    const nb = ctx.notebooks.get(nbKey);
    const def = world.NOTEBOOKS.find((n) => n.key === nbKey);
    if (!nb || !def) continue;
    const path = `PROJECTS/${nb.slug}.md`;
    const firstThread = world.THREADS.find((t) => t.notebook === nbKey);
    const from = firstThread ? src(firstThread.key, firstThread.messages[1]?.k ?? 'a1') : 'manual';
    const body = Object.entries(sections)
      .map(
        ([section, items]) =>
          `## ${section}\n\n${items
            .map(
              (text, j) =>
                `- ${text} ${trailer(mkey(), { conf: 0.85 + (j % 3) * 0.04, src: from, at: day(when(def.daysAgo - 3 - j, 12)) })}`,
            )
            .join('\n')}\n`,
      )
      .join('\n');
    const file = `---\ntype: projects\nscope: notebook\nnotebook: "${nb.id}"\ntitle: "${def.title}"\nupdated: "${day(new Date())}"\n---\n# ${def.title}\n\nGoals, decisions and findings from this notebook's threads, each linked to the message it came from.\n\n${body}\n## Superseded\n`;
    const existed = await api('GET', `/memory/files/${path}`).catch(() => null);
    await putMemory(path, file, `notebook memory for ${def.title}`);
    if (!existed) ctx.manifest.memory_created.push(path);
  }
  log(`${Object.keys(M.projects).length} notebook files in PROJECTS/`);

  for (const [path, f] of Object.entries(M.failures)) {
    const lessons = f.lessons.map(
      (l) => `- ${l} ${trailer(mkey(), { conf: 0.9, src: src('scans', 'a2'), at: day(when(6, 12)) })}`,
    );
    const file = `---\ntype: failures\nscope: retrieved\nupdated: "${day(new Date())}"\n---\n# ${f.title}\n\n${lessons.join('\n')}\n`;
    const existed = await api('GET', `/memory/files/${path}`).catch(() => null);
    await putMemory(path, file, `lesson: ${f.title.toLowerCase()}`);
    if (!existed) ctx.manifest.memory_created.push(path);
  }
  for (const [path, f] of Object.entries(M.models)) {
    const quirks = f.quirks.map(
      (q) => `- ${q} ${trailer(mkey(), { conf: 0.8, src: src('opening', 'a1b'), at: day(when(9, 23)) })}`,
    );
    const file = `---\ntype: models\nscope: model\nupdated: "${day(new Date())}"\n---\n# ${f.title}\n\n${quirks.join('\n')}\n`;
    const existed = await api('GET', `/memory/files/${path}`).catch(() => null);
    await putMemory(path, file, `model note: ${f.title}`);
    if (!existed) ctx.manifest.memory_created.push(path);
  }
  log('two lessons in FAILURES/ and a model note in MODELS/');

  // The inbox: two waiting (one from a document, so it can only ever be a
  // suggestion), plus the record of one kept automatically and one turned down.
  for (const p of world.PROPOSALS) {
    const target = p.target.replace('heat-pump-for-elm-grove', ctx.notebooks.get('heat')?.slug ?? 'heat');
    const th = ctx.threads.get(p.thread);
    const created = new Date(Date.now() - p.hoursAgo * 3_600_000);
    await sql`
      insert into core.memory_proposals (id, kind, target_path, op, patch, section, text, target_key, target_text,
        rationale, evidence, confidence, provenance, status, created_at)
      values (${sid('mpr')}, ${p.kind}, ${target}, 'add', ${p.text}, ${p.section}, ${p.text}, null, null, ${p.rationale},
        ${sql.json([{ thread_id: th?.id, message_id: th?.msgs.get(p.message) }] as never)}, ${p.confidence},
        ${p.provenance}, 'proposed', ${created})`;
  }
  const pricing = ctx.threads.get('pricing');
  await sql`
    insert into core.memory_proposals (id, kind, target_path, op, patch, section, text, rationale, evidence,
      confidence, provenance, status, commit_sha, created_at, decided_at)
    values (${sid('mpr')}, 'preference', 'USER.md', 'add', 'Prefers tables when comparing options side by side.',
      'Preferences', 'Prefers tables when comparing options side by side.',
      'You asked for a table twice when comparing options.',
      ${sql.json([{ thread_id: pricing?.id, message_id: pricing?.msgs.get('u1') }] as never)}, 0.92, 'user_message',
      'auto_applied', ${userVersion}, ${when(14, 12)}, ${when(14, 12)})`;
  await sql`
    insert into core.memory_proposals (id, kind, target_path, op, patch, section, text, rationale, evidence,
      confidence, provenance, status, created_at, decided_at)
    values (${sid('mpr')}, 'preference', 'USER.md', 'add', 'Wants every answer to end with a summary.',
      'Preferences', 'Wants every answer to end with a summary.',
      'You asked for a summary once, at the end of a long thread.',
      ${sql.json([{ thread_id: pricing?.id, message_id: pricing?.msgs.get('u3') }] as never)}, 0.55, 'user_message',
      'rejected', ${when(8, 12)}, ${when(8, 13)})`;
  log('the inbox: two suggestions waiting, one from a document');
  return userVersion;
}

/** What each answer was given from memory, as Core reports it for that path. */
async function stampMemoryPacks(ctx: Ctx): Promise<void> {
  for (const t of world.THREADS) {
    const th = ctx.threads.get(t.key);
    if (!th) continue;
    for (const m of t.messages.filter((x) => x.role === 'assistant')) {
      const msgId = th.msgs.get(m.k) as string;
      const pack = await api<{ files: unknown[]; tokens: number; truncated: number }>(
        'GET',
        `/memory/preview?thread=${th.id}&head=${th.msgs.get(m.p ?? '') ?? msgId}`,
      ).catch(() => null);
      if (!pack?.files?.length) continue;
      await sql`
        update core.messages set provenance = provenance || ${sql.json({
          memory: { files: pack.files, tokens: pack.tokens, truncated: pack.truncated },
        } as never)}
        where id = ${msgId}`;
    }
  }
  log('every answer records the memory it was given');
}

/* ---- Notes, permissions, notifications ------------------------------------------------- */

async function seedRest(ctx: Ctx): Promise<void> {
  console.log('Notes, permissions and notifications');
  for (const n of world.NOTES) {
    const nb = ctx.notebooks.get(n.notebook);
    if (!nb) continue;
    const th = n.fromThread ? ctx.threads.get(n.fromThread) : undefined;
    const fromMessage = th && n.fromMessage ? (th.msgs.get(n.fromMessage) ?? null) : null;
    const content = n.content ?? (th && n.fromMessage ? (th.texts.get(n.fromMessage) ?? '') : '');
    const created = when(n.daysAgo, 13);
    await sql`
      insert into core.notes (id, notebook_id, kind, title, content_md, from_message_id, pinned_at, created_at, updated_at)
      values (${sid('not')}, ${nb.id}, ${fromMessage ? 'ai' : 'human'}, ${n.title}, ${content}, ${fromMessage},
        ${n.pinned ? created : null}, ${created}, ${created})`;
  }
  log(`${world.NOTES.length} notes, two of them saved from answers`);

  const grantIds: string[] = [];
  for (const g of world.GRANTS) {
    const id = sid('gnt');
    grantIds.push(id);
    const scopeRef =
      g.scope === 'notebook'
        ? (ctx.notebooks.get(g.notebook ?? '')?.id ?? null)
        : g.scope === 'workspace'
          ? ctx.workspaceId
          : null;
    await sql`
      insert into core.grants (id, user_id, principal, action_pattern, resource_pattern, effect, tier, scope, scope_ref,
        uses, last_used_at, created_at)
      values (${id}, ${ctx.userId}, 'agent:default', ${g.action}, ${g.resource}, ${g.effect ?? 'allow'}, 'gated',
        ${g.scope}, ${scopeRef}, ${g.uses}, ${when(Math.max(0, g.daysAgo - 3), 15)}, ${when(g.daysAgo, 15)})`;
  }
  for (const d of world.DECISIONS) {
    await sql`
      insert into core.decisions (id, at, user_id, principal, action, resource, tier, outcome, grant_id, trace_id)
      values (${sid('dec')}, ${when(d.daysAgo, 15, 7)}, ${ctx.userId}, 'agent:default', ${d.action}, ${d.resource},
        ${d.tier}, ${d.outcome}, ${d.grant !== undefined ? (grantIds[d.grant] ?? null) : null}, ${traceId()})`;
  }
  log(`${world.GRANTS.length} standing permissions and ${world.DECISIONS.length} past decisions`);

  for (const n of world.NOTIFICATIONS) {
    const created = new Date(Date.now() - n.hoursAgo * 3_600_000);
    await sql`
      insert into core.notifications (id, user_id, kind, level, title, body, read_at, created_at)
      values (${sid('ntf')}, ${ctx.userId}, ${n.kind}, ${n.level}, ${n.title}, ${n.body},
        ${n.read ? created : null}, ${created})`;
  }
  log(`${world.NOTIFICATIONS.length} notifications`);
}

/* ---- Merge and the waiting approval (through Core itself) ------------------------------------- */

async function seedMerge(ctx: Ctx): Promise<void> {
  for (const t of world.THREADS) {
    if (!t.merge) continue;
    const th = ctx.threads.get(t.key);
    if (!th) continue;
    const res = await api<{ thread_id: string }>('POST', '/merge', {
      thread_id: th.id,
      a: th.msgs.get(t.merge.a),
      b: th.msgs.get(t.merge.b),
      strategy: 'manual',
      picks: t.merge.picks.map((k) => th.msgs.get(k)),
      title: t.merge.title,
    });
    ctx.manifest.threads.push(res.thread_id);
    const at = when(t.daysAgo, t.hour, 40);
    await sql`update core.messages set created_at = ${at} where thread_id = ${res.thread_id}`;
    await sql`update core.threads set notebook_id = ${ctx.notebooks.get(t.notebook ?? '')?.id ?? null},
      created_at = ${at}, updated_at = ${at} where id = ${res.thread_id}`;
    log(`merged "${t.title}" into "${t.merge.title}"`);
  }
  await saveManifest(ctx);
}

async function seedApproval(ctx: Ctx): Promise<void> {
  const t = world.THREADS.find((x) => x.approval);
  const th = t ? ctx.threads.get(t.key) : undefined;
  if (!t?.approval || !th) return;
  const a = t.approval;
  const started = await api<{ run_id: string; user_message_id: string; assistant_message_id: string }>(
    'POST',
    `/threads/${th.id}/messages`,
    {
      parent_id: th.msgs.get(t.head),
      parts: [
        { type: 'text', text: `/tool fs_write ${JSON.stringify({ path: a.path, content: a.content })}` },
      ],
      model: 'offline/test',
    },
  );
  let approvalId: string | null = null;
  for (let i = 0; i < 40 && !approvalId; i++) {
    const list = await api<{ items: { id: string; run_id: string }[] } | { id: string; run_id: string }[]>(
      'GET',
      '/approvals',
    );
    const items = Array.isArray(list) ? list : list.items;
    approvalId = items.find((x) => x.run_id === started.run_id)?.id ?? null;
    if (!approvalId) await sleep(500);
  }
  if (!approvalId) {
    log('! the approval did not appear; skipped');
    return;
  }
  // Say it as a person would have: the directive was only how the sample asked for the tool.
  await sql`update core.messages set parts = ${sql.json([{ type: 'text', text: a.ask }] as never)}
    where id = ${started.user_message_id}`;
  const msg = await sql<
    { parts: Part[] }[]
  >`select parts from core.messages where id = ${started.assistant_message_id}`;
  const reword = (parts: Part[]) =>
    parts.map((p) =>
      p.type === 'text' && p.text.startsWith('Calling') ? { ...p, text: `${a.intro}\n\n` } : p,
    );
  await sql`update core.messages set parts = ${sql.json(reword(msg[0]?.parts ?? []) as never)},
    requested_model_id = ${world.MODELS.sonnet} where id = ${started.assistant_message_id}`;
  // The Cockpit redraws a live run from its event log, so say it there too.
  await sql`update core.run_events set data = data || ${sql.json({
    model_id: world.MODELS.sonnet,
    display_name: NAMES.sonnet,
  })} where run_id = ${started.run_id} and type = 'model'`;
  await sql`update core.run_events set data = data || ${sql.json({ delta: `${a.intro}\n\n` })}
    where run_id = ${started.run_id} and type = 'text.delta' and data->>'delta' like 'Calling%'`;
  const run = await sql<
    { checkpoint: { parts?: Part[] } }[]
  >`select checkpoint from core.runs where id = ${started.run_id}`;
  const cp = run[0]?.checkpoint;
  if (cp?.parts) {
    cp.parts = reword(cp.parts);
    await sql`update core.runs set checkpoint = ${sql.json(cp as never)} where id = ${started.run_id}`;
  }
  log(`one approval waiting: write ${a.path}`);
}

/* ---- Main ------------------------------------------------------------------------------- */

async function saveManifest(ctx: Ctx): Promise<void> {
  await sql`
    insert into core.settings (key, value, updated_at) values (${MANIFEST_KEY}, ${sql.json(ctx.manifest as never)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  await api('GET', '/system/health').catch(() => {
    throw new Error('Core is not answering. Start the stack with `pnpm start`, then run `pnpm seed` again.');
  });
  await reset();
  if (args.has('--reset')) {
    console.log('Done. Your own data was left as it was.');
    return;
  }

  const owner = await sql<{ user_id: string; workspace_id: string }[]>`
    select user_id, workspace_id from core.members where role = 'owner' order by workspace_id limit 1`;
  if (!owner[0]) throw new Error('No workspace yet. Start Core once with `pnpm start`, then seed.');
  const ctx: Ctx = {
    userId: owner[0].user_id,
    workspaceId: owner[0].workspace_id,
    notebooks: new Map(),
    threads: new Map(),
    manifest: {
      version: 1,
      seeded_at: new Date().toISOString(),
      sources: [],
      threads: [],
      memory_created: [],
    },
    searchCache: new Map(),
  };
  await saveManifest(ctx);

  await seedNotebooks(ctx);
  console.log('Threads');
  for (const t of world.THREADS) await seedThread(ctx, t);
  await saveManifest(ctx);
  await seedMemory(ctx);
  await stampMemoryPacks(ctx);
  await seedRest(ctx);
  await seedMerge(ctx);
  await seedApproval(ctx);
  // Notebooks sort by when they were last touched: the latest thread in each.
  await sql`
    update core.notebooks n set updated_at = coalesce(
      (select max(t.updated_at) from core.threads t where t.notebook_id = n.id), n.updated_at)
    where n.id like 'nbk\\_SEED%'`;
  await saveManifest(ctx);
  console.log('\nDone. Open the Cockpit and look around; `pnpm seed --reset` takes it all out again.');
}

try {
  await main();
} catch (err) {
  console.error(`\nSeeding stopped: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
