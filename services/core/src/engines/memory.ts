/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: Claude Code's memory writes as proposals
 *  Ref      |  docs/engines.md (Memory) · DESIGN.md §6.3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  When Claude Code writes to its own memory (a CLAUDE.md
 *           |  file, its auto-memory folder, or the memory tool), what
 *           |  it wrote is offered to NVX Ancile's memory as a
 *           |  proposal, so one memory holds what both learned.
 *  How      |  After a tool step finishes well in a live turn, its real
 *           |  arguments are read: the lines it added become at most
 *           |  three proposals through MemoryService.consider, marked
 *           |  as tool output, which is only ever proposed, never
 *           |  applied without a yes (the poisoning rule in
 *           |  memory/capture.ts). A project's CLAUDE.md goes to the
 *           |  notebook's PROJECTS file; your own (~/.claude) to USER.md.
 *  Note     |  Claude Code's write itself is a file write like any
 *           |  other, decided by the gate before it ran. Nothing here
 *           |  writes NVX Ancile's memory directly.
 * ------------------------------------------------------------------
 */

import type { MemoryService, NotebookInfo } from '../memory/service';
import { logFor } from '../obs/logger';
import { lineDelta } from './digest';

const log = logFor('engines-memory');

/** Proposals from one write, at most. */
export const MAX_PROPOSALS = 3;
const MIN_CHARS = 8;
const MAX_CHARS = 400;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export interface MemoryWrite {
  /** Your own memory (~/.claude) or the project's (CLAUDE.md in the folder). */
  scope: 'user' | 'project';
  path: string;
  /** The entries it added, cleaned. */
  entries: string[];
}

/**
 * Is this a path Claude Code keeps memory in, and whose? The auto-memory
 * folder and the memory tool are yours; a CLAUDE.md inside the session's
 * folder is the project's; ~/.claude/CLAUDE.md is yours. A CLAUDE.md in
 * some other folder is neither.
 */
export function memoryScopeOf(path: string, cwd?: string | null): 'user' | 'project' | null {
  const p = path.replace(/\\/g, '/');
  const base = p.split('/').pop() ?? '';
  if (/^\/memories\//.test(p)) return 'user';
  if (/(^|\/)\.claude\/(.*\/)?memory\/[^/]+\.md$/i.test(p)) return 'user';
  if (!/^claude(\.local)?\.md$/i.test(base)) return null;
  if (cwd) {
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (p.toLowerCase().startsWith(`${root}/`)) return 'project';
  }
  if (/(^|\/)\.claude\/claude(\.local)?\.md$/i.test(p)) return 'user';
  return cwd ? null : 'project';
}

/** The lines a write added, as memory entries: no headings, no front matter, no blanks. */
export function entriesOf(added: string[]): string[] {
  let inFront = false;
  const out: string[] = [];
  for (const [i, raw] of added.entries()) {
    const l = raw.trim();
    if (i === 0 && l === '---') {
      inFront = true;
      continue;
    }
    if (inFront) {
      if (l === '---') inFront = false;
      continue;
    }
    if (!l || l.startsWith('#') || l.startsWith('<!--') || /^[-*_]{3,}$/.test(l)) continue;
    const text = l.replace(/^([-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '');
    if (text.length < MIN_CHARS) continue;
    out.push(text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text);
  }
  return out;
}

const addedLines = (before: string, after: string): string[] => {
  const d = lineDelta(before, after);
  if (!d.add) return [];
  const old = new Map<string, number>();
  for (const l of before.split(/\r?\n/)) old.set(l, (old.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of after.split(/\r?\n/)) {
    const n = old.get(l) ?? 0;
    if (n > 0) old.set(l, n - 1);
    else out.push(l);
  }
  return out;
};

/** What a finished tool step wrote to Claude Code's memory, or null when it wrote none. */
export function memoryWriteOf(tool: string, input: unknown, cwd?: string | null): MemoryWrite | null {
  if (!isObj(input)) return null;
  let path = '';
  let lines: string[] = [];
  switch (tool) {
    case 'Write':
      path = str(input.file_path);
      lines = str(input.content).split(/\r?\n/);
      break;
    case 'Edit':
      path = str(input.file_path);
      lines = addedLines(str(input.old_string), str(input.new_string));
      break;
    case 'MultiEdit':
      path = str(input.file_path);
      lines = (Array.isArray(input.edits) ? input.edits.filter(isObj) : []).flatMap((e) =>
        addedLines(str(e.old_string), str(e.new_string)),
      );
      break;
    case 'memory': {
      // The memory tool: create, str_replace and insert under /memories.
      path = str(input.path);
      const cmd = str(input.command);
      if (cmd === 'create') lines = str(input.file_text).split(/\r?\n/);
      else if (cmd === 'str_replace') lines = addedLines(str(input.old_str), str(input.new_str));
      else if (cmd === 'insert') lines = str(input.insert_text).split(/\r?\n/);
      else return null;
      break;
    }
    default:
      return null;
  }
  const scope = path ? memoryScopeOf(path, cwd) : null;
  if (!scope) return null;
  const entries = entriesOf(lines);
  return entries.length ? { scope, path, entries } : null;
}

export interface ToolDone {
  threadId: string;
  notebookId: string | null;
  runId: string;
  messageId: string;
  /** The session's folder. */
  cwd: string | null;
  tool: string;
  input: unknown;
  ok: boolean;
}

/** Offers Claude Code's memory writes to NVX Ancile's memory, as proposals only. */
export class ClaudeMemoryMirror {
  constructor(
    private readonly deps: {
      memory: Pick<MemoryService, 'consider'>;
      notebook(id: string): Promise<NotebookInfo | null>;
    },
  ) {}

  async onToolDone(e: ToolDone): Promise<number> {
    if (!e.ok) return 0;
    const w = memoryWriteOf(e.tool, e.input, e.cwd);
    if (!w) return 0;
    const nb = w.scope === 'project' && e.notebookId ? await this.deps.notebook(e.notebookId) : null;
    const project = w.scope === 'project' && nb;
    let n = 0;
    for (const entry of w.entries.slice(0, MAX_PROPOSALS)) {
      try {
        const p = await this.deps.memory.consider(
          {
            kind: project ? 'project_finding' : 'preference',
            targetPath: project ? `PROJECTS/${nb.slug}.md` : 'USER.md',
            section: project ? 'Findings' : 'Preferences',
            text: entry,
            confidence: 0.5,
            evidence: [
              {
                threadId: e.threadId,
                messageId: e.messageId,
                runId: e.runId,
                quote: `Claude Code wrote this to ${w.path.split(/[\\/]/).pop()}: ${entry}`,
              },
            ],
            // What a tool wrote is only ever proposed (memory/capture.ts applyPolicy).
            provenance: 'tool_output',
          },
          { notebook: nb },
        );
        if (p) n++;
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'a Claude Code memory write could not be proposed');
      }
    }
    if (n) log.info({ thread_id: e.threadId, proposals: n }, "Claude Code's memory write was proposed");
    return n;
  }
}
