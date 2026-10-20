/**
 * ------------------------------------------------------------------
 *  Title    |  Memory service
 *  Ref      |  DESIGN.md §6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The one way memory is read and written: the editor's
 *           |  saves, the inbox's decisions, what capture learns after a
 *           |  turn, and the pack injected before every model call.
 *  How      |  Files in git (repo.ts) are the truth; the index
 *           |  (index.ts) is derived and refreshed after every write.
 *           |  A change capture wants to make becomes a proposal row
 *           |  first, then (if the policy says so) a commit, so every
 *           |  automatic change has an id, a reason and an Undo.
 *  Note     |  Capture runs after the answer is saved and never throws
 *           |  into the turn: a broken utility model means nothing is
 *           |  learned this time, not a failed reply.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type CompareRequest,
  type CompareResponse,
  type HindsightResponse,
  type MemoryCommit,
  type MemoryEntryView,
  type MemoryFileContent,
  type MemoryFileList,
  type MemoryFile as MemoryFileSchema,
  type MemoryKind,
  type MemoryPreview,
  type MemoryProposal,
  type MemoryProposalList,
  type Part,
  type ProposalDecisionRequest,
  type ProposalScope,
  type PutMemoryFileResponse,
} from '@nvx/contracts';
import { MemoryConflict } from '@nvx/plugin-sdk';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { pathFor } from '../conductor/context';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import type { PrivacyPolicies } from '../privacy/policy';
import { SETTING, type SettingsStore } from '../settings';
import { type ThreadRepo, textOf } from '../threads/repo';
import {
  applyPolicy,
  asEntry,
  type CaptureCandidate,
  CorrectionDetection,
  checkDecision,
  contrast,
  correctionSignal,
  FailureLesson,
  failureEpisodes,
  formatNeighbours,
  lessonLocally,
  lessonText,
  ownWords,
  PROMPTS,
  ReconcileOutput,
  reconcileLocally,
  reversalSignal,
  reversalStatement,
  scrubPaths,
  staleStatement,
  topicSlug,
} from './capture';
import {
  COMPARE_CHARS,
  COMPARE_PROMPT,
  COMPARE_TOKENS,
  CompareResult,
  checkRubric,
  detectExample,
  differenceText,
  type ExampleDetection,
  exampleBlock,
  STANDARD_PROMPT,
  StandardRubric,
  standardPath,
  standardText,
} from './examples';
import { detectExplicit } from './explicit';
import { addEntry, type EntryMeta, parseMemory, renderMemory, supersedeEntry, updateEntry } from './format';
import {
  clearsBar,
  episodeVerified,
  findWatch,
  lapsed,
  laterSuccesses,
  needsSightings,
  SIGHTINGS_NEEDED,
  uncertaintyFor,
  watchExpiry,
} from './gates';
import { checkReview, condense, HINDSIGHT_PROMPT, HindsightReview, turnsOf } from './hindsight';
import { type IndexedEntry, indexFile, isGuideFile, type MemoryIndex, similarity, words } from './index';
import {
  approxTokens,
  buildMemoryPack,
  CAPTURE_NOTE,
  type InjectFile,
  type MemoryPack,
  memoryBudget,
} from './inject';
import type { Utility, UtilityOutcome } from './llm';
import {
  condensePassive,
  emptyLedger,
  IDLE_MS,
  type Ledger,
  type Mention,
  PASSIVE_MAX_ITEMS,
  PASSIVE_PROMPT,
  PassiveReview,
  parseLedger,
  passiveTurns,
  recordMention,
  SweepLimiter,
  statementsIn,
  worthAsking,
} from './passive';
import type { ProposalStore } from './proposals';
import { KeyedQueue, Queue } from './queue';
import {
  formatCommitMessage,
  type GitMemoryProvider,
  MemoryMergeConflict,
  safeMemoryPath,
  scopeOf,
} from './repo';

/** Characters of the user's own words beyond which a message reads as a paste (DESIGN.md §6.3). */
const LONG_MESSAGE = 600;

const log = logFor('memory');

export type MemoryConfig = z.infer<typeof MemoryFileSchema>;
export type CaptureMode = MemoryConfig['capture'];
type TypeSpec = MemoryConfig['types'][string];

/** config/memory.yaml as shipped, for when no file is loaded (tests, a bare build). */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  version: 1,
  budget: { share_of_context: 0.08, max_tokens: 4000 },
  capture: 'auto_confident',
  remote: null,
  types: {
    agents: { path: 'AGENTS.md', scope: 'global', priority: 100, budget_share: 0.25, auto_apply: null },
    user: { path: 'USER.md', scope: 'user', priority: 90, budget_share: 0.25, auto_apply: 0.85 },
    projects: {
      path: 'PROJECTS/{notebook}.md',
      scope: 'notebook',
      priority: 80,
      budget_share: 0.3,
      auto_apply: 0.85,
    },
    failures: {
      path: 'FAILURES/*.md',
      scope: 'retrieved',
      priority: 60,
      budget_share: 0.12,
      auto_apply: 0,
      top_k: 5,
    },
    standards: {
      path: 'STANDARDS/*.md',
      scope: 'retrieved',
      priority: 55,
      budget_share: 0.1,
      auto_apply: null,
      top_k: 3,
    },
    models: { path: 'MODELS/{model}.md', scope: 'model', priority: 50, budget_share: 0.08, auto_apply: 0.9 },
  },
};

export interface NotebookInfo {
  id: string;
  slug: string;
  title: string;
}

export interface MemoryServiceDeps {
  provider: GitMemoryProvider;
  index: MemoryIndex;
  proposals: ProposalStore;
  config: MemoryConfig;
  /** The person, for edits made in the editor. */
  user: { name: string; email: string };
  settings?: SettingsStore;
  bus?: EventBus;
  utility?: Utility;
  threads?: Pick<ThreadRepo, 'messages' | 'getMessage' | 'getThread'>;
  notebook?: (id: string) => Promise<NotebookInfo | null>;
  /** The clock, so watch items can be aged in tests. */
  now?: () => Date;
  /** Private notebooks: may passive memory learn here, and must it use a model on this machine? */
  privacy?: Pick<PrivacyPolicies, 'resolve'>;
  /**
   * How long a thread is quiet before it is looked at for things said in passing, in
   * milliseconds. 0 turns the timer off (tests call passiveSweep themselves). Default: IDLE_MS.
   */
  idleMs?: number;
}

/** What the conductor hands over after a turn. */
export interface TurnRecord {
  threadId: string;
  notebookId: string | null;
  userMessageId: string;
  assistantMessageId: string;
  runId: string;
  parts: Part[];
}

export interface PackRequest {
  notebookId: string | null;
  modelId: string;
  contextWindow: number;
  /** The current request, for picking relevant lessons. */
  query: string;
  /**
   * CA2: only the notes that do not depend on the question ('pinned'), or only
   * those ranked for it ('ranked'). Absent: both, as one block.
   */
  part?: 'pinned' | 'ranked';
  /**
   * Whether memory may be written from this thread's scope. False: the one-line capture note is left
   * out, so the model is never told Ancile saves things it will not. Absent: allowed (a preview).
   */
  memoryWrite?: boolean;
}

/** {model} in a path: the model id with "/" replaced by "__". */
export const modelSlug = (id: string) => id.replace(/[/\\:]/g, '__');

const today = () => new Date().toISOString().slice(0, 10);

/** Entry text that cannot break the file: one line, no comment markers. */
export function cleanEntry(text: string): string {
  return text
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function summarise(text: string): string {
  const t = text.replace(/\*\*/g, '').replace(/\.$/, '').trim();
  const s = t.charAt(0).toLowerCase() + t.slice(1);
  return s.length > 64 ? `${s.slice(0, 61).trimEnd()}…` : s;
}

const KIND_LABEL: Record<MemoryProposal['kind'], string> = {
  preference: 'correction',
  failure_lesson: 'failure then fix',
  project_finding: 'project finding',
  model_quirk: 'model quirk',
  manual: 'added by hand',
  imported: 'imported',
};

/** The start of the rationale of something the person asked to be remembered. */
const ASKED_NOTE = 'You asked me to remember this.';

/** What the commit says detected the change. */
function kindLabel(p: MemoryProposal, repeated: boolean): string {
  if (p.rationale.startsWith(ASKED_NOTE)) return 'asked';
  if (p.target_path.startsWith('STANDARDS/')) return 'standard from an example';
  if (p.rationale.startsWith('Noticed in passing'))
    return repeated ? 'said more than once' : 'noticed in passing';
  if (p.rationale.startsWith('Learned from a correction')) return repeated ? 'mistake said twice' : 'mistake';
  return KIND_LABEL[p.kind];
}

function globToRegExp(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{(notebook|model)\}|<(notebook|model)>/g, '[^/]+')
    .replace(/\*/g, '[^/]+');
  return new RegExp(`^${esc}$`);
}

export class MemoryService {
  private privacy: MemoryServiceDeps['privacy'];
  private readonly decisions = new KeyedQueue();
  private readonly filing = new Queue();

  constructor(private readonly deps: MemoryServiceDeps) {
    this.privacy = deps.privacy;
  }

  /** Where private-notebook rules come from; set once the privacy policies exist (and by tests). */
  setPrivacy(privacy: MemoryServiceDeps['privacy']): void {
    this.privacy = privacy;
  }

  get provider() {
    return this.deps.provider;
  }

