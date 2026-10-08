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
  type PutMemoryFileResponse,
} from '@nvx/contracts';
import { MemoryConflict } from '@nvx/plugin-sdk';
import { ulid } from 'ulid';
import type { z } from 'zod';
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
  topicSlug,
} from './capture';
import { addEntry, type EntryMeta, parseMemory, renderMemory, supersedeEntry, updateEntry } from './format';
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
    for (const p of await this.deps.proposals.list({ status: ['applied', 'auto_applied'], limit: 500 }))
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

  async proposals(status?: MemoryProposal['status'][]): Promise<MemoryProposalList> {
    return {
      items: await this.deps.proposals.list({ ...(status && { status }), limit: 200 }),
      pending: await this.deps.proposals.pending(),
    };
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

    if (req.decision === 'reject') {
      if (p.status !== 'proposed') throw wrong();
      return (await this.deps.proposals.update(id, { status: 'rejected', decided: true })) as MemoryProposal;
    }
    if (req.decision === 'approve') {
      if (p.status !== 'proposed') throw wrong();
      const text = req.text ? cleanEntry(req.text) : p.text;
      const sha = await this.applyProposal({ ...p, text }, false);
      return (await this.deps.proposals.update(id, {
        status: 'applied',
        commit_sha: sha,
        text,
        decided: true,
      })) as MemoryProposal;
    }
    // undo
    if ((p.status !== 'applied' && p.status !== 'auto_applied') || !p.commit_sha) throw wrong();
    await this.revert(p.commit_sha);
    return (await this.deps.proposals.get(id)) as MemoryProposal;
  }

  private async newFileFor(path: string, notebook?: NotebookInfo | null): Promise<string> {
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
   * Reconcile a candidate with what is already remembered, then propose it or
   * apply it. Returns the proposal, or null when nothing needed doing.
   */
  async consider(
    c: CaptureCandidate,
    opts: { notebook?: NotebookInfo | null } = {},
  ): Promise<MemoryProposal | null> {
    const mode = await this.captureMode();
    if (mode === 'off') return null;
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
    let p = await this.deps.proposals.create({
      kind: c.kind,
      target_path: c.targetPath,
      op: d.op,
      section: c.section,
      text: asEntry(cleanEntry(d.text)),
      target_key: target?.key ?? null,
      target_text: target?.text ?? null,
      rationale: d.rationale,
      confidence: c.confidence,
      provenance: c.provenance,
      evidence: c.evidence.map((e) => ({
        ...(e.threadId && { thread_id: e.threadId }),
        ...(e.messageId && { message_id: e.messageId }),
        ...(e.runId && { run_id: e.runId }),
        ...(e.quote && { quote: e.quote.slice(0, 300) }),
      })),
      status: 'proposed',
    });
    if (verdict === 'auto_apply') {
      const sha = await this.applyProposal(p, true, opts.notebook);
      p =
        (await this.deps.proposals.update(p.id, {
          status: 'auto_applied',
          commit_sha: sha,
          decided: true,
        })) ?? p;
    }
    await this.deps.bus
      ?.publish({
        type: 'memory.proposal',
        proposal_id: p.id,
        target_path: p.target_path,
        auto_applied: p.status === 'auto_applied',
        text: p.text,
        kind: p.kind,
        // The answer and run it came from, so the tray under that answer shows it.
        ...(c.evidence.find((e) => e.messageId)?.messageId && {
          message_id: c.evidence.find((e) => e.messageId)?.messageId,
        }),
        ...(c.evidence.find((e) => e.runId)?.runId && { run_id: c.evidence.find((e) => e.runId)?.runId }),
      })
      .catch(() => undefined);
    return p;
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
      if (spec.scope === 'retrieved') {
        const re = globToRegExp(spec.path);
        const scored = ix
          .paths()
          .filter((p) => re.test(p) && !isGuideFile(p))
          .flatMap((p) => live(p).map((e) => ({ e, s: similarity(req.query, e.text) })))
          .filter((x) => x.s > 0.08)
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

  /* ---- Capture --------------------------------------------------------------- */

  /** After a turn is saved: learn from it, in the background. */
  afterTurn(turn: TurnRecord): Promise<void> {
    return this.capture(turn).catch((err) => {
      log.warn({ err, thread_id: turn.threadId }, 'memory capture failed; nothing learned from this turn');
    });
  }

  private async capture(turn: TurnRecord): Promise<void> {
    if ((await this.captureMode()) === 'off') return;
    const threads = this.deps.threads;
    const user = await threads?.getMessage(turn.userMessageId);
    const userText = user ? textOf(user.parts) : '';
    const nb = turn.notebookId ? await this.deps.notebook?.(turn.notebookId).catch(() => null) : null;

    // 1. A correction of the assistant, in the user's own words.
    if (user && threads && this.deps.utility) {
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
        if (det?.is_correction && det.durable && det.scope !== 'none' && det.statement.trim()) {
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
