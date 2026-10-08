/**
 * ------------------------------------------------------------------
 *  Title    |  Notebooks, sources, search and notes
 *  Ref      |  DESIGN.md §3.2, §4.1, §4.2 · ROADMAP.md Phase 3
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  One set of shapes for both hops: Cockpit ↔ Core
 *           |  (/api/v1) and Core ↔ Knowledge (/kn/v1). Core owns
 *           |  notebooks and notes; Knowledge owns sources, chunks,
 *           |  embeddings and search.
 *  How      |  Offsets are into the source's extracted markdown, so a
 *           |  citation opens the exact span: markdown.slice(char_start,
 *           |  char_end) is the quoted text. PDFs also map offsets to
 *           |  pages.
 * ------------------------------------------------------------------
 */
import { z } from 'zod';

/* ---- Notebooks (Core) ---------------------------------------------------- */

export const Notebook = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  /** An icon name from the Cockpit's set; null shows the default. */
  icon: z.string().nullable(),
  /** A hue token name (violet, gilt, sky…); null shows the default. */
  color: z.string().nullable(),
  pinned: z.boolean().default(false),
  /** Grounded mode: every answer here is fact-checked when it finishes. */
  grounded: z.boolean().default(false),
  archived_at: z.string().nullable(),
  last_opened_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  counts: z.object({
    sources: z.number().int(),
    threads: z.number().int(),
    notes: z.number().int(),
  }),
});
export type Notebook = z.infer<typeof Notebook>;

export const CreateNotebookRequest = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    icon: z.string().max(40).nullable().optional(),
    color: z.string().max(40).nullable().optional(),
  })
  .strict();

export const PatchNotebookRequest = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable(),
    icon: z.string().max(40).nullable(),
    color: z.string().max(40).nullable(),
    pinned: z.boolean(),
    archived: z.boolean(),
    grounded: z.boolean(),
  })
  .partial()
  .strict();

/* ---- Sources (Knowledge) ------------------------------------------------- */

export const SourceKind = z.enum(['file', 'url', 'text', 'thread']);
export type SourceKind = z.infer<typeof SourceKind>;

export const SourceStatus = z.enum(['queued', 'extracting', 'enriching', 'embedding', 'ready', 'failed']);
export type SourceStatus = z.infer<typeof SourceStatus>;

/** What a notebook's questions may draw from one source. */
export const ContextLevel = z.enum(['off', 'insights', 'full']);
export type ContextLevel = z.infer<typeof ContextLevel>;

export const SourceProgress = z.object({
  stage: SourceStatus,
  /** "Extracting page 14 of 52", "Embedding 1,204 chunks". */
  message: z.string(),
  done: z.number().int().nullable().default(null),
  total: z.number().int().nullable().default(null),
});

export const SourceError = z.object({ code: z.string(), title: z.string(), hint: z.string() });

export const Source = z.object({
  id: z.string(),
  kind: SourceKind,
  title: z.string(),
  /** The URL, the original file name, or the thread id. */
  uri: z.string().nullable(),
  mime: z.string().nullable(),
  bytes: z.number().int().nullable(),
  status: SourceStatus,
  progress: SourceProgress.nullable(),
  error: SourceError.nullable(),
  tags: z.array(z.string()),
  /** Short summary, once one exists. */
  summary: z.string().nullable(),
  chunks: z.number().int(),
  pages: z.number().int().nullable(),
  /** A URL source whose page changed since it was fetched. */
  stale: z.boolean(),
  fetched_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Present when listed inside a notebook. */
  context_level: ContextLevel.optional(),
  /** An existing source this one duplicates, until merged or dismissed. */
  duplicate_of: z
    .object({
      source_id: z.string(),
      title: z.string(),
      kind: z.enum(['duplicate', 'near_duplicate', 'new_version']),
      score: z.number(),
    })
    .nullable()
    .default(null),
});
export type Source = z.infer<typeof Source>;

/** JSON body for url, text and thread sources; files go as multipart (field "file", plus "notebook_id"). */
export const AddSourceRequest = z
  .object({
    kind: z.enum(['url', 'text', 'thread']),
    notebook_id: z.string().optional(),
    url: z.string().url().max(4000).optional(),
    text: z.string().max(5_000_000).optional(),
    thread_id: z.string().optional(),
    title: z.string().max(400).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const need = { url: b.url, text: b.text, thread: b.thread_id }[b.kind];
    if (!need)
      ctx.addIssue({
        code: 'custom',
        message: `${b.kind} sources need their ${b.kind === 'thread' ? 'thread_id' : b.kind}`,
      });
  });