  /** Create the repository, write what onboarding was told, index everything. */
  async start(): Promise<void> {
    await this.deps.provider.ensure();
    await this.seedAbout().catch((err) => log.warn({ err }, 'could not write the onboarding note to memory'));
    await this.deps.index.rebuild();
  }

  private async seedAbout(): Promise<void> {
    const s = this.deps.settings;
    if (!s) return;
    const about = await s.get<string>(SETTING.memoryAbout);
    if (!about?.trim() || (await s.get<boolean>('memory.about.written'))) return;
    const meta = { m: ulid().slice(-8).toLowerCase(), src: 'onboarding', at: today() };
    // start() indexes everything next, so there is nothing to refresh here.
    await this.deps.provider.update(
      'USER.md',
      ({ content }) =>
        renderMemory(addEntry(parseMemory(content ?? '# About me\n'), 'About', cleanEntry(about), meta)),
      formatCommitMessage({
        scope: 'user',
        summary: 'what you said about yourself at setup',
        body: [],
        trailers: {},
      }),
      this.deps.user,
    );
    await s.set('memory.about.written', true);
  }

  async captureMode(): Promise<CaptureMode> {
    const set = await this.deps.settings?.get<CaptureMode>(SETTING.memoryCapture).catch(() => undefined);
    return set ?? this.deps.config.capture;
  }

  async setCaptureMode(mode: CaptureMode): Promise<void> {
    await this.deps.settings?.set(SETTING.memoryCapture, mode);
  }

  typeOf(path: string): { name: string; spec: TypeSpec } | null {
    for (const [name, spec] of Object.entries(this.deps.config.types))
      if (globToRegExp(spec.path).test(path)) return { name, spec };
    return null;
  }

  private kindOf(path: string): MemoryKind {
    const n = this.typeOf(path)?.name;
    return n === 'agents' || n === 'user' || n === 'projects' || n === 'failures' || n === 'models'
      ? n
      : 'other';
  }

  /* ---- Files ----------------------------------------------------------------- */

  async files(): Promise<MemoryFileList> {
    const listed = await this.deps.provider.list();
    return {
      head: await this.deps.provider.head(),
      items: listed.map((f) => {
        const ix = this.deps.index.file(f.path);
        const t = this.typeOf(f.path);
        return {
          path: f.path,
          kind: this.kindOf(f.path),
          title: ix?.title ?? f.path.replace(/\.md$/, ''),
          version: f.version,
          updated_at: f.updatedAt,
          bytes: f.bytes,
          entries: ix?.entries.filter((e) => !e.superseded).length ?? 0,
          auto: !!t && t.spec.auto_apply !== null && !isGuideFile(f.path),
        };
      }),
    };
  }

  async file(path: string, version?: string): Promise<MemoryFileContent> {
    const r = await this.deps.provider.read(path, version);
    const ix = indexFile(path, r.content, r.version);
    return { path: ix.path, content: r.content, version: r.version, entries: ix.entries.map(entryView) };
  }

  async save(
    path: string,
    req: { content: string; base_sha: string | null; message?: string | undefined },
  ): Promise<PutMemoryFileResponse> {
    try {
      const r = await this.deps.provider.writeDetailed({
        path,
        content: req.content,
        baseVersion: req.base_sha,
        message: formatCommitMessage({
          scope: scopeOf(path),
          summary: req.message?.trim() || 'edited by hand',
          body: [],
          trailers: {},
        }),
        author: this.deps.user,
      });
      if (r.changed) await this.deps.index.refresh(path);
      return r;
    } catch (err) {
      if (err instanceof MemoryMergeConflict) {
        throw new AncileError({
          code: 'memory.conflict',
          title: 'This file changed while you were editing it',
          hint: 'Both versions are shown. Keep the lines you want, then save again.',
          status: 409,
          errorClass: 'permanent',
          context: {
            path: err.path,
            base: err.baseVersion,
            current: err.currentVersion,
            current_content: err.currentContent,
            merged_with_markers: err.mergedWithMarkers,
          },
        });
      }
      if (err instanceof MemoryConflict) {
        throw new AncileError({
          code: 'memory.conflict',
          title: 'This file changed while you were editing it',
          hint: 'Reload the file and make your change again.',
          status: 409,
          errorClass: 'permanent',
        });
      }
      throw err;
    }
  }

  private commitView(c: {
    version: string;
    at: string;
    author: string;
    message: string;
    body?: string;
  }): MemoryCommit {
    const body = c.body ?? '';
    return {
      sha: c.version,
      at: c.at,
      author: c.author,
      summary: c.message,
      body,
      automatic: c.author === this.deps.provider.author.name,
      proposal_id: /Ancile-Proposal: (mpr_[0-9A-Z]+)/.exec(body)?.[1] ?? null,
    };
  }

  async history(path: string, limit = 50): Promise<MemoryCommit[]> {
    const p = safeMemoryPath(path);
    return (await this.deps.provider.log(['--', p], limit)).map((c) => this.commitView(c));
  }

  async log(limit = 50): Promise<MemoryCommit[]> {
    return (await this.deps.provider.log([], limit)).map((c) => this.commitView(c));
  }

  async diff(a: string, b: string, path?: string): Promise<string> {
    return this.deps.provider.diff(a, b, path);
  }

  /** What a single commit changed. */
  async commitDiff(sha: string, path?: string): Promise<{ a: string; patch: string }> {
    const parent = await this.deps.provider.parentOf(sha);
    if (!parent) return { a: sha, patch: '' };
    return { a: parent, patch: await this.deps.provider.diff(parent, sha, path) };
  }

  /**
   * Delete a memory file. AGENTS.md, USER.md and the guide files stay: every
   * pack is built around them. The commit can be reverted from History.
   */
  async remove(path: string): Promise<{ version: string }> {
    // Case-blind: on Windows and macOS "user.md" is the same file as USER.md.
    const lower = path.toLowerCase();
    if (lower === 'agents.md' || lower === 'user.md' || isGuideFile(path))
      throw new AncileError({
        code: 'memory.protected',
        title: `${path} can't be deleted`,
        hint: 'Every answer is built around it. Edit it instead, or clear the entries you no longer want.',
        status: 409,
        errorClass: 'permanent',
      });
    const r = await this.deps.provider.remove(
      path,
      formatCommitMessage({ scope: scopeOf(path), summary: 'deleted by hand', body: [], trailers: {} }),
      this.deps.user,
    );
    await this.deps.index.refresh(path);
    await this.withdrawAbout(path, { all: true }).catch(() => undefined);
    return r;
  }

  async revert(sha: string): Promise<{ version: string }> {
    const files = await this.deps.provider.filesOf(sha);
    const r = await this.deps.provider.revert(sha, this.deps.user);
    for (const f of files) if (f.endsWith('.md')) await this.deps.index.refresh(f);
    // A proposal whose change was just reverted is no longer in effect.
    for (const p of await this.deps.proposals.withCommit(sha))
      if (p.commit_sha === sha) await this.deps.proposals.update(p.id, { status: 'undone', decided: true });
    return r;
  }

  async search(q: string, limit = 20) {
    return {
      items: this.deps.index
        .search(q, { limit })
        .map((e) => ({ path: e.path, key: e.key, text: e.text, score: e.score })),
    };
  }

