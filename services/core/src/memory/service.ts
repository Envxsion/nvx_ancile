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
import { SETTING, type SettingsStore } from '../settings';
import { type ThreadRepo, textOf } from '../threads/repo';
import {
  applyPolicy,
  asEntry,
  type CaptureCandidate,
  CorrectionDetection,
  checkDecision,
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
  staleStatement,
  topicSlug,
} from './capture';
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
import { type IndexedEntry, indexFile, isGuideFile, type MemoryIndex, similarity } from './index';
import { buildMemoryPack, type InjectFile, type MemoryPack, memoryBudget } from './inject';
import type { Utility } from './llm';
import type { ProposalStore } from './proposals';
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

function globToRegExp(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{(notebook|model)\}|<(notebook|model)>/g, '[^/]+')
    .replace(/\*/g, '[^/]+');
  return new RegExp(`^${esc}$`);
}

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

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
    const { content, version } = await this.deps.provider.read('USER.md').catch(() => ({
      content: '# About me\n',
      version: null as string | null,
    }));
    const doc = addEntry(parseMemory(content), 'About', cleanEntry(about), {
      m: ulid().slice(-8).toLowerCase(),
      src: 'onboarding',
      at: today(),
    });
    await this.deps.provider.writeDetailed({
      path: 'USER.md',
      content: renderMemory(doc),
      baseVersion: version,
      message: formatCommitMessage({
        scope: 'user',
        summary: 'what you said about yourself at setup',
        body: [],
        trailers: {},
      }),
      author: this.deps.user,
    });
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
    if (path.startsWith('MODELS/')) return 'Quirks';
    return p.section || 'Notes';
  }

  async decide(id: string, req: ProposalDecisionRequest): Promise<MemoryProposal> {
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
    if (path.startsWith('MODELS/')) {
      return `---\ntype: models\nscope: model\nupdated: ${date}\n---\n# ${path.slice(7, -3).replace(/__/g, '/')}\n\n## Quirks\n`;
    }
    return `# ${path.replace(/\.md$/, '')}\n`;
  }

  /** Write a proposal's change and commit it. Returns the commit. */
  private async applyProposal(p: MemoryProposal, auto: boolean, nb?: NotebookInfo | null): Promise<string> {
    const provider = this.deps.provider;
    const path = p.target_path;
    const exists = await provider.exists(path);
    const current = exists
      ? await provider.read(path)
      : { content: await this.newFileFor(path, nb), version: null };
    let doc = parseMemory(current.content);
    const key = ulid().slice(-8).toLowerCase();
    const src = p.evidence.find((e) => e.message_id)?.message_id ?? p.evidence.find((e) => e.run_id)?.run_id;
    const meta: EntryMeta & { m: string } = {
      m: key,
      conf: Math.round(p.confidence * 100) / 100,
      ...(src && { src }),
      at: today(),
    };
    const text = cleanEntry(p.text);
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
    const ev = p.evidence[0];
    const thread = ev?.thread_id
      ? await this.deps.threads?.getThread(ev.thread_id).catch(() => undefined)
      : undefined;
    const body = [
      ...(ev?.thread_id
        ? [
            `From thread "${thread?.title ?? 'Untitled'}" (${ev.thread_id})${ev.message_id ? `, message ${ev.message_id}` : ''}.`,
          ]
        : ev?.run_id
          ? [`From run ${ev.run_id}.`]
          : []),
      `Detected: ${KIND_LABEL[p.kind]} · confidence ${meta.conf} · ${auto ? 'auto-applied' : 'approved'}`,
    ];
    const r = await provider.writeDetailed({
      path,
      content: renderMemory(doc),
      baseVersion: current.version,
      message: formatCommitMessage({
        scope: scopeOf(path),
        summary: summarise(text),
        body,
        trailers: { 'Ancile-Proposal': p.id },
      }),
      author: auto ? provider.author : this.deps.user,
    });
    await this.deps.index.refresh(path);
    return r.version;
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
    c: CaptureCandidate,
    opts: { notebook?: NotebookInfo | null } = {},
  ): Promise<MemoryProposal | null> {
    const mode = await this.captureMode();
    const explicit = !!c.explicit && c.provenance === 'user_message';
    if (mode === 'off' && !explicit) return null;
    await this.sweepWatches().catch(() => undefined);
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
    const d = checkDecision(out ?? null, c.text, neighbours);
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
      rationale: d.rationale,
    };

    // M8, proved or suggested: a lesson from a run needs a second sighting or checked evidence.
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
        await this.announce(w, c, false, true);
        return w;
      }
    }

    let p: MemoryProposal;
    if (seen) {
      // The second sighting: the watch item becomes an ordinary proposal, with both cases as evidence.
      p =
        (await this.deps.proposals.update(seen.id, {
          status: 'proposed',
          ...fields,
          evidence: [...seen.evidence, ...evidence].slice(-6),
          sightings: (seen.sightings ?? 1) + 1,
          expires_at: null,
          uncertainty: null,
        })) ?? seen;
    } else {
      p = await this.deps.proposals.create({
        kind: c.kind,
        target_path: c.targetPath,
        section: c.section,
        ...fields,
        confidence: c.confidence,
        provenance: c.provenance,
        evidence,
        status: 'proposed',
      });
    }
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
    return { ...buildMemoryPack(files, budget), budget };
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
          lesson && it.root_cause && !/^unclear/i.test(it.root_cause)
            ? `${it.text.replace(/\.$/, '')}. Cause: ${it.root_cause.replace(/\.$/, '')}`
            : it.text,
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

  /* ---- Capture --------------------------------------------------------------- */

  /** After a turn is saved: learn from it, in the background. */
  afterTurn(turn: TurnRecord): Promise<void> {
    const done = this.capture(turn).catch((err) => {
      log.warn({ err, thread_id: turn.threadId }, 'memory capture failed; nothing learned from this turn');
    });
    this.capturing.add(done);
    void done.finally(() => this.capturing.delete(done));
    return done;
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
        },
        { notebook: nb },
      );
      // They have said what they want kept; the correction detector has nothing to add.
    }
    if (off) return;

    // 1. A correction of the assistant, in the user's own words.
    if (!ask && user && threads && this.deps.utility) {
      const original = user.edit_of_id ? await threads.getMessage(user.edit_of_id) : undefined;
      let assistant: { parts: Part[]; role: string } | undefined;
      if (original) {
        const all = await threads.messages(turn.threadId);
        assistant = all.find((m) => m.parent_id === original.id && m.role === 'assistant');
      } else if (user.parent_id) {
        const parent = await threads.getMessage(user.parent_id);
        if (parent?.role === 'assistant') assistant = parent;
      }
      const assistantText = assistant ? textOf(assistant.parts) : null;
      const editedFrom = original ? textOf(original.parts) : null;
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
          },
          CorrectionDetection,
        );
        if (
          det?.is_correction &&
          det.durable &&
          det.scope !== 'none' &&
          det.statement.trim() &&
          !staleStatement(det.statement, own, editedFrom)
        ) {
          const project = det.scope === 'notebook' && nb;
          await this.consider(
            {
              kind: 'preference',
              targetPath: project ? `PROJECTS/${nb.slug}.md` : 'USER.md',
              section: project ? 'Decisions' : 'Preferences',
              text: asEntry(det.statement),
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
        }
      }
    }

    // 2. A tool that failed, then worked: a lesson.
    for (const e of failureEpisodes(turn.parts)) {
      const line = (a: { tool: string; args: unknown; result: string }) =>
        `- ${a.tool}(${JSON.stringify(a.args).slice(0, 200)}): ${a.result.split('\n')[0]?.slice(0, 200)}`;
      const lesson =
        (await this.deps.utility
          ?.json(
            PROMPTS.lesson,
            {
              goal: userText.slice(0, 500),
              failed_steps: e.failed.map(line).join('\n'),
              successful_steps: line(e.succeeded),
              user_remarks: '',
            },
            FailureLesson,
          )
          .catch(() => null)) ?? lessonLocally(e);
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
