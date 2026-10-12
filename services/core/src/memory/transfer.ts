/**
 * ------------------------------------------------------------------
 *  Title    |  Memory export and import
 *  Ref      |  docs/memory.md (Import and export) · DESIGN.md §6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Take memory with you, and bring in what another tool
 *           |  (or another NVX Ancile) remembered, without ever letting
 *           |  outside content become memory on its own.
 *  How      |  Export: the repository as a zip (git archive), a git
 *           |  bundle (history and all) or one readable Markdown file;
 *           |  or one notebook's file. Made here and handed to the
 *           |  browser to save: nothing is uploaded. Private notebooks
 *           |  can be left out of a zip or Markdown export.
 *           |  Import: a file or paste is read into candidate entries
 *           |  (importers.ts), previewed with duplicates marked, then
 *           |  each chosen one becomes a proposal (kind imported,
 *           |  provenance import) tied to one core.memory_imports row.
 *           |  Accepting writes every accepted entry in ONE commit
 *           |  ("memory(import): 12 entries from ChatGPT memory"), so
 *           |  one Undo takes the whole import back.
 *  Note     |  A notebook whose scope does not let memory learn
 *           |  (memory_write off) takes no imports. Picked files are
 *           |  read by the browser; Core sees their text and name only.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type MemoryExportFormat,
  type MemoryExportPlan,
  type MemoryImportDecision,
  type MemoryImportDecisionResult,
  type MemoryImportItem,
  type MemoryImportList,
  type MemoryImportPreview,
  type MemoryImportRequest,
  type MemoryImportSummary,
  type MemoryImportView,
  type MemoryProposal,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import {
  type ArchiveFile,
  isBundle,
  isMarkdownExport,
  isZip,
  readBundle,
  readMarkdownExport,
  readZip,
  unreadable,
  writeMarkdownExport,
} from './archive';
import { addEntry, parseMemory, renderMemory } from './format';
import {
  fromAncileFiles,
  fromChatGpt,
  fromNotes,
  type ImportCandidate,
  ORIGIN_LABEL,
  type ParsedImport,
  sameText,
} from './importers';
import { isGuideFile, type MemoryIndex } from './index';
import type { ImportRecord, ProposalStore } from './proposals';
import { formatCommitMessage, type GitMemoryProvider } from './repo';
import type { MemoryService, NotebookInfo } from './service';

/** At most this many entries come in from one import. */
export const IMPORT_MAX_ITEMS = 2_000;

export interface TransferNotebook extends NotebookInfo {
  private: boolean;
}

export interface MemoryTransferDeps {
  service: Pick<MemoryService, 'newFileFor'>;
  provider: GitMemoryProvider;
  index: MemoryIndex;
  proposals: ProposalStore;
  /** The person, who accepts an import (the commit's author). */
  user: { name: string; email: string };
  notebooks?: () => Promise<TransferNotebook[]>;
  /** May memory be written for this notebook (its effective scope's memory_write)? */
  memoryWritable?: (notebookId: string) => Promise<boolean>;
  now?: () => Date;
}

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

const notFound = (code: string, title: string, hint: string) =>
  new AncileError({ code, title, hint, status: 404, errorClass: 'permanent' });