  /* ---- Proposals ------------------------------------------------------------- */

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** M8: watch items that were not seen again in time lapse. Returns how many. */
  async sweepWatches(): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const w of await this.deps.proposals.watching())
      if (lapsed(w, now)) {
        await this.deps.proposals.update(w.id, { status: 'expired', decided: true });
        n++;
      }
    return n;
  }

  /** M3: where a proposal was learned, if the thread and notebook are still there. */
  private async sourceOf(p: MemoryProposal): Promise<NonNullable<MemoryProposal['source']> | null> {
    const ev = p.evidence.find((e) => e.thread_id);
    if (!ev?.thread_id || !this.deps.threads) return null;
    const thread = await this.deps.threads.getThread(ev.thread_id).catch(() => undefined);
    const nb = thread?.notebook_id ? await this.deps.notebook?.(thread.notebook_id).catch(() => null) : null;
    return {
      thread_id: ev.thread_id,
      thread_title: thread?.title ?? null,
      thread_deleted: !thread,
      message_id: ev.message_id ?? null,
      notebook: thread?.notebook_id ? { id: thread.notebook_id, title: nb?.title ?? null } : null,
    };
  }

  async proposals(status?: MemoryProposal['status'][]): Promise<MemoryProposalList> {
    await this.sweepWatches().catch((err) => log.warn({ err }, 'could not age the watch items'));
    const items = await this.deps.proposals.list({ ...(status && { status }), limit: 200 });
    const cache = new Map<string, Promise<NonNullable<MemoryProposal['source']> | null>>();
    const withSource = await Promise.all(
      items.map(async (p) => {
        const tid = p.evidence.find((e) => e.thread_id)?.thread_id;
        if (!tid) return p;
        const src = cache.get(tid) ?? this.sourceOf(p);
        cache.set(tid, src);
        const source = await src;
        return source
          ? {
              ...p,
              source: { ...source, message_id: p.evidence.find((e) => e.thread_id)?.message_id ?? null },
            }
          : p;
      }),
    );
    return { items: withSource, pending: await this.deps.proposals.pending() };
  }

  /**
   * M1: where an approved suggestion goes when the person chose a scope or a file.
   * Lessons keep their own file; everything else can be kept for you, for the
   * notebook it was learned in, or everywhere.
   */
  private async retarget(
    p: MemoryProposal,
    req: { scope?: ProposalScope | undefined; path?: string | undefined },
  ): Promise<{ proposal: MemoryProposal; notebook: NotebookInfo | null }> {
    let notebook: NotebookInfo | null = null;
    const fixed = p.kind === 'failure_lesson' || p.kind === 'model_quirk';
    if (req.scope && fixed && !req.path)
      throw new AncileError({
        code: 'memory.scope_fixed',
        title: 'That kind of note stays in its own file',
        hint: 'Lessons and model quirks are kept by topic. Choose a file instead, or approve it as it is.',
        status: 400,
        errorClass: 'permanent',
      });

    // The notebook the thread belongs to, for "This notebook".
    const needNotebook = req.scope === 'notebook' && !req.path;
    if (needNotebook) {
      const tid = p.evidence.find((e) => e.thread_id)?.thread_id;
      const thread = tid ? await this.deps.threads?.getThread(tid).catch(() => undefined) : undefined;
      if (!thread?.notebook_id)
        throw new AncileError({
          code: 'memory.scope_unavailable',
          title: tid && !thread ? 'The thread this came from is gone' : 'This was not learned in a notebook',
          hint: 'Keep it for you or everywhere instead, or choose a file.',
          status: 409,
          errorClass: 'permanent',
        });
      notebook = (await this.deps.notebook?.(thread.notebook_id).catch(() => null)) ?? null;
      if (!notebook)
        throw new AncileError({
          code: 'memory.notebook_gone',
          title: 'That notebook no longer exists',
          hint: 'Keep it for you or everywhere instead, or choose a file.',
          status: 409,
          errorClass: 'permanent',
        });
    }

    let path = p.target_path;
    let section = p.section;
    if (req.path) {
      path = safeMemoryPath(req.path);
      if (!path.endsWith('.md') || isGuideFile(path) || !this.typeOf(path))
        throw new AncileError({
          code: 'memory.file_unknown',
          title: `${req.path} is not a memory file`,
          hint: 'Choose USER.md, AGENTS.md, a notebook file under PROJECTS, or a topic under FAILURES.',
          status: 400,
          errorClass: 'permanent',
        });
      section = this.sectionFor(path, p);
    } else if (req.scope === 'user') {
      path = 'USER.md';
      section = 'Preferences';
    } else if (req.scope === 'everywhere') {
      path = 'AGENTS.md';
      section = 'Rules';
    } else if (notebook) {
      path = `PROJECTS/${notebook.slug}.md`;
      section = 'Decisions';
    }
    if (path === p.target_path) return { proposal: p, notebook };
    // A different file: whatever it would have updated is not there.
    return {
      proposal: { ...p, target_path: path, section, op: 'add', target_key: null, target_text: null },
      notebook,
    };
  }

  private sectionFor(path: string, p: MemoryProposal): string {
    if (path === 'USER.md') return 'Preferences';
    if (path === 'AGENTS.md') return 'Rules';
    if (path.startsWith('PROJECTS/')) return 'Decisions';
    if (path.startsWith('FAILURES/')) return 'Lessons';
    if (path.startsWith('STANDARDS/')) return 'Standards';
    if (path.startsWith('MODELS/')) return 'Quirks';
    return p.section || 'Notes';
  }

  /**
   * One decision on a suggestion at a time. A double click on Approve, or two tabs, would
   * otherwise both find it waiting and both write it: the second now finds it already dealt with.
   */
  decide(id: string, req: ProposalDecisionRequest): Promise<MemoryProposal> {
    return this.decisions.run(id, () => this.decideNow(id, req));
  }

  private async decideNow(id: string, req: ProposalDecisionRequest): Promise<MemoryProposal> {
    const p = await this.deps.proposals.get(id);
    if (!p)
      throw new AncileError({
        code: 'memory.proposal_not_found',
        title: 'That memory suggestion does not exist',
        hint: 'Reload the inbox.',
        status: 404,
        errorClass: 'permanent',
      });
    const wrong = () =>
      new AncileError({
        code: 'memory.proposal_decided',
        title: 'That memory suggestion was already dealt with',
        hint: 'Reload the inbox to see where it stands.',
        status: 409,
        errorClass: 'permanent',
        context: { status: p.status },
      });

    // A watch item (M8) can be decided like any other: the person may trust it early or drop it.
    const open = p.status === 'proposed' || p.status === 'watching';
    if (req.decision === 'reject') {
      if (!open) throw wrong();
      return (await this.deps.proposals.update(id, { status: 'rejected', decided: true })) as MemoryProposal;
    }
    if (req.decision === 'approve') {
      if (!open) throw wrong();
      const text = req.text ? cleanEntry(req.text) : p.text;
      const moved = await this.retarget(p, req);
      const sha = await this.applyProposal({ ...moved.proposal, text }, false, moved.notebook);
      return (await this.deps.proposals.update(id, {
        status: 'applied',
        commit_sha: sha,
        text,
        target_path: moved.proposal.target_path,
        section: moved.proposal.section,
        op: moved.proposal.op,
        target_key: moved.proposal.target_key,
        target_text: moved.proposal.target_text,
        decided: true,
      })) as MemoryProposal;
    }
    // undo: a turned-down suggestion goes back to waiting (nothing was written, so nothing to revert)
    if (p.status === 'rejected') {
      return (await this.deps.proposals.update(id, { status: 'proposed' })) as MemoryProposal;
    }
    if ((p.status !== 'applied' && p.status !== 'auto_applied') || !p.commit_sha) throw wrong();
    await this.revert(p.commit_sha);
    return (await this.deps.proposals.get(id)) as MemoryProposal;
  }

  /** What a memory file starts as, before its first entry. */
  async newFileFor(path: string, notebook?: NotebookInfo | null): Promise<string> {
    const date = today();
    if (path.startsWith('PROJECTS/')) {
      const tpl = await this.deps.provider.read('PROJECTS/_template.md').catch(() => null);
      const title = notebook?.title ?? path.slice(9, -3);
      if (tpl)
        return tpl.content
          .replace(/\{\{notebook_id\}\}/g, notebook?.id ?? '')
          .replace(/\{\{notebook_title\}\}/g, title.replace(/"/g, "'"))
          .replace(/\{\{date\}\}/g, date);
      return `# ${title}\n\n## Decisions\n\n## Findings\n\n## Superseded\n`;
    }
    if (path.startsWith('FAILURES/')) {
      const topic = path.slice(9, -3).replace(/-/g, ' ');
      return `---\ntype: failures\nscope: retrieved\nupdated: ${date}\n---\n# ${topic.charAt(0).toUpperCase()}${topic.slice(1)}\n\n## Lessons\n`;
    }
    if (path.startsWith('STANDARDS/')) {
      const who = path.slice(10, -3).replace(/-/g, ' ');
      return `---\ntype: standards\nscope: retrieved\nupdated: ${date}\n---\n# Standard: ${who}\n\n## Standards\n`;
    }
    if (path.startsWith('MODELS/')) {
      return `---\ntype: models\nscope: model\nupdated: ${date}\n---\n# ${path.slice(7, -3).replace(/__/g, '/')}\n\n## Quirks\n`;
    }
    return `# ${path.replace(/\.md$/, '')}\n`;
  }

  /** Write a proposal's change and commit it. Returns the commit. */
  private async applyProposal(p: MemoryProposal, auto: boolean, nb?: NotebookInfo | null): Promise<string> {
    const provider = this.deps.provider;
    const path = p.target_path;
    const key = ulid().slice(-8).toLowerCase();
    const src = p.evidence.find((e) => e.message_id)?.message_id ?? p.evidence.find((e) => e.run_id)?.run_id;
    const meta: EntryMeta & { m: string } = {
      m: key,
      conf: Math.round(p.confidence * 100) / 100,
      ...(src && { src }),
      at: today(),
    };
    const text = cleanEntry(p.text);
    /** The file with this change made to it: built from the file as it is when the write's turn comes. */
    const change = async (current: { content: string | null }) => {
      let doc = parseMemory(current.content ?? (await this.newFileFor(path, nb)));
      const target = p.target_key && doc.blocks.some((b) => b.kind === 'entry' && b.key === p.target_key);
      if (p.op === 'update' && target) {
        doc = updateEntry(doc, p.target_key as string, text, {
          conf: meta.conf,
          ...(src && { src }),
          at: meta.at,
        });
      } else {
        doc = addEntry(doc, p.section, text, meta);
        if (p.op === 'supersede' && target)
          doc = supersedeEntry(doc, p.target_key as string, key, meta.at as string);
      }
      return renderMemory(doc);
    };
    const ev = p.evidence[0];
    const thread = ev?.thread_id
      ? await this.deps.threads?.getThread(ev.thread_id).catch(() => undefined)
      : undefined;
    // Said more than once (passive memory): every mention is listed, so the commit shows both.
    const later = p.evidence
      .slice(1)
      .filter((e) => e.thread_id || e.message_id)
      .map(
        (e) =>
          `Also said in thread ${e.thread_id ?? 'unknown'}${e.message_id ? `, message ${e.message_id}` : ''}.`,
      );
    const label = kindLabel(p, later.length > 0);
    const body = [
      ...(ev?.thread_id
        ? [
            `From thread "${thread?.title ?? 'Untitled'}" (${ev.thread_id})${ev.message_id ? `, message ${ev.message_id}` : ''}.`,
          ]
        : ev?.run_id
          ? [`From run ${ev.run_id}.`]
          : []),
      ...later,
      `${label === 'asked' ? 'You asked me to remember this' : `Detected: ${label}`} · confidence ${meta.conf} · ${auto ? 'auto-applied' : 'approved'}`,
    ];
    // Read, change and commit in one step in the repository's write queue (repo.ts update): a
    // change built here from a read made earlier would undo whatever was saved in between.
    const r = await provider.update(
      path,
      change,
      formatCommitMessage({
        scope: scopeOf(path),
        summary: summarise(text),
        body,
        trailers: { 'Ancile-Proposal': p.id },
      }),
      auto ? provider.author : this.deps.user,
    );
    await this.deps.index.refresh(path);
    await this.withdrawAbout(path, { key: p.target_key, saved: p }).catch(() => undefined);
    return r.version;
  }

  /**
   * Proposals still waiting that are about something that just changed are out of date: the
   * entry they would update was superseded or replaced, the file is gone, or the same thing was
   * just saved. They are withdrawn (as if declined) so the inbox never offers a stale change.
   */
  private async withdrawAbout(
    path: string,
    about: { key?: string | null; saved?: MemoryProposal; all?: boolean },
  ): Promise<void> {
    const waiting = await this.deps.proposals.list({ status: ['proposed'] });
    for (const w of waiting) {
      if (w.id === about.saved?.id || w.target_path !== path) continue;
      const sameEntry = !!about.key && w.target_key === about.key;
      const sameWords = !!about.saved && similarity(w.text, about.saved.text) >= 0.9;
      if (about.all || sameEntry || sameWords)
        await this.deps.proposals.update(w.id, { status: 'rejected', decided: true });
    }
  }

  /**
   * Reconcile a candidate with what is already remembered, then propose it, apply
   * it, or (M8) keep it as a watch item. Returns the proposal, or null when
   * nothing needed doing.
   *
   * GR3 lives in two places. Whether a candidate may be written without a yes is
   * decided by applyPolicy (capture.ts): only the person's own words qualify.
   * Whether a run-learned lesson is a rule yet is decided here, by sightings.
   */
  async consider(
    c0: CaptureCandidate,
    opts: { notebook?: NotebookInfo | null } = {},
  ): Promise<MemoryProposal | null> {
    let c = c0;
    const mode = await this.captureMode();
    const explicit = !!c.explicit && c.provenance === 'user_message';
    if (mode === 'off' && !explicit) return null;
    await this.sweepWatches().catch(() => undefined);
    // A reversal replaces the entry it contradicts, wherever that entry lives: "US-style dates"
    // against a USER.md date entry is that entry's business even when the detector guessed that
    // the new fact belonged to a notebook.
    if (c.reversal) {
      const best = this.deps.index.search(c.text, { min: 0.12, limit: 6 }).find(
        (e) =>
          !e.path.startsWith('FAILURES/') &&
          !e.path.startsWith('STANDARDS/') &&
          // Another notebook's decisions are not this person's to take back from here.
          (!e.path.startsWith('PROJECTS/') ||
            e.path === c.targetPath ||
            (!!opts.notebook && e.path === `PROJECTS/${opts.notebook.slug}.md`)),
      );
      if (best && best.path !== c.targetPath && this.typeOf(best.path))
        c = { ...c, targetPath: best.path, section: best.section ?? c.section };
    }
    const spec = this.typeOf(c.targetPath)?.spec;
    const neighbours = this.deps.index
      .search(c.text, { path: c.targetPath, limit: 5, min: 0.1 })
      .map((e) => ({ key: e.key, text: e.text }));
    const out = neighbours.length
      ? await this.deps.utility
          ?.json(
            PROMPTS.reconcile,
            { candidate: c.text, neighbours: formatNeighbours(neighbours) },
            ReconcileOutput,
          )
          .catch(() => null)
      : null;
    let d = checkDecision(out ?? null, c.text, neighbours);
    // A reversal replaces the closest entry on the same subject, even when the words differ.
    if (c.reversal && (d.op === 'add' || d.op === 'update')) {
      const best = this.deps.index.search(c.text, { path: c.targetPath, limit: 1, min: 0.12 })[0];
      if (best)
        d = {
          op: 'supersede',
          targetKey: best.key,
          text: c.text,
          rationale: 'You took back or changed what was remembered, so this replaces it.',
        };
    }
    const verdict = applyPolicy(c, d, spec ? spec.auto_apply : null, mode);
    if (verdict === 'skip' || d.op === 'noop') return null;

    const target = d.targetKey ? this.deps.index.find(c.targetPath, d.targetKey) : undefined;
    const evidence = c.evidence.map((e) => ({
      ...(e.threadId && { thread_id: e.threadId }),
      ...(e.messageId && { message_id: e.messageId }),
      ...(e.runId && { run_id: e.runId }),
      ...(e.quote && { quote: e.quote.slice(0, 300) }),
    }));
    const fields = {
      op: d.op,
      text: asEntry(cleanEntry(d.text)),
      target_key: target?.key ?? null,
      target_text: target?.text ?? null,
      rationale: c.note ? `${c.note} ${d.rationale}` : d.rationale,
    };

    // M8, proved or suggested: a lesson from a run needs a second sighting or checked evidence.
    // Looking for the watch item and filing the new sighting happen as one step: two captures of
    // the same lesson at once would each find nothing and each file a first sighting, and it
    // would never count as seen twice. (Only the proposals store is touched here, so it is short.)
    const filed = await this.filing.run(async () => {
      let seen: MemoryProposal | undefined;
      if (needsSightings(c)) {
        seen = findWatch(await this.deps.proposals.watching(), c.targetPath, fields.text);
        const sightings = (seen?.sightings ?? 0) + 1;
        if (sightings < SIGHTINGS_NEEDED) {
          const w = await this.deps.proposals.create({
            kind: c.kind,
            target_path: c.targetPath,
            section: c.section,
            ...fields,
            confidence: c.confidence,
            provenance: c.provenance,
            evidence,
            status: 'watching',
            sightings,
            expires_at: watchExpiry(this.now()),
            uncertainty: uncertaintyFor({ kind: c.kind, text: fields.text }),
          });
          return { proposal: w, watching: true };
        }
      }
      if (seen) {
        // The second sighting: the watch item becomes an ordinary proposal, with both cases as evidence.
        const became =
          (await this.deps.proposals.update(seen.id, {
            status: 'proposed',
            ...fields,
            evidence: [...seen.evidence, ...evidence].slice(-6),
            sightings: (seen.sightings ?? 1) + 1,
            expires_at: null,
            uncertainty: null,
          })) ?? seen;
        return { proposal: became, watching: false };
      }
      const made = await this.deps.proposals.create({
        kind: c.kind,
        target_path: c.targetPath,
        section: c.section,
        ...fields,
        confidence: c.confidence,
        provenance: c.provenance,
        evidence,
        status: 'proposed',
      });
      return { proposal: made, watching: false };
    });
    if (filed.watching) {
      await this.announce(filed.proposal, c, false, true);
      return filed.proposal;
    }
    let p = filed.proposal;
    if (verdict === 'auto_apply') {
      const sha = await this.applyProposal(p, true, opts.notebook);
      p =
        (await this.deps.proposals.update(p.id, {
          status: 'auto_applied',
          commit_sha: sha,
          decided: true,
        })) ?? p;
    }
    await this.announce(p, c, explicit, false);
    return p;
  }

  private async announce(p: MemoryProposal, c: CaptureCandidate, explicit: boolean, watching: boolean) {
    await this.deps.bus
      ?.publish({
        type: 'memory.proposal',
        proposal_id: p.id,
        target_path: p.target_path,
        auto_applied: p.status === 'auto_applied',
        text: p.text,
        kind: p.kind,
        ...(explicit && { explicit: true }),
        ...(watching && { watching: true }),
        // The answer and run it came from, so the tray under that answer shows it.
        ...(c.evidence.find((e) => e.messageId)?.messageId && {
          message_id: c.evidence.find((e) => e.messageId)?.messageId,
        }),
        ...(c.evidence.find((e) => e.runId)?.runId && { run_id: c.evidence.find((e) => e.runId)?.runId }),
      })
      .catch(() => undefined);
  }

  /* ---- Injection ------------------------------------------------------------- */

  async pack(req: PackRequest): Promise<MemoryPack & { budget: number }> {
    const budget = memoryBudget(req.contextWindow, this.deps.config.budget);
    const nb = req.notebookId ? await this.deps.notebook?.(req.notebookId).catch(() => null) : null;
    const files: InjectFile[] = [];
    const ix = this.deps.index;
    const live = (path: string) => ix.file(path)?.entries.filter((e) => !e.superseded) ?? [];
    const asInject = (e: IndexedEntry, relevance?: number) => ({
      key: e.key,
      text: e.text,
      ...(e.confidence !== null && { confidence: e.confidence }),
      ...(e.at && { at: e.at }),
      ...(relevance !== undefined && { relevance }),
    });

    for (const spec of Object.values(this.deps.config.types)) {
      if (req.part === 'pinned' && spec.scope === 'retrieved') continue;
      if (req.part === 'ranked' && spec.scope !== 'retrieved') continue;
      if (spec.scope === 'retrieved') {
        const re = globToRegExp(spec.path);
        const scored = ix
          .paths()
          .filter((p) => re.test(p) && !isGuideFile(p))
          .flatMap((p) => live(p).map((e) => ({ e, s: similarity(req.query, e.text) })))
          // M8 abstain gate: a weak word-overlap match is worse than none.
          .filter((x) => clearsBar(x.s))
          .sort((a, b) => b.s - a.s)
          .slice(0, spec.top_k ?? 5);
        const byPath = new Map<string, typeof scored>();
        for (const x of scored) byPath.set(x.e.path, [...(byPath.get(x.e.path) ?? []), x]);
        for (const [path, xs] of byPath)
          files.push({
            path,
            commit: ix.file(path)?.commit ?? '',
            title: ix.file(path)?.title ?? path,
            priority: spec.priority,
            budgetShare: spec.budget_share / byPath.size,
            entries: xs.map((x) => asInject(x.e, x.s)),
          });
        continue;
      }
      let path = spec.path;
      if (spec.scope === 'notebook') {
        if (!nb) continue;
        path = path.replace(/\{notebook\}|<notebook>/, nb.slug);
      } else if (spec.scope === 'model') path = path.replace(/\{model\}|<model>/, modelSlug(req.modelId));
      const f = ix.file(path);
      if (!f || isGuideFile(path)) continue;
      files.push({
        path,
        commit: f.commit,
        title: f.title,
        priority: spec.priority,
        budgetShare: spec.budget_share,
        entries: live(path).map((e) => asInject(e)),
      });
    }
    const built = buildMemoryPack(files, budget);
    // The one-line note rides with the pinned part (stable, so a cached prefix stays valid), and
    // only while capture is on and the thread's scope lets memory be written: where it cannot be,
    // the note would promise a save that will not happen.
    if (req.part !== 'ranked' && req.memoryWrite !== false && (await this.captureMode()) !== 'off') {
      const text = built.text ? `${built.text}\n\n${CAPTURE_NOTE}` : CAPTURE_NOTE;
      return { ...built, text, tokens: built.tokens + approxTokens(CAPTURE_NOTE), budget };
    }
    return { ...built, budget };
  }

  async preview(req: PackRequest): Promise<MemoryPreview> {
    const p = await this.pack(req);
    return {
      text: p.text,
      tokens: p.tokens,
      files: p.files,
      truncated: p.truncated,
      budget: p.budget,
      model_id: req.modelId,
    };
  }

  /* ---- Hindsight pass (M9) --------------------------------------------------- */

  /**
   * Review a session for what it taught. Proposes only: each item is filed in
   * the inbox, citing the turn it came from, and nothing is written to memory
   * until the person approves it. The model call is a utility call through the
   * gateway, so it is costed like the others.
   */
  async hindsight(threadId: string): Promise<HindsightResponse> {
    const threads = this.deps.threads;
    const thread = await threads?.getThread(threadId).catch(() => undefined);
    if (!threads || !thread)
      throw new AncileError({
        code: 'memory.thread_not_found',
        title: 'That thread does not exist',
        hint: 'It may have been deleted. Open another thread and try again.',
        status: 404,
        errorClass: 'permanent',
      });
    const all = await threads.messages(threadId);
    const head = thread.active_head_id ?? all.at(-1)?.id;
    const turns = turnsOf(head ? pathFor(all, head) : []);
    if (turns.length === 0)
      return {
        nothing_worth_keeping: true,
        note: 'There is nothing in this thread to look back on yet.',
        proposals: [],
        turns_reviewed: 0,
        summarised: false,
      };

    const shown = condense(turns);
    const review = await this.deps.utility?.json(HINDSIGHT_PROMPT, { session: shown.text }, HindsightReview, {
      maxOutputTokens: 1_500,
    });
    if (!review)
      throw new AncileError({
        code: 'memory.hindsight_unavailable',
        title: 'The review could not be done',
        hint: 'No model answered, or its answer could not be read. Check that a utility or default model is set up, then try again.',
        status: 503,
        errorClass: 'transient',
      });

    const { items, dropped } = checkReview(review, turns, shown.shown);
    const nb = thread.notebook_id ? await this.deps.notebook?.(thread.notebook_id).catch(() => null) : null;
    const made: MemoryProposal[] = [];
    for (const it of items) {
      const lesson = it.kind === 'process_lesson';
      const targetPath = lesson
        ? `FAILURES/${topicSlug(it.topic)}.md`
        : nb
          ? `PROJECTS/${nb.slug}.md`
          : 'USER.md';
      const section = lesson ? 'Lessons' : nb ? 'Findings' : 'Environment';
      const text = asEntry(
        cleanEntry(
          scrubPaths(
            lesson && it.root_cause && !/^unclear/i.test(it.root_cause)
              ? `${it.text.replace(/\.$/, '')}. Cause: ${it.root_cause.replace(/\.$/, '')}`
              : it.text,
          ),
        ),
      );
      const neighbours = this.deps.index
        .search(text, { path: targetPath, limit: 5, min: 0.1 })
        .map((e) => ({ key: e.key, text: e.text }));
      const d = reconcileLocally(text, neighbours);
      if (d.op === 'noop') continue;
      const target = d.targetKey ? this.deps.index.find(targetPath, d.targetKey) : undefined;
      made.push(
        await this.deps.proposals.create({
          kind: lesson ? 'failure_lesson' : 'project_finding',
          target_path: targetPath,
          op: d.op,
          section,
          text: d.op === 'add' ? text : asEntry(cleanEntry(d.text)),
          target_key: target?.key ?? null,
          target_text: target?.text ?? null,
          rationale: `Hindsight pass, turn ${it.turn}: ${lesson ? 'process lesson' : 'environment fact'}${
            it.root_cause && !/^unclear/i.test(it.root_cause) ? `. ${it.root_cause.replace(/\.$/, '')}` : ''
          }.`,
          confidence: it.confidence,
          provenance: 'run_outcome',
          evidence: [{ thread_id: threadId, message_id: it.messageId, ...(it.quote && { quote: it.quote }) }],
          status: 'proposed',
        }),
      );
    }
    for (const p of made)
      await this.deps.bus
        ?.publish({
          type: 'memory.proposal',
          proposal_id: p.id,
          target_path: p.target_path,
          auto_applied: false,
          text: p.text,
          kind: p.kind,
        })
        .catch(() => undefined);

    const none = made.length === 0;
    log.info(
      {
        thread_id: threadId,
        turns: turns.length,
        proposals: made.length,
        dropped,
        summarised: shown.summarised,
      },
      'hindsight pass done',
    );
    return {
      nothing_worth_keeping: none,
      note: none
        ? dropped > 0
          ? 'The review suggested things it could not tie to a turn of this session, so none were kept.'
          : review.note || 'Nothing in this session is worth keeping.'
        : review.note,
      proposals: made,
      turns_reviewed: turns.length,
      summarised: shown.summarised,
    };
  }

  /* ---- Passive memory -------------------------------------------------------- */

  async passiveEnabled(): Promise<boolean> {
    return (await this.deps.settings?.get<boolean>(SETTING.memoryPassive).catch(() => undefined)) !== false;
  }

  async setPassive(on: boolean): Promise<void> {
    await this.deps.settings?.set(SETTING.memoryPassive, on);
  }

  private readonly sweeps = new SweepLimiter();
  private ledgerLock: Promise<unknown> = Promise.resolve();

  /** Read, change and save the mention ledger one change at a time. */
  private async withLedger<T>(fn: (l: Ledger) => Promise<{ ledger: Ledger; out: T }>): Promise<T> {
    const run = this.ledgerLock.then(async () => {
      const settings = this.deps.settings;
      const raw = settings
        ? await settings.get<unknown>(SETTING.memoryPassiveLedger).catch(() => null)
        : null;
      const { ledger, out } = await fn(raw ? parseLedger(raw) : emptyLedger());
      await settings?.set(SETTING.memoryPassiveLedger, ledger);
      return out;
    });
    this.ledgerLock = run.catch(() => undefined);
    return run;
  }

  /** Must a call about this notebook run on this machine? (A private notebook never reaches a cloud model.) */
  private async localOnlyFor(notebookId: string | null | undefined): Promise<boolean> {
    if (!notebookId || !this.privacy) return false;
    const a = await this.privacy.resolve('cloud_models', { notebookId }).catch(() => null);
    return !!a && !a.allowed;
  }

  /**
   * Count that the person said something, and file it: a proposal the first time, saved
   * without a yes when this is a second, independent mention (another message, this thread
   * or another). The earlier proposal for the same fact is withdrawn so the inbox has one.
   */
  private async mentioned(
    statement: string,
    mention: Mention,
    build: (repeated: boolean, evidence: CaptureCandidate['evidence']) => CaptureCandidate,
    nb: NotebookInfo | null | undefined,
  ): Promise<MemoryProposal | null> {
    return this.withLedger(async (ledger) => {
      const r = recordMention(ledger, statement, mention, this.now());
      if (r.entry.saved) return { ledger: r.ledger, out: null };
      const evidence = r.entry.mentions.map((m) => ({ threadId: m.thread_id, messageId: m.message_id }));
      const p = await this.consider(build(r.repeated, evidence), { notebook: nb });
      if (p) {
        const earlier = r.entry.proposal_id;
        if (earlier && earlier !== p.id) {
          const old = await this.deps.proposals.get(earlier);
          if (old?.status === 'proposed')
            await this.deps.proposals.update(earlier, { status: 'rejected', decided: true });
        }
        if (p.status === 'auto_applied' || p.status === 'applied') r.entry.saved = true;
        else if (!earlier || earlier !== p.id) r.entry.proposal_id = p.id;
      }
      return { ledger: r.ledger, out: p };
    });
  }

  /**
   * Look back over what the person said in a quiet thread, for things worth remembering.
   * Free when there is nothing to find: the rules gate runs first and no model is asked
   * for a thread that said nothing about the person. Otherwise one batched call over their
   * own words (2,000 tokens at most) on the cheap tier, or on a local model only when the
   * notebook is private and a local model is what makes it allowed.
   */
  async passiveSweep(
    threadId: string,
  ): Promise<{ asked: boolean; filed: number; saved: number; skipped?: string }> {
    const none = (skipped: string) => ({ asked: false, filed: 0, saved: 0, skipped });
    const threads = this.deps.threads;
    if (!threads || !this.deps.utility) return none('no_model');
    if (!(await this.passiveEnabled())) return none('off');
    if ((await this.captureMode()) === 'off') return none('capture_off');
    const thread = await threads.getThread(threadId).catch(() => undefined);
    if (!thread) return none('thread_gone');

    const all = await threads.messages(threadId);
    const head = thread.active_head_id ?? all.at(-1)?.id;
    const path = head ? pathFor(all, head) : [];
    const users = path.filter((m) => m.role === 'user');
    const ledger0 = parseLedger(
      await this.deps.settings?.get<unknown>(SETTING.memoryPassiveLedger).catch(() => null),
    );
    const doneId = ledger0.done[threadId];
    const at = doneId ? users.findIndex((m) => m.id === doneId) : -1;
    const fresh = users.slice(at + 1);
    const turnOf = (m: (typeof users)[number], n: number) => ({
      n,
      messageId: m.id,
      // A message that shows someone else's work as an example is handled by examples.ts.
      user: detectExample(textOf(m.parts), m.parts) ? '' : textOf(m.parts),
      assistant: '',
      tools: [] as string[],
    });
    const turns = passiveTurns(fresh.map((m, i) => turnOf(m, i + 1)));
    const markDone = async () => {
      const last = users.at(-1)?.id;
      if (!last) return;
      await this.withLedger(async (l) => ({
        ledger: {
          ...l,
          done: { ...Object.fromEntries(Object.entries(l.done).slice(-400)), [threadId]: last },
        },
        out: null,
      }));
    };
    // The gate: nothing said about the person, nothing asked, nothing spent.
    if (!worthAsking(turns)) {
      await markDone();
      return none('quiet');
    }

    // Private notebooks: only if the person allowed it, or a local model can do it.
    let localOnly = false;
    if (thread.notebook_id && this.privacy) {
      const a = await this.privacy.resolve('passive_memory', { notebookId: thread.notebook_id });
      if (!a.allowed) return none('private');
      localOnly = a.must_run_local;
    }
    const nowMs = this.now().getTime();
    if (!this.sweeps.allow(threadId, nowMs)) return none('rate_limited');

    const nb = thread.notebook_id ? await this.deps.notebook?.(thread.notebook_id).catch(() => null) : null;
    const shown = condensePassive(turns);
    this.sweeps.record(threadId, nowMs);
    const review = await this.deps.utility.json(PASSIVE_PROMPT, { turns: shown.text }, PassiveReview, {
      maxOutputTokens: 500,
      taskClasses: ['memory.detector'],
      ...(localOnly && { localOnly: true }),
    });
    if (!review) return { asked: true, filed: 0, saved: 0, skipped: 'no_answer' };

    const byTurn = new Map(turns.map((t) => [t.n, t]));
    let filed = 0;
    let saved = 0;
    const seen = new Set<string>();
    for (const it of review.items) {
      const t = byTurn.get(it.turn);
      const statement = asEntry(cleanEntry(it.statement));
      // It must cite a turn it was shown and be about what that turn said, or it is dropped.
      if (!t || !shown.shown.includes(it.turn) || statement.length < 8 || seen.has(statement.toLowerCase()))
        continue;
      if (similarity(statement, t.user) < 0.1) continue;
      // Already remembered (an explicit "remember", an earlier proposal that was saved): nothing to add.
      if (this.alreadyRemembered(statement)) continue;
      seen.add(statement.toLowerCase());
      if (filed + saved >= PASSIVE_MAX_ITEMS) break;
      const project = it.scope === 'notebook' && nb;
      const p = await this.mentioned(
        statement,
        { thread_id: threadId, message_id: t.messageId, at: this.now().toISOString() },
        (repeated, evidence) => ({
          kind: 'preference',
          targetPath: project ? `PROJECTS/${nb.slug}.md` : 'USER.md',
          section: project ? 'Decisions' : 'Preferences',
          text: statement,
          confidence: it.confidence,
          evidence: evidence.map((e) =>
            e.messageId === t.messageId ? { ...e, quote: statementsIn(t.user).join(' ').slice(0, 300) } : e,
          ),
          provenance: 'user_message',
          passive: true,
          repeated,
          note: repeated ? 'Noticed in passing, and said more than once.' : 'Noticed in passing, said once.',
        }),
        nb,
      );
      if (p?.status === 'auto_applied') saved++;
      else if (p) filed++;
    }
    await markDone();
    log.info({ thread_id: threadId, shown: shown.shown.length, filed, saved }, 'passive memory sweep done');
    return { asked: true, filed, saved };
  }

  /**
   * A statement whose words an existing live entry already carries (three quarters of them, and
   * the same stance: a "not" on one side only is a change, not a repeat).
   */
  private alreadyRemembered(statement: string): boolean {
    const mine = words(statement);
    if (mine.size === 0) return false;
    const negated = /\b(?:not|never|no|don'?t|doesn'?t|avoid|without|stop)\b/i.test(statement);
    return this.deps.index.search(statement, { limit: 3, min: 0.3 }).some((e) => {
      const theirs = words(e.text);
      let both = 0;
      for (const w of mine) if (theirs.has(w)) both++;
      return (
        both / mine.size >= 0.75 &&
        negated === /\b(?:not|never|no|don'?t|doesn'?t|avoid|without|stop)\b/i.test(e.text)
      );
    });
  }

  /* ---- Learning from an example ---------------------------------------------- */

  /**
   * The person showed someone else's work as the standard (and maybe their own). One
   * standard-tier call distils a short rubric. It is always a proposal: pasted text can
   * carry instructions, so a rule written from it is never saved without a yes. The
   * example is kept as a reference (the message and file names), not copied.
   */
  private async learnExample(
    turn: TurnRecord,
    ex: ExampleDetection,
    userText: string,
    nb: NotebookInfo | null | undefined,
  ): Promise<void> {
    const say = (outcome: 'learned' | 'not_learned', title: string, body: string) =>
      this.deps.bus
        ?.publish({
          type: 'memory.note',
          message_id: turn.userMessageId,
          thread_id: turn.threadId,
          outcome,
          title,
          body,
        })
        .catch(() => undefined);
    const who = `your ${ex.role}'s`;
    const fail = async (reason: string) => {
      log.info({ thread_id: turn.threadId, reason }, 'no standard learned from an example');
      await say(
        'not_learned',
        `Couldn't learn ${who} standard`,
        `${reason[0]?.toUpperCase()}${reason.slice(1)}.`,
      );
    };
    if (!this.deps.utility) return fail('no model is set up to read it');

    // The cheap tier first (distilling rules from a page is a narrow job); the default model only
    // if the cheap one's answer is unusable. What it cost is logged, never shown.
    const vars = {
      role: ex.role,
      theirs: exampleBlock(ex.theirs),
      mine: ex.mine.length ? exampleBlock(ex.mine) : '',
    };
    const localOnly = await this.localOnlyFor(turn.notebookId);
    let rubric: StandardRubric | null = null;
    let reason = '';
    let tokens = 0;
    let usd = 0;
    let modelId = '';
    for (const taskClasses of [['memory.detector'], ['chat.default']]) {
      let outcome: UtilityOutcome | undefined;
      const answer = await this.deps.utility
        .json(STANDARD_PROMPT, vars, StandardRubric, {
          maxOutputTokens: 900,
          taskClasses,
          ...(localOnly && { localOnly: true }),
          outcome: (o) => {
            outcome = o;
          },
        })
        .catch(() => null);
      if (outcome) {
        tokens += outcome.inputTokens + outcome.outputTokens;
        usd += outcome.costUsd ?? 0;
        modelId = outcome.modelId ?? modelId;
      }
      if (!answer) {
        reason = outcome?.reason ?? 'the model did not answer';
        continue;
      }
      rubric = checkRubric(answer);
      if (rubric) break;
      reason = 'none of the rules it wrote were safe or specific enough to keep';
    }
    log.info(
      { thread_id: turn.threadId, model: modelId, tokens, usd: usd || undefined, learned: !!rubric },
      'distilled a standard from an example',
    );
    if (!rubric) return fail(reason);
    const path = standardPath(ex.role);
    const files = [...ex.theirs, ...ex.mine].filter((p) => !p.from.startsWith('pasted')).map((p) => p.from);
    const intro = ownWords(userText).slice(0, 240);
    const evidence = [
      {
        threadId: turn.threadId,
        messageId: turn.userMessageId,
        runId: turn.runId,
        quote: `${intro}${files.length ? ` (files: ${files.join(', ')})` : ''}`,
      },
    ];
    const base = {
      kind: 'preference' as const,
      targetPath: path,
      section: 'Standards',
      evidence,
      // Content the person shared, not their own rule: proposed whatever else is true.
      provenance: 'source_content' as const,
      note: ex.asked
        ? 'Distilled from an example you asked to learn from.'
        : 'Distilled from an example you shared.',
    };
    const filed = await this.consider(
      { ...base, text: standardText(ex.role, rubric), confidence: Math.min(rubric.confidence, 0.8) },
      { notebook: nb },
    );
    const diff = differenceText(ex.role, rubric);
    if (diff && ex.mine.length)
      await this.consider(
        { ...base, section: 'Your work', text: diff, confidence: Math.min(rubric.confidence, 0.7) },
        { notebook: nb },
      );
    if (filed)
      await say(
        'learned',
        `Learned ${who} standard`,
        filed.status === 'proposed' ? 'It is waiting in Memory for your yes.' : 'It is saved in Memory.',
      );
    else await fail('that standard is already in Memory');
  }

  /**
   * Compare a piece of the person's work with a standard they have kept: one call, a short
   * list of differences and suggested edits, citing the standard entry.
   */
  async compare(req: CompareRequest): Promise<CompareResponse> {
    const threads = this.deps.threads;
    const m = await threads?.getMessage(req.message_id);
    if (!threads || !m)
      throw new AncileError({
        code: 'memory.message_not_found',
        title: 'That message does not exist',
        hint: 'It may have been deleted. Pick another message.',
        status: 404,
        errorClass: 'permanent',
      });
    const work = [textOf(m.parts), ...m.parts.flatMap((p) => (p.type === 'file' && p.text ? [p.text] : []))]
      .join('\n\n')
      .trim()
      .slice(0, COMPARE_CHARS);
    const live = this.deps.index.live('STANDARDS/');
    const chosen =
      req.path && req.key
        ? this.deps.index.find(req.path, req.key)
        : (this.deps.index.search(work, { prefix: 'STANDARDS/', limit: 1 })[0] ?? live[0]);
    if (!chosen || chosen.superseded)
      throw new AncileError({
        code: 'memory.no_standard',
        title: 'There is no standard to compare with yet',
        hint: 'Show NVX Ancile an example of work you want to match ("this is how my manager writes updates") and keep the standard it suggests.',
        status: 404,
        errorClass: 'permanent',
      });
    if (!work)
      throw new AncileError({
        code: 'memory.nothing_to_compare',
        title: 'That message has no text to compare',
        hint: 'Pick a message with the work in it, or attach the file to it.',
        status: 422,
        errorClass: 'permanent',
      });
    let outcome: UtilityOutcome | undefined;
    const out = await this.deps.utility
      ?.json(COMPARE_PROMPT, { standard: chosen.text, work }, CompareResult, {
        maxOutputTokens: COMPARE_TOKENS,
        taskClasses: ['chat.default'],
        outcome: (o) => {
          outcome = o;
        },
        ...((await this.localOnlyFor(
          (
            await threads.getThread(m.thread_id).catch(() => undefined)
          )?.notebook_id,
        )) && { localOnly: true }),
      })
      .catch(() => null);
    if (!out) {
      const why = outcome?.reason ?? 'no model is set up for this';
      log.warn({ reason: why, model: outcome?.modelId }, 'a comparison with a standard failed');
      throw new AncileError({
        code: 'memory.compare_unavailable',
        title: 'The comparison could not be done',
        hint: `${why[0]?.toUpperCase()}${why.slice(1)}. Try again, or pick a different default model.`,
        status: 503,
        errorClass: 'transient',
      });
    }
    return {
      standard: { path: chosen.path, key: chosen.key, text: chosen.text, commit: chosen.commit },
      summary: out.summary,
      differences: out.differences,
      suggestions: out.suggestions,
    };
  }

  /* ---- Mistakes -------------------------------------------------------------- */

  /**
   * The person corrected an answer: what was asked, what was done, what they wanted. A proposal
   * the first time; saved when it happens again (another message, this thread or another).
   */
  private async learnMistake(
    turn: TurnRecord,
    lesson: { asked: string; did: string; wanted: string },
    userText: string,
    nb: NotebookInfo | null | undefined,
  ): Promise<void> {
    const clean = (x: string) => cleanEntry(x).replace(/[.\s]+$/, '');
    const asked = clean(lesson.asked);
    const did = clean(lesson.did);
    const wanted = clean(lesson.wanted);
    if (asked.length < 4 || did.length < 4 || wanted.length < 4) return;
    const text = `**When asked ${asked}.** I did: ${did}. You wanted: ${wanted}.`;
    await this.mentioned(
      `${asked} ${wanted}`,
      { thread_id: turn.threadId, message_id: turn.userMessageId, at: this.now().toISOString() },
      (repeated, evidence) => ({
        kind: 'failure_lesson',
        targetPath: 'FAILURES/answer-corrections.md',
        section: 'Lessons',
        text,
        confidence: 0.75,
        evidence: evidence.map((e) =>
          e.messageId === turn.userMessageId ? { ...e, runId: turn.runId, quote: userText.slice(0, 300) } : e,
        ),
        provenance: 'user_message',
        passive: true,
        repeated,
        note: 'Learned from a correction of an answer.',
      }),
      nb,
    );
  }

  /**
   * "Update memory": the person asks for what they said in this message to be kept, after
   * memory heard a reversal and changed nothing. Their click is the request (GR3), so it is
   * saved with a note and Undo, replacing the nearest entry on the same subject.
   */
  async updateFromMessage(messageId: string): Promise<MemoryProposal> {
    const threads = this.deps.threads;
    const m = await threads?.getMessage(messageId);
    if (!threads || !m || m.role !== 'user')
      throw new AncileError({
        code: 'memory.message_not_found',
        title: 'That message does not exist',
        hint: 'It may have been deleted. Pick another message.',
        status: 404,
        errorClass: 'permanent',
      });
    const own = ownWords(textOf(m.parts));
    const det = await this.deps.utility
      ?.json(
        PROMPTS.detect,
        { assistant_message: '', user_message: own.slice(0, 2_000), edited_from: '' },
        CorrectionDetection,
      )
      .catch(() => null);
    // Without a model: the last sentence that is not only taking something back.
    const fallback =
      reversalStatement(own) ||
      own
        .split(/(?<=[.!])\s+/)
        .map((x) => x.trim())
        .filter((x) => x && !reversalOnly(x))
        .at(-1);
    const statement = det?.statement?.trim() || fallback;
    if (!statement)
      throw new AncileError({
        code: 'memory.nothing_to_save',
        title: 'There is nothing in that message to save',
        hint: 'Say what is true now ("I use US-style dates") and it will be saved.',
        status: 422,
        errorClass: 'permanent',
      });
    const thread = await threads.getThread(m.thread_id).catch(() => undefined);
    const nb = thread?.notebook_id ? await this.deps.notebook?.(thread.notebook_id).catch(() => null) : null;
    const p = await this.consider(
      {
        kind: 'preference',
        targetPath: 'USER.md',
        section: 'Preferences',
        text: asEntry(statement),
        confidence: 0.9,
        evidence: [{ threadId: m.thread_id, messageId, quote: own.slice(0, 300) }],
        provenance: 'user_message',
        explicit: true,
        reversal: true,
        note: 'You asked for this to be updated.',
      },
      { notebook: nb },
    );
    if (!p)
      throw new AncileError({
        code: 'memory.nothing_to_save',
        title: 'That is already what memory says',
        hint: 'Nothing needed changing.',
        status: 409,
        errorClass: 'permanent',
      });
    return p;
  }

  /** An entry as words, with the commit it was read at: for the "Used:" line of an answer. */
  entryUsed(path: string, key: string): { path: string; key: string; text: string; commit: string } | null {
    const e = this.deps.index.find(path, key);
    return e && !e.superseded ? { path, key, text: e.text, commit: e.commit } : null;
  }

  /* ---- Capture --------------------------------------------------------------- */

  /** After a turn is saved: learn from it, in the background. */
  afterTurn(turn: TurnRecord): Promise<void> {
    const done = this.capture(turn).catch((err) => {
      log.warn({ err, thread_id: turn.threadId }, 'memory capture failed; nothing learned from this turn');
    });
    this.track(done);
    this.armIdle(turn.threadId);
    return done;
  }

  private track(p: Promise<unknown>) {
    const done = p.then(
      () => undefined,
      () => undefined,
    );
    this.capturing.add(done);
    void done.finally(() => this.capturing.delete(done));
  }

  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** (Re)start the quiet timer for a thread. When it runs out, the thread is looked at once. */
  private armIdle(threadId: string) {
    const ms = this.deps.idleMs ?? IDLE_MS;
    if (ms <= 0) return;
    clearTimeout(this.idleTimers.get(threadId));
    const t = setTimeout(() => {
      this.idleTimers.delete(threadId);
      this.track(this.onIdle(threadId));
    }, ms);
    t.unref?.();
    this.idleTimers.set(threadId, t);
  }

  /**
   * A thread has been quiet. The one place idle work hangs from: passive memory today;
   * TODO(phase-5): project findings for a notebook thread.
   */
  async onIdle(threadId: string): Promise<void> {
    await this.passiveSweep(threadId).catch((err) =>
      log.warn({ err, thread_id: threadId }, 'passive memory failed; nothing learned this time'),
    );
  }

  /** Stop the timers (a clean shutdown). */
  stop() {
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
  }

  private readonly capturing = new Set<Promise<void>>();

  /**
   * Resolves once every capture started so far has finished (tests, and a
   * clean shutdown). Captures run in the background after a turn, so this is
   * how to know memory has reacted without polling against a clock.
   */
  async settled(): Promise<void> {
    while (this.capturing.size) await Promise.all([...this.capturing]);
  }

  /** Reject the pending proposals that quote an edited message (or one it replaced earlier). */
  private async withdrawSuperseded(editOfId: string): Promise<void> {
    const threads = this.deps.threads;
    if (!threads) return;
    const chain = new Set<string>();
    for (let id: string | null | undefined = editOfId; id && !chain.has(id); ) {
      chain.add(id);
      id = (await threads.getMessage(id))?.edit_of_id;
    }
    const waiting = await this.deps.proposals.list({ status: ['proposed'] });
    for (const p of waiting)
      if (p.evidence.some((e) => e.message_id && chain.has(e.message_id)))
        await this.deps.proposals.update(p.id, { status: 'rejected', decided: true });
  }

  private async capture(turn: TurnRecord): Promise<void> {
    const off = (await this.captureMode()) === 'off';
    const threads = this.deps.threads;
    const user = await threads?.getMessage(turn.userMessageId);
    const userText = user && user.role === 'user' ? textOf(user.parts) : '';
    const nb = turn.notebookId ? await this.deps.notebook?.(turn.notebookId).catch(() => null) : null;

    // 0. An edited message replaces the one it edits: a proposal still waiting that was
    //    drawn from the old wording is withdrawn (not written; the new turn derives afresh).
    if (user?.edit_of_id && threads) await this.withdrawSuperseded(user.edit_of_id);
    // 0. M2 / GR3: the person asked, in their own words, for something to be kept.
    //    Only the user's message is ever read here, never a tool result or a source.
    const ask = userText ? detectExplicit(userText) : null;
    if (ask) {
      const project = ask.scope === 'notebook' && nb;
      await this.consider(
        {
          kind: 'preference',
          targetPath: project ? `PROJECTS/${nb.slug}.md` : 'USER.md',
          section: project ? 'Decisions' : ask.kind === 'restriction' ? 'Restrictions' : 'Preferences',
          text: ask.statement,
          confidence: 0.97,
          evidence: [
            { threadId: turn.threadId, messageId: turn.userMessageId, runId: turn.runId, quote: userText },
          ],
          provenance: 'user_message',
          explicit: true,
          note: ASKED_NOTE,
        },
        { notebook: nb },
      );
      // They have said what they want kept; the correction detector has nothing to add.
    }
    if (off) return;

    // 0b. Someone else's work shown as the bar to aim for: a standard, proposed (never saved unasked).
    const example = user && userText ? detectExample(userText, user.parts) : null;
    if (example)
      await this.learnExample(turn, example, userText, nb).catch(async (err) => {
        log.warn({ err, thread_id: turn.threadId }, 'could not learn a standard from the example');
        await this.deps.bus
          ?.publish({
            type: 'memory.note',
            message_id: turn.userMessageId,
            thread_id: turn.threadId,
            outcome: 'not_learned',
            title: `Couldn't learn your ${example.role}'s standard`,
            body: 'Something went wrong while saving it.',
          })
          .catch(() => undefined);
      });

    // 1. A correction of the assistant, in the user's own words. Taking something back
    //    ("scrap that", "I've moved to...") counts even with no answer to reply to.
    const reversal = reversalSignal(userText);
    let heard = false;
    // The detector said something about the message (even "nothing durable"): its word stands.
    let judged = false;
    try {
      if (!ask && !example && user && threads && this.deps.utility) {
        const original = user.edit_of_id ? await threads.getMessage(user.edit_of_id) : undefined;
        let assistant: { parts: Part[]; role: string; parent_id?: string | null } | undefined;
        if (original) {
          const all = await threads.messages(turn.threadId);
          assistant = all.find((m) => m.parent_id === original.id && m.role === 'assistant');
        } else if (user.parent_id) {
          const parent = await threads.getMessage(user.parent_id);
          if (parent?.role === 'assistant') assistant = parent;
        }
        const assistantText = assistant ? textOf(assistant.parts) : null;
        const editedFrom = original ? textOf(original.parts) : null;
        // What was asked before the answer being corrected: the "asked" of a lesson.
        const askedId = assistant?.parent_id;
        const asker = askedId ? await threads.getMessage(askedId) : undefined;
        const earlierRequest = asker?.role === 'user' ? ownWords(textOf(asker.parts)) : null;
        if (correctionSignal({ userText, assistantText, editedFrom })) {
          // The model sees only what the user wrote themselves: quotes, pasted
          // blocks and code are someone else's words and must not become memory.
          const own = ownWords(userText);
          const det = await this.deps.utility.json(
            PROMPTS.detect,
            {
              assistant_message: (assistantText ?? '').slice(0, 2_000),
              user_message: own.slice(0, 2_000),
              edited_from: editedFrom?.slice(0, 1_000) ?? '',
              earlier_request: earlierRequest?.slice(0, 600) ?? '',
            },
            CorrectionDetection,
          );
          judged = !!det;
          // 1a. The answer was wrong: what was asked, what was done, what was wanted. Said twice, it is kept.
          if (det?.is_correction && det.lesson && assistantText)
            await this.learnMistake(turn, det.lesson, userText, nb).catch((err) =>
              log.warn({ err }, 'could not note the mistake'),
            );
          if (
            det?.is_correction &&
            det.durable &&
            det.scope !== 'none' &&
            det.statement.trim() &&
            !staleStatement(det.statement, own, editedFrom)
          ) {
            const project = det.scope === 'notebook' && nb;
            const made = await this.consider(
              {
                kind: 'preference',
                targetPath: project ? `PROJECTS/${nb.slug}.md` : 'USER.md',
                section: project ? 'Decisions' : 'Preferences',
                text: asEntry(det.statement),
                ...(reversal && { reversal: true }),
                // Corrections are short. A long message is probably a paste, so
                // whatever it yields is proposed, never kept without a yes.
                confidence: own.length > LONG_MESSAGE ? Math.min(det.confidence, 0.6) : det.confidence,
                evidence: [
                  {
                    threadId: turn.threadId,
                    messageId: turn.userMessageId,
                    runId: turn.runId,
                    quote: userText,
                  },
                ],
                provenance: 'user_message',
              },
              { notebook: nb },
            );
            heard = !!made;
          }
        }
      }
      // A reversal the model made nothing of (it did not answer, or called it a one-off): what is
      // left once the take-back words are cut off is still what is true now. Proposed, never
      // saved unasked, and it replaces the entry it contradicts.
      if (reversal && !ask && !example && !heard && user && (!judged || contrast(userText))) {
        const statement = reversalStatement(userText);
        if (statement) {
          const project = !!nb && /\b(?:in|for|on)\s+(?:this|the)\s+(?:notebook|project)\b/i.test(userText);
          const made = await this.consider(
            {
              kind: 'preference',
              targetPath: project && nb ? `PROJECTS/${nb.slug}.md` : 'USER.md',
              section: project ? 'Decisions' : 'Preferences',
              text: statement,
              reversal: true,
              confidence: 0.7,
              evidence: [
                {
                  threadId: turn.threadId,
                  messageId: turn.userMessageId,
                  runId: turn.runId,
                  quote: userText,
                },
              ],
              provenance: 'user_message',
              note: 'You took something back, so this is proposed.',
            },
            { notebook: nb },
          );
          heard = !!made;
        }
      }
    } catch (err) {
      log.warn({ err, thread_id: turn.threadId }, 'could not act on what the person said');
    }
    // A reversal that taught memory nothing is said so, with a way to save it anyway.
    if (reversal && !ask && !example && !heard)
      await this.deps.bus
        ?.publish({
          type: 'memory.unchanged',
          message_id: turn.userMessageId,
          thread_id: turn.threadId,
          reason: 'reversal',
        })
        .catch(() => undefined);

    // 2. A tool that failed, then worked: a lesson.
    for (const e of failureEpisodes(turn.parts)) {
      // Paths are scrubbed before a model sees them and again as the lesson is written (lessonText).
      const line = (a: { tool: string; args: unknown; result: string }) =>
        scrubPaths(
          `- ${a.tool}(${JSON.stringify(a.args).slice(0, 200)}): ${a.result.split('\n')[0]?.slice(0, 200)}`,
        );
      const lesson =
        (await this.deps.utility
          ?.json(
            PROMPTS.lesson,
            {
              goal: scrubPaths(userText.slice(0, 500)),
              failed_steps: e.failed.map(line).join('\n'),
              successful_steps: line(e.succeeded),
              user_remarks: '',
            },
            FailureLesson,
          )
          .catch(() => null)) ?? lessonLocally(e);
      // The model found no cause worth keeping: an unexplained retry is not a lesson.
      if (lesson.skip) continue;
      await this.consider({
        kind: 'failure_lesson',
        targetPath: `FAILURES/${topicSlug(lesson.topic)}.md`,
        section: 'Lessons',
        text: lessonText(lesson),
        confidence: lesson.confidence,
        evidence: [{ threadId: turn.threadId, messageId: turn.assistantMessageId, runId: turn.runId }],
        provenance: 'run_outcome',
        // M8: one lucky retry is a suggestion; the same fix working twice, with a stated cause, is evidence.
        verified: episodeVerified(e, laterSuccesses(turn.parts, e), lesson),
      });
    }
  }
}

/** A sentence that only takes something back: "Actually no, scrap that." */
const reversalOnly = (x: string) =>
  /^(?:actually,?\s+)?(?:no,?\s+)?(?:scrap|scratch|ignore|forget|disregard|never mind)\b[^,;]{0,40}$/i.test(
    x.replace(/[.!]+$/, ''),
  );

function entryView(e: IndexedEntry): MemoryEntryView {
  return {
    key: e.key,
    text: e.text,
    section: e.section,
    superseded: e.superseded,
    confidence: e.confidence,
    src: e.src,
    at: e.at,
    superseded_by: e.supersededBy,
  };
}
