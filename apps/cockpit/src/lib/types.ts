/**
 * ------------------------------------------------------------------
 *  Title    |  Cockpit view types
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The shapes screens render. Wire types come from
 *           |  @nvx/contracts; these are the view-side projections
 *           |  (a thread path with display segments, tree nodes with
 *           |  branch colour) that the API layer maps into.
 *  Note     |  Messages from Core carry their parts and render as
 *           |  streaming markdown; demo fixtures hand-build `blocks`
 *           |  (with claims and citations) until Phase 3/4 produce
 *           |  those from real answers.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';

export type Hue = 'coral' | 'amber' | 'jade' | 'cyan' | 'azure' | 'magenta' | 'chalk';

export interface ModelView {
  id: string;
  name: string;
  provider: string;
  hue: Hue;
  via: 'direct' | 'controller';
  contextWindow: number;
  note?: string;
  /** From Core: whether it can answer now. Fixtures are always ready. */
  status?: 'ready' | 'needs_key' | 'disabled';
  offline?: boolean;
  /** False for embedding and rerank models: listed in settings, never chosen for chat. */
  chat?: boolean;
  /** Added in Settings → Models: can be edited and removed. */
  custom?: boolean;
  /** Where an OpenAI-compatible model is served. */
  baseUrl?: string | null;
  /** The hue you chose for its chip; absent follows the family. */
  chosenHue?: Hue;
  /** The name of the stored key it uses, if any. */
  keyName?: string | null;
}

export interface NotebookView {
  id: string;
  title: string;
  sources: number;
  threads: number;
  updatedAt: string;
  description?: string | null;
  icon?: string | null;
  /** An identity-ramp hue name; null takes the default. */
  color?: string | null;
  pinned?: boolean;
  notes?: number;
  archived?: boolean;
  /** Grounded mode: every answer here is fact-checked when it finishes. */
  grounded?: boolean;
}

export interface ThreadSummary {
  id: string;
  title: string;
  notebookId: string | null;
  updatedAt: string;
  branches: number;
  live?: boolean;
  pinned?: boolean;
  archived?: boolean;
}

export type Verdict = 'verified' | 'unverified' | 'contradicted';

export interface Span {
  text: string;
  cite?: number;
  claim?: { id: string; verdict: Verdict };
  code?: boolean;
}

export type Block =
  | { kind: 'p'; spans: Span[] }
  | { kind: 'ul'; items: Span[][] }
  | { kind: 'h'; text: string };

export interface CitationView {
  marker: number;
  sourceId: string;
  title: string;
  quote: string;
  location: string;
}

export interface MessageView {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  /** Hand-built display segments (demo fixtures). */
  blocks: Block[];
  /** Provider-neutral parts from Core, rendered as markdown and tool steps. */
  parts?: Part[];
  modelId: string | null;
  fallback?: { from: string; reason: string };
  siblings?: { index: number; count: number; ids?: string[] };
  citations?: CitationView[];
  confidence?: number;
  usage?: { tokens: number; costUsd: number; ms?: number };
  createdAt: string;
  status?: 'complete' | 'streaming' | 'pending' | 'stopped' | 'error';
  /** The run producing this message, while it is still running. */
  runId?: string | null;
  /** Who wrote it when it is not a configured model (the lab). */
  modelName?: string | null;
  /** A lab answer: its run (for changes and undo) and whether it was undone. */
  lab?: { runId: string; undone: boolean } | null;
  /** Shown under a failed answer. */
  error?: { title: string; hint: string } | null;
  /** What Core recorded about how this answer was made (models tried, sources found). */
  provenance?: import('./mappers').Provenance;
}

export interface ThreadView {
  id: string;
  title: string;
  notebookId: string | null;
  tldr?: string;
  messages: MessageView[];
  /** The model this thread asks first, if one was chosen. */
  model?: string | null;
  /** A run still producing the last message: attach its stream. */
  activeRun?: { id: string; messageId: string | null } | null;
}

export interface TreeNodeView {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  preview: string;
  modelId: string | null;
  collapsed: number;
  branch: { name: string; hue: Hue } | null;
  active: boolean;
}

export interface SourceView {
  id: string;
  title: string;
  kind: 'file' | 'url' | 'text' | 'thread';
  status: 'queued' | 'ready' | 'enriching' | 'embedding' | 'extracting' | 'stale' | 'failed';
  detail: string;
  contextLevel: 'off' | 'insights' | 'full';
  tags: string[];
  uri?: string | null;
  mime?: string | null;
  bytes?: number | null;
  summary?: string | null;
  chunks?: number;
  pages?: number | null;
  /** 0..1 while a stage reports counts. */
  progress?: number | null;
  error?: { title: string; hint: string } | null;
  duplicateOf?: { sourceId: string; title: string; kind: string } | null;
  createdAt?: string;
}

export interface EvidenceView {
  claimId: string;
  claim: string;
  verdict: Verdict;
  confidence: number;
  support: { source: string; quote: string; stance: 'supports' | 'contradicts' }[];
  rationale: string;
}

export interface ExplainView {
  answered: string;
  requested: string | null;
  attempts: { model: string; outcome: string; reason: string | null; ms: number }[];
  memory: { path: string; commit: string; entries: string[]; tokens: number }[];
  retrieval: { title: string; score: number; rerank: number; cited: boolean }[];
  tools: { tool: string; outcome: string }[];
  usage: { input: number; output: number; costUsd: number };
}

export interface PendingApproval {
  id: string;
  runId?: string;
  threadId?: string | null;
  tool: string;
  action: string;
  resource: string;
  tier: 'gated' | 'critical';
  argsPreview: string;
  suggestions: string[];
  reason: string;
}

export interface ServiceHealth {
  service: string;
  status: 'ok' | 'degraded' | 'down' | 'restarting';
  latencyMs: number | null;
  detail: string;
  failures: number;
}

export interface LiveState {
  modelId: string;
  context: { ratio: number; used: number; window: number };
  node: { name: string; state: 'running' | 'stopped' | 'waking' | 'error'; rate: number } | null;
  approvals: number;
  health: 'ok' | 'degraded' | 'down';
}