export class MemoryTransfer {
  constructor(private readonly deps: MemoryTransferDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async notebooks(): Promise<TransferNotebook[]> {
    return (await this.deps.notebooks?.().catch(() => [])) ?? [];
  }

  /* ---- export -------------------------------------------------------------------- */

  async plan(): Promise<MemoryExportPlan> {
    const files = await this.deps.provider.list();
    const paths = new Set(files.map((f) => f.path));
    const entries = files
      .filter((f) => !isGuideFile(f.path))
      .reduce(
        (n, f) => n + (this.deps.index.file(f.path)?.entries.filter((e) => !e.superseded).length ?? 0),
        0,
      );
    return {
      head: await this.deps.provider.head(),
      files: files.filter((f) => !isGuideFile(f.path)).length,
      entries,
      notebooks: (await this.notebooks()).map((n) => {
        const path = `PROJECTS/${n.slug}.md`;
        return { id: n.id, title: n.title, path, exists: paths.has(path), private: n.private };
      }),
    };
  }

  async export(opts: {
    format: MemoryExportFormat;
    notebookId?: string | null;
    leaveOutPrivate?: boolean;
  }): Promise<ExportFile> {
    const { provider } = this.deps;
    const date = this.now().toISOString().slice(0, 10);
    const listed = await provider.list();
    const notebooks = await this.notebooks();
    let paths = listed.map((f) => f.path);
    let name = `ancile-memory-${date}`;
    let privateIncluded = false;

    if (opts.notebookId) {
      const nb = notebooks.find((n) => n.id === opts.notebookId);
      if (!nb)
        throw notFound('notebook.not_found', 'That notebook does not exist', 'Reload the list of notebooks.');
      const path = `PROJECTS/${nb.slug}.md`;
      if (!paths.includes(path))
        throw notFound(
          'memory.not_found',
          `“${nb.title}” has no memory yet`,
          'Its memory file appears once something is learned or written for it.',
        );
      if (opts.format === 'bundle') throw bundleWhole();
      paths = [path];
      name = `ancile-memory-${nb.slug}-${date}`;
      privateIncluded = nb.private;
    } else {
      const hidden = new Set(notebooks.filter((n) => n.private).map((n) => `PROJECTS/${n.slug}.md`));
      const hasPrivate = paths.some((p) => hidden.has(p));
      if (opts.leaveOutPrivate && hasPrivate) {
        if (opts.format === 'bundle') throw bundleWhole();
        paths = paths.filter((p) => !hidden.has(p));
      } else privateIncluded = hasPrivate;
    }

    if (opts.format === 'bundle')
      return {
        filename: `${name}.bundle`,
        contentType: 'application/octet-stream',
        body: await provider.bundle(),
      };

    if (opts.format === 'zip') {
      // git archive reads what is committed; a file only on disk is not in it.
      const committed = new Set(listed.filter((f) => f.version !== 'uncommitted').map((f) => f.path));
      const want = paths.filter((p) => committed.has(p));
      const whole = want.length === listed.length && !opts.notebookId;
      if (!want.length)
        throw notFound(
          'memory.not_found',
          'There is nothing to export yet',
          'Memory has no committed files.',
        );
      const body = await provider.archiveZip(whole ? undefined : want);
      return { filename: `${name}.zip`, contentType: 'application/zip', body };
    }

    const files: ArchiveFile[] = [];
    for (const p of paths.sort()) files.push({ path: p, content: (await provider.read(p)).content });
    const note = [
      `Exported from NVX Ancile on ${this.now().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.`,
      'It was made on this computer and nothing was uploaded: it stays wherever you save it.',
      privateIncluded ? 'It holds memory from a private notebook: keep the file somewhere private.' : '',
      'Import it into NVX Ancile from Memory → Import and export.',
    ]
      .filter(Boolean)
      .join(' ');
    const text = writeMarkdownExport(files, { head: await provider.head(), date, note });
    return {
      filename: `${name}.md`,
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(text, 'utf8'),
    };
  }

  /* ---- import: read and preview ------------------------------------------------------ */

  private async targetPath(
    req: MemoryImportRequest,
  ): Promise<{ path: string; notebook: TransferNotebook | null }> {
    const t = req.target;
    if (t.kind === 'user') return { path: 'USER.md', notebook: null };
    if (t.kind === 'agents') return { path: 'AGENTS.md', notebook: null };
    const nb = (await this.notebooks()).find((n) => n.id === t.notebook_id);
    if (!nb) throw notFound('notebook.not_found', 'That notebook does not exist', 'Pick another notebook.');
    await this.ensureWritable(nb);
    return { path: `PROJECTS/${nb.slug}.md`, notebook: nb };
  }

  private async ensureWritable(nb: TransferNotebook): Promise<void> {
    if (this.deps.memoryWritable && !(await this.deps.memoryWritable(nb.id)))
      throw new AncileError({
        code: 'memory.import_not_allowed',
        title: `“${nb.title}” does not let memory learn`,
        hint: 'Its scope has memory writing switched off. Turn it on in the notebook’s scope, or import into About you instead.',
        status: 409,
        errorClass: 'permanent',
        context: { notebook_id: nb.id },
      });
  }

  private async parse(req: MemoryImportRequest): Promise<ParsedImport> {
    const buf = req.data_base64 ? Buffer.from(req.data_base64, 'base64') : null;
    if (req.origin === 'ancile') {
      let files: ArchiveFile[];
      if (buf && isZip(buf)) files = readZip(buf);
      else if (buf && isBundle(buf)) files = await readBundle(buf);
      else {
        const text = req.text ?? buf?.toString('utf8') ?? '';
        if (!isMarkdownExport(text)) throw unreadable('an NVX Ancile memory export');
        files = readMarkdownExport(text);
      }
      const parsed = fromAncileFiles(files);
      // A notebook here whose scope keeps memory out takes none of it.
      const blocked = new Set<string>();
      for (const nb of await this.notebooks()) {
        const path = `PROJECTS/${nb.slug}.md`;
        if (!parsed.candidates.some((c) => c.target_path === path)) continue;
        if (this.deps.memoryWritable && !(await this.deps.memoryWritable(nb.id))) blocked.add(path);
      }
      if (blocked.size) {
        const before = parsed.candidates.length;
        parsed.candidates = parsed.candidates.filter((c) => !blocked.has(c.target_path));
        parsed.notes.push(
          `${plural(before - parsed.candidates.length, 'entry', 'entries')} for a notebook that does not let memory learn ${before - parsed.candidates.length === 1 ? 'was' : 'were'} left out.`,
        );
      }
      return parsed;
    }
    const text = req.text ?? buf?.toString('utf8') ?? '';
    const { path } = await this.targetPath(req);
    if (req.origin === 'chatgpt') return fromChatGpt(text, { path });
    return fromNotes(text, {
      path,
      label: ORIGIN_LABEL[req.origin],
      claudeCode: req.origin === 'claude_code',
    });
  }

  async preview(req: MemoryImportRequest): Promise<MemoryImportPreview> {
    return (await this.analyse(req)).preview;
  }

  private async analyse(
    req: MemoryImportRequest,
  ): Promise<{ preview: MemoryImportPreview; candidates: ImportCandidate[] }> {
    const parsed = await this.parse(req);
    const notes = [...parsed.notes];
    let candidates: ImportCandidate[] = parsed.candidates;
    if (candidates.length > IMPORT_MAX_ITEMS) {
      notes.push(
        `Only the first ${IMPORT_MAX_ITEMS.toLocaleString('en-GB')} of ${candidates.length.toLocaleString('en-GB')} entries were read. Import the rest separately.`,
      );
      candidates = candidates.slice(0, IMPORT_MAX_ITEMS);
    }
    const known = new Map<string, Set<string>>();
    const knownFor = (path: string) => {
      let s = known.get(path);
      if (!s) {
        s = new Set(
          (this.deps.index.file(path)?.entries ?? [])
            .filter((e) => !e.superseded)
            .map((e) => sameText(e.text)),
        );
        known.set(path, s);
      }
      return s;
    };
    const seen = new Set<string>();
    const items: MemoryImportItem[] = candidates.map((c, index) => {
      const key = `${c.target_path}\u0000${sameText(c.text)}`;
      const status = knownFor(c.target_path).has(sameText(c.text))
        ? 'duplicate'
        : seen.has(key)
          ? 'repeated'
          : 'new';
      seen.add(key);
      return {
        index,
        target_path: c.target_path,
        section: c.section,
        text: c.text,
        status,
        clipped: c.clipped,
      };
    });
    const dup = items.filter((i) => i.status !== 'new').length;
    const clipped = items.filter((i) => i.clipped).length;
    if (dup)
      notes.push(
        `${plural(dup, 'entry is', 'entries are')} already in memory or repeated, and ${dup === 1 ? 'is' : 'are'} not ticked.`,
      );
    if (clipped)
      notes.push(
        `${plural(clipped, 'entry was', 'entries were')} longer than 600 characters and ${clipped === 1 ? 'was' : 'were'} cut. Edit ${clipped === 1 ? 'it' : 'them'} before accepting if needed.`,
      );
    const paths = [...new Set(items.map((i) => i.target_path))];
    const files = [];
    for (const path of paths)
      files.push({ path, exists: !!this.deps.index.file(path) || (await this.deps.provider.exists(path)) });
    return {
      candidates,
      preview: {
        origin: req.origin,
        label: parsed.label,
        filename: req.filename?.trim() || null,
        items,
        skipped: parsed.skipped,
        notes,
        files,
      },
    };
  }

  /* ---- import: proposals and review -------------------------------------------------- */

  async create(req: MemoryImportRequest): Promise<MemoryImportView> {
    const { preview, candidates } = await this.analyse(req);
    const chosen = req.include
      ? [...new Set(req.include)].map((i) => {
          const item = preview.items[i];
          if (!item)
            throw new AncileError({
              code: 'request.invalid',
              title: 'That entry is not in this import',
              hint: 'Preview the import again, then choose from the list it shows.',
              status: 400,
              errorClass: 'permanent',
              context: { index: i },
            });
          return item;
        })
      : preview.items.filter((i) => i.status === 'new');
    if (!chosen.length)
      throw new AncileError({
        code: 'memory.import_empty',
        title: 'Nothing to import',
        hint: preview.items.length
          ? 'Every entry is already in memory, or none was ticked. Tick the ones you want.'
          : 'No entries were found in it. Memory imports read bullets and paragraphs of text.',
        status: 422,
        errorClass: 'permanent',
      });
    const record = await this.deps.proposals.createImport({
      origin: preview.origin,
      label: preview.label,
      filename: preview.filename,
    });
    const from = `${preview.label}${preview.filename ? ` (${preview.filename})` : ''}`;
    // One at a time, so each row's time keeps the order they had in the file.
    for (const item of chosen.sort((a, b) => a.index - b.index)) {
      const quote = candidates[item.index]?.quote;
      await this.deps.proposals.create({
        kind: 'imported',
        target_path: item.target_path,
        op: 'add',
        section: item.section,
        text: item.text,
        target_key: null,
        target_text: null,
        rationale: `Imported from ${from}. Outside content: it is kept only if you accept it.`,
        confidence: 0.5,
        provenance: 'import',
        evidence: quote ? [{ quote }] : [],
        status: 'proposed',
        import_id: record.id,
      });
    }
    return this.view(record.id);
  }

  private summary(r: ImportRecord, ps: MemoryProposal[]): MemoryImportSummary {
    const count = (s: MemoryProposal['status'][]) => ps.filter((p) => s.includes(p.status)).length;
    const proposed = count(['proposed']);
    return {
      id: r.id,
      origin: r.origin,
      label: r.label,
      filename: r.filename,
      created_at: r.created_at,
      status: proposed ? 'reviewing' : 'done',
      counts: {
        proposed,
        applied: count(['applied', 'auto_applied']),
        rejected: count(['rejected']),
        undone: count(['undone']),
      },
    };
  }

  async list(): Promise<MemoryImportList> {
    const out: MemoryImportSummary[] = [];
    for (const r of await this.deps.proposals.listImports(50))
      out.push(this.summary(r, await this.deps.proposals.byImport(r.id)));
    return { items: out };
  }

  async view(id: string): Promise<MemoryImportView> {
    const r = await this.deps.proposals.getImport(id);
    if (!r) throw importNotFound();
    const ps = await this.deps.proposals.byImport(id);
    return { ...this.summary(r, ps), proposals: ps };
  }

  async decide(id: string, d: MemoryImportDecision): Promise<MemoryImportDecisionResult> {
    const r = await this.deps.proposals.getImport(id);
    if (!r) throw importNotFound();
    const all = await this.deps.proposals.byImport(id);
    const ids = new Set(all.map((p) => p.id));
    const asked = [
      ...(Array.isArray(d.accept) ? d.accept : []),
      ...(Array.isArray(d.reject) ? d.reject : []),
      ...Object.keys(d.edits ?? {}),
    ];
    const stray = asked.find((x) => !ids.has(x));
    if (stray)
      throw new AncileError({
        code: 'memory.proposal_not_found',
        title: 'That suggestion is not part of this import',
        hint: 'Reload the import to see its suggestions.',
        status: 404,
        errorClass: 'permanent',
        context: { proposal_id: stray },
      });
    const waiting = all.filter((p) => p.status === 'proposed');
    const acceptIds = new Set(d.accept === 'all' ? waiting.map((p) => p.id) : d.accept);
    const accept = waiting.filter((p) => acceptIds.has(p.id));
    const rejectIds = new Set(d.reject === 'rest' ? waiting.map((p) => p.id) : d.reject);
    const reject = waiting.filter((p) => rejectIds.has(p.id) && !acceptIds.has(p.id));

    let commit: string | null = null;
    if (accept.length) {
      const edits = d.edits ?? {};
      const texts = new Map(accept.map((p) => [p.id, entryLine(edits[p.id] ?? p.text)]));
      const byPath = new Map<string, MemoryProposal[]>();
      for (const p of accept) byPath.set(p.target_path, [...(byPath.get(p.target_path) ?? []), p]);
      const notebooks = await this.notebooks();
      const date = this.now().toISOString().slice(0, 10);
      const n = accept.length;
      const result = await this.deps.provider.writeMany(
        [...byPath.keys()],
        async (current) => {
          const next = new Map<string, string>();
          for (const [path, ps] of byPath) {
            const nb = path.startsWith('PROJECTS/')
              ? (notebooks.find((x) => `PROJECTS/${x.slug}.md` === path) ?? null)
              : null;
            let doc = parseMemory(current.get(path) ?? (await this.deps.service.newFileFor(path, nb)));
            for (const p of ps)
              doc = addEntry(doc, p.section, texts.get(p.id) as string, {
                m: ulid().slice(-8).toLowerCase(),
                src: id,
                at: date,
              });
            next.set(path, renderMemory(doc));
          }
          return next;
        },
        formatCommitMessage({
          scope: 'import',
          summary: `${plural(n, 'entry', 'entries')} from ${r.label}`,
          body: [
            `Imported${r.filename ? ` from ${r.filename}` : ''} (${r.label}); accepted by hand: ${n} of ${all.length}.`,
            `Files: ${[...byPath.keys()].join(', ')}.`,
          ],
          trailers: { 'Ancile-Import': id },
        }),
        this.deps.user,
      );
      for (const path of result.changed) await this.deps.index.refresh(path);
      // Nothing changed (every entry was already there): no commit to point an Undo at.
      commit = result.changed.length ? result.version : null;
      for (const p of accept)
        await this.deps.proposals.update(p.id, {
          status: 'applied',
          ...(commit && { commit_sha: commit }),
          text: texts.get(p.id) as string,
          decided: true,
        });
    }
    for (const p of reject) await this.deps.proposals.update(p.id, { status: 'rejected', decided: true });
    return {
      import: await this.view(id),
      commit_sha: commit,
      applied: accept.length,
      rejected: reject.length,
    };
  }
}

/** Entry text that cannot break the file: one line, no comment markers. */
function entryLine(text: string): string {
  return text
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

const importNotFound = () =>
  notFound(
    'memory.import_not_found',
    'That import does not exist',
    'Open Memory → Import and export to see your imports.',
  );

const bundleWhole = () =>
  new AncileError({
    code: 'memory.export_bundle_whole',
    title: 'A git bundle always holds all of memory',
    hint: 'A bundle carries every file and its history, private notebooks included. Choose a zip or Markdown to leave some out.',
    status: 422,
    errorClass: 'permanent',
  });
