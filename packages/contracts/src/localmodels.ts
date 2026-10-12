/**
 * ------------------------------------------------------------------
 *  Title    |  Local models: one-click download
 *  Ref      |  docs/models.md (Download a local model) · ROADMAP track E
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes behind Admin → Models → Download a local
 *           |  model: the curated list (config/local-models.yaml),
 *           |  what this computer has (memory, graphics card, disk),
 *           |  whether each model fits, Ollama's state, and a
 *           |  download's progress.
 *  How      |  GET /local-models answers LocalModelsView. POST
 *           |  /local-models/:id/download starts (or resumes) a
 *           |  download and answers a LocalDownload; GET
 *           |  /local-models/downloads/:id follows it; POST
 *           |  …/cancel stops it (Ollama keeps what it has, so the
 *           |  next start resumes).
 *  Note     |  Nothing is ever installed without a click: when Ollama
 *           |  is missing the view says how to get it from ollama.com.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** One model in the curated list. Sizes are about right, from the publisher's page. */
export const LocalModelEntry = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    name: z.string().min(1),
    /** chat: answers questions. embedder: turns text into vectors for search. */
    kind: z.enum(['chat', 'embedder']).default('chat'),
    /** How it is fetched: Ollama's pull, or fastembed's own download (the embedder). */
    via: z.enum(['ollama', 'fastembed']).default('ollama'),
    /** Ollama's tag ("qwen3:8b") or fastembed's model name ("BAAI/bge-small-en-v1.5"). */
    source: z.string().min(1),
    /** Download size in GB. */
    size_gb: z.number().positive(),
    /** Memory to run it on the processor alone, in GB. */
    ram_gb: z.number().positive(),
    /** Graphics memory to run it fully on the graphics card, in GB; null: runs on the processor. */
    vram_gb: z.number().positive().nullable().default(null),
    licence: z.string().min(1),
    licence_url: z.string().url().optional(),
    /** What it is good for, one sentence. */
    good_for: z.string().min(1),
    context_window: z.number().int().positive().default(8_192),
    capabilities: z.array(z.enum(['tools', 'json', 'vision', 'reasoning', 'embeddings'])).default([]),
    family: z.string().min(1),
    /** Shown first. */
    recommended: z.boolean().default(false),
  })
  .strict();
export type LocalModelEntry = z.infer<typeof LocalModelEntry>;

export const LocalModelsFile = z.object({
  version: z.literal(1),
  models: z.array(LocalModelEntry),
});
export type LocalModelsFile = z.infer<typeof LocalModelsFile>;

/** What this computer has, as far as can be told without asking anyone. */
export const LocalHardware = z.object({
  os: z.enum(['windows', 'macos', 'linux', 'other']),
  ram_gb: z.number().nonnegative(),
  /** null: no graphics card found (there may still be one). */
  gpu: z
    .object({
      name: z.string(),
      /** null: shared with the system's memory (Apple silicon) or not reported. */
      vram_gb: z.number().nonnegative().nullable(),
      shared: z.boolean(),
    })
    .nullable(),
  /** Free space where Ollama keeps models; null when it cannot be read (Ollama on another machine). */
  disk_free_gb: z.number().nonnegative().nullable(),
  disk_where: z.string().nullable(),
});
export type LocalHardware = z.infer<typeof LocalHardware>;

/**
 * good: runs well. slow: fits, on the processor or only just. no: will not
 * fit. unknown: Ollama runs on another computer, whose memory and disk
 * cannot be read from here.
 */
export const LocalFit = z.object({
  verdict: z.enum(['good', 'slow', 'no', 'unknown']),
  /** Plain sentences, each one reason ("Needs about 9 GB of disk; 4 GB free on drive C:"). */
  reasons: z.array(z.string()),
  /** What stops it: no room on disk, not enough memory. */
  blocker: z.enum(['disk', 'memory']).nullable(),
});
export type LocalFit = z.infer<typeof LocalFit>;

export const OllamaState = z.object({
  /** running: it answered. installed: found on this computer, not answering. missing: neither. */
  status: z.enum(['running', 'installed', 'missing', 'remote_unreachable']),
  url: z.string(),
  version: z.string().nullable(),
  /** The official page for this computer's system. */
  download_url: z.string().url(),
  /** Linux: the official install command, to copy (never run for you). */
  install_command: z.string().nullable(),
  /** Ollama runs on this computer (its disk is the one checked). */
  local: z.boolean(),
});
export type OllamaState = z.infer<typeof OllamaState>;

export const LocalDownloadStatus = z.enum([
  'starting',
  'downloading',
  'verifying',
  'done',
  'failed',
  'cancelled',
]);
export type LocalDownloadStatus = z.infer<typeof LocalDownloadStatus>;

export const LocalDownload = z.object({
  id: z.string(),
  model: z.string(),
  status: LocalDownloadStatus,
  /** Bytes, when the source says; null while it is still working it out. */
  completed: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().nullable(),
  /** What the source is doing ("pulling manifest", "verifying sha256 digest"). */
  step: z.string().nullable(),
  /** Picked up a download that had stopped part way. */
  resumed: z.boolean(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  /** The model id it can be picked by, once done. */
  model_id: z.string().nullable(),
  error: z.object({ code: z.string(), title: z.string(), hint: z.string() }).nullable(),
});
export type LocalDownload = z.infer<typeof LocalDownload>;

export const LocalModelView = LocalModelEntry.extend({
  fit: LocalFit,
  /** Already on this computer (Ollama lists it, or fastembed has it cached). */
  installed: z.boolean(),
  /** In the model picker now. */
  model_id: z.string().nullable(),
  download: LocalDownload.nullable(),
});
export type LocalModelView = z.infer<typeof LocalModelView>;

export const LocalModelsView = z.object({
  hardware: LocalHardware,
  ollama: OllamaState,
  items: z.array(LocalModelView),
});
export type LocalModelsView = z.infer<typeof LocalModelsView>;

export const LocalDownloadRequest = z
  .object({
    /** Start even though it will be slow or tight on memory (never past a full disk). */
    anyway: z.boolean().default(false),
  })
  .strict();
export type LocalDownloadRequest = z.infer<typeof LocalDownloadRequest>;