export type AddSourceRequest = z.infer<typeof AddSourceRequest>;

export const PatchSourceRequest = z
  .object({ title: z.string().trim().min(1).max(400), tags: z.array(z.string().max(60)).max(40) })
  .partial()
  .strict();

export const NotebookSourceRequest = z
  .object({ source_id: z.string(), context_level: ContextLevel.optional() })
  .strict();

export const PatchNotebookSourceRequest = z.object({ context_level: ContextLevel }).strict();

export const SourcePage = z.object({
  page: z.number().int(),
  char_start: z.number().int(),
  char_end: z.number().int(),
});

/** The extracted text a source viewer shows, with page boundaries for PDFs. */
export const SourceContent = z.object({
  source_id: z.string(),
  version: z.number().int(),
  markdown: z.string(),
  pages: z.array(SourcePage),
  /** Headings with offsets, for the viewer's outline. */
  outline: z.array(z.object({ level: z.number().int(), title: z.string(), char_start: z.number().int() })),
});
export type SourceContent = z.infer<typeof SourceContent>;

export const MergeSourcesRequest = z
  .object({
    /** The source to keep. */
    keep_id: z.string(),
    /** The source folded into it and removed. */
    drop_id: z.string(),
  })
  .strict();

export const DismissDuplicateRequest = z.object({ a_id: z.string(), b_id: z.string() }).strict();

/* ---- Search -------------------------------------------------------------- */

export const SearchMode = z.enum(['hybrid', 'vector', 'text']);

export const SearchRequest = z
  .object({
    query: z.string().trim().min(1).max(4000),
    notebook_id: z.string().optional(),
    source_ids: z.array(z.string()).max(200).optional(),
    k: z.number().int().min(1).max(100).default(12),
    mode: SearchMode.default('hybrid'),
    rerank: z.boolean().default(true),
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequest>;

export const SearchHit = z.object({
  /** A chunk, or a source's insight when its context level is "insights". */
  kind: z.enum(['chunk', 'insight']),
  chunk_id: z.string(),
  source_id: z.string(),
  source_title: z.string(),
  text: z.string(),
  heading_path: z.array(z.string()),
  page: z.number().int().nullable(),
  char_start: z.number().int(),
  char_end: z.number().int(),
  score: z.number(),
  rerank_score: z.number().nullable(),
  /** Ranks before fusion, for the "why" view. */
  ranks: z.object({ vector: z.number().int().nullable(), text: z.number().int().nullable() }),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResponse = z.object({
  hits: z.array(SearchHit),
  mode: SearchMode,
  embedder: z.string().nullable(),
  ms: z.number(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/* ---- Notes (Core) -------------------------------------------------------- */

export const Note = z.object({
  id: z.string(),
  notebook_id: z.string(),
  kind: z.enum(['human', 'ai']),
  title: z.string(),
  content_md: z.string(),
  from_message_id: z.string().nullable(),
  pinned: z.boolean().default(false),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Note = z.infer<typeof Note>;

export const CreateNoteRequest = z
  .object({
    title: z.string().trim().min(1).max(300),
    content_md: z.string().max(1_000_000).default(''),
  })
  .strict();

export const PatchNoteRequest = z
  .object({
    title: z.string().trim().min(1).max(300),
    content_md: z.string().max(1_000_000),
    pinned: z.boolean(),
  })
  .partial()
  .strict();

export const MessageToNoteRequest = z
  .object({ notebook_id: z.string(), title: z.string().trim().min(1).max(300).optional() })
  .strict();

/* ---- Retrieval trace (Core writes it into an answer's provenance) -------- */

/** What a grounded answer was given and what it used: the "why" view reads this. */
export const RetrievalTrace = z.object({
  query: z.string(),
  notebook_id: z.string(),
  mode: SearchMode,
  embedder: z.string().nullable(),
  ms: z.number(),
  hits: z.array(
    z.object({
      /** The number the model was told to cite this passage by. */
      marker: z.number().int(),
      kind: z.enum(['chunk', 'insight']),
      chunk_id: z.string(),
      source_id: z.string(),
      source_title: z.string(),
      page: z.number().int().nullable(),
      score: z.number(),
      rerank_score: z.number().nullable(),
      ranks: z.object({ vector: z.number().int().nullable(), text: z.number().int().nullable() }),
      cited: z.boolean(),
    }),
  ),
  /** Citation numbers in the answer that matched no passage; stripped before it was saved. */
  invalid_markers: z.number().int().default(0),
  /** Every paragraph that states something carries at least one valid citation. */
  grounded: z.boolean().default(false),
});
export type RetrievalTrace = z.infer<typeof RetrievalTrace>;
