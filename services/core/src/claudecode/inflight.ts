/**
 * ------------------------------------------------------------------
 *  Title    |  Subagents and background shells, from transcripts
 *  Ref      |  docs/activity.md · ROADMAP G (Activity panel)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Say which subagents a Claude Code session has started
 *           |  and not heard back from, and which background shells it
 *           |  started, and whether the transcript says they finished.
 *  How      |  A session's transcript is read from where the last read
 *           |  stopped (only new bytes; a half-written last line waits),
 *           |  and each new line is folded into a small state:
 *           |  - a Task or Agent call opens a subagent; its result
 *           |    closes it (a background agent closes on its task
 *           |    notification instead);
 *           |  - a Bash call with run_in_background opens a shell; its
 *           |    result gives the shell's id; a task notification, a
 *           |    BashOutput or TaskOutput result with a status, or a
 *           |    KillShell or TaskStop call settles it.
 *           |  A file that shrank is read again from the start. A very
 *           |  large file is read from its last TAIL_BYTES on first
 *           |  sight.
 *  Note     |  Read-only, and only transcripts the caller found through
 *           |  findTranscript. A command is kept as one line, cut short,
 *           |  with key shapes redacted (obs/redact.ts plus assignments
 *           |  and flags that look like secrets); the rest of a command
 *           |  and every output stay in the file.
 * ------------------------------------------------------------------
 */

import { open, stat } from 'node:fs/promises';
import { redactText } from '../obs/redact';

/** Longest command line kept. */
export const COMMAND_MAX = 80;
/** On first sight of a file larger than this, only its end is read. */
export const TAIL_BYTES = 16 * 1024 * 1024;
/** Shells kept per session (the newest). */
const SHELLS_KEPT = 50;

export type ShellState = 'running' | 'finished' | 'failed' | 'stopped';

export interface InflightAgent {
  callId: string;
  /** The assistant entry holding the call (to find its message). */
  entryUuid: string | null;
  description: string | null;
  agentType: string | null;
  startedAt: string | null;
  background: boolean;
}

export interface ShellRecord {
  callId: string;
  entryUuid: string | null;
  /** First line, cut short, secrets redacted. */
  command: string;
  description: string | null;
  /** The id Claude Code gave the shell, once its result says. */
  taskId: string | null;
  state: ShellState;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Inflight {
  agents: InflightAgent[];
  shells: ShellRecord[];
  /** The newest timestamp seen in the file. */
  lastAt: string | null;
}

/** Folding state for one transcript. */
export interface FoldState {
  agents: Map<string, InflightAgent>;
  /** Background agents whose launch was acknowledged: closed by their notification. */
  launched: Map<string, InflightAgent & { agentId: string | null }>;
  shells: Map<string, ShellRecord>;
  /** Pending BashOutput / TaskOutput calls: call id → shell id asked about. */
  peeks: Map<string, string>;
  /** Pending KillShell / TaskStop calls: call id → shell id. */
  kills: Map<string, string>;
  lastAt: string | null;
}

export function emptyFold(): FoldState {
  return {
    agents: new Map(),
    launched: new Map(),
    shells: new Map(),
    peeks: new Map(),
    kills: new Map(),
    lastAt: null,
  };
}

const SECRET_ASSIGN =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH)[A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_FLAG =
  /(--?(?:password|passwd|pass|token|api[-_]?key|secret|auth|key|access[-_]?key|client[-_]?secret)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi;
const AUTH_HEADER =
  /((?:authorization|x-api-key|api-key)\s*:\s*)("[^"]*"|'[^']*'|[^\s"']+(?:\s+[^\s"']+)?)/gi;

/** One line of a command, safe to show: first line, key shapes redacted, cut short. */
export function commandSummary(command: string, max = COMMAND_MAX): string {
  const first =
    command
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const more = command.trim().includes('\n');
  let s = redactText(first)
    .replace(SECRET_ASSIGN, '$1…')
    .replace(SECRET_FLAG, '$1…')
    .replace(URL_CREDS, '$1…@')
    .replace(AUTH_HEADER, '$1…');
  // Long opaque runs (keys of unknown shape) are not worth showing either.
  s = s.replace(/[A-Za-z0-9+/_=-]{40,}/g, (m) => `${m.slice(0, 4)}…`);
  if (s.length > max) return `${s.slice(0, max - 1).trimEnd()}…`;
  return more ? `${s} …` : s;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The text of a tool result's content. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  return '';
}

function tag(s: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(s);
  return m ? (m[1] ?? '').trim() || null : null;
}

function settleFrom(status: string | null): ShellState | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s === 'running' || s === 'pending' || s === 'in_progress') return 'running';
  if (/^(failed|error|errored)$/.test(s)) return 'failed';
  if (/^(killed|stopped|cancell?ed|aborted)$/.test(s)) return 'stopped';
  if (/^(completed|complete|done|finished|success|succeeded|exited)$/.test(s)) return 'finished';
  return null;
}

function shellBy(state: FoldState, id: string): ShellRecord | undefined {
  return state.shells.get(id) ?? [...state.shells.values()].find((s) => s.taskId === id);
}

function settle(sh: ShellRecord | undefined, to: ShellState, at: string | null) {
  if (!sh || to === 'running' || sh.state !== 'running') return;
  sh.state = to;
  sh.finishedAt = at;
}

/** A task notification anywhere in a line: what it settles. */
function notification(state: FoldState, line: string, at: string | null) {
  let from = line.indexOf('<task-notification');
  while (from >= 0) {
    const end = line.indexOf('</task-notification>', from);
    const chunk = line.slice(from, end > 0 ? end : undefined);
    const taskId = tag(chunk, 'task-id');
    const callId = tag(chunk, 'tool-use-id');
    const to = settleFrom(tag(chunk, 'status')) ?? 'finished';
    const sh = (callId && state.shells.get(callId)) || (taskId && shellBy(state, taskId)) || undefined;
    settle(sh, to, at);
    for (const [k, a] of state.launched)
      if (k === callId || (taskId && a.agentId === taskId)) state.launched.delete(k);
    from = end > 0 ? line.indexOf('<task-notification', end) : -1;
  }
}

/** Fold one transcript line into the state. */
export function foldLine(state: FoldState, line: string): void {
  if (!line.trim()) return;
  let e: Record<string, unknown>;
  try {
    const j = JSON.parse(line) as unknown;
    if (!isObj(j)) return;
    e = j;
  } catch {
    return;
  }
  const at = str(e.timestamp);
  if (at && (!state.lastAt || at > state.lastAt)) state.lastAt = at;
  if (line.includes('<task-notification')) notification(state, line, at);
  // A subagent's own entries (older Claude Code wrote them here) are its business.
  if (e.isSidechain === true) return;
  const msg = isObj(e.message) ? e.message : null;
  const content = Array.isArray(msg?.content) ? (msg?.content as unknown[]) : [];
  const uuid = str(e.uuid);
  if (e.type === 'assistant') {
    for (const b of content) {
      if (!isObj(b) || b.type !== 'tool_use') continue;
      const id = str(b.id);
      const name = str(b.name) ?? '';
      const input = isObj(b.input) ? b.input : {};
      if (!id) continue;
      if (name === 'Task' || name === 'Agent') {
        state.agents.set(id, {
          callId: id,
          entryUuid: uuid,
          description: str(input.description) ?? (str(input.prompt)?.slice(0, 80) || null),
          agentType: str(input.subagent_type),
          startedAt: at,
          background: input.run_in_background === true,
        });
      } else if ((name === 'Bash' || name === 'PowerShell') && input.run_in_background === true) {
        state.shells.set(id, {
          callId: id,
          entryUuid: uuid,
          command: commandSummary(str(input.command) ?? ''),
          description: str(input.description),
          taskId: null,
          state: 'running',
          startedAt: at,
          finishedAt: null,
        });
        if (state.shells.size > SHELLS_KEPT) {
          const oldest = state.shells.keys().next().value;
          if (oldest) state.shells.delete(oldest);
        }
      } else if (name === 'BashOutput' || name === 'TaskOutput') {
        const target = str(input.bash_id) ?? str(input.task_id) ?? str(input.shell_id);
        if (target) state.peeks.set(id, target);
      } else if (name === 'KillShell' || name === 'KillBash' || name === 'TaskStop') {
        const target = str(input.shell_id) ?? str(input.task_id) ?? str(input.bash_id);
        if (target) state.kills.set(id, target);
      }
    }
    return;
  }
  if (e.type !== 'user') return;
  const extra = isObj(e.toolUseResult) ? e.toolUseResult : {};
  for (const b of content) {
    if (!isObj(b) || b.type !== 'tool_result') continue;
    const id = str(b.tool_use_id);
    if (!id) continue;
    const text = resultText(b.content);
    const failed = b.is_error === true;
    const agent = state.agents.get(id);
    if (agent) {
      state.agents.delete(id);
      if (agent.background && !failed)
        state.launched.set(id, {
          ...agent,
          agentId: str(extra.agentId) ?? /agentId:\s*([\w-]+)/.exec(text)?.[1] ?? null,
        });
      continue;
    }
    const sh = state.shells.get(id);
    if (sh) {
      if (failed) settle(sh, 'failed', at);
      else
        sh.taskId =
          str(extra.backgroundTaskId) ??
          /\bID:\s*([A-Za-z0-9_-]{3,})/.exec(text)?.[1] ??
          /\b(?:shell|task|bash)[ _-]?id[:\s]+([A-Za-z0-9_-]{3,})/i.exec(text)?.[1] ??
          null;
      continue;
    }
    const peek = state.peeks.get(id);
    if (peek) {
      state.peeks.delete(id);
      const to = settleFrom(tag(text, 'status') ?? (str(extra.status) as string | null));
      if (to) settle(shellBy(state, peek), to, at);
      continue;
    }
    const kill = state.kills.get(id);
    if (kill) {
      state.kills.delete(id);
      if (!failed) settle(shellBy(state, kill), 'stopped', at);
    }
  }
}

export function inflightOf(state: FoldState): Inflight {
  return {
    agents: [...state.agents.values(), ...[...state.launched.values()].map(({ agentId: _a, ...a }) => a)],
    shells: [...state.shells.values()].map((s) => ({ ...s })),
    lastAt: state.lastAt,
  };
}

interface FileState {
  offset: number;
  carry: Buffer;
  fold: FoldState;
  usedAt: number;
}

/** Reads transcripts incrementally, one state per file. */
export class InflightScanner {
  private readonly files = new Map<string, FileState>();

  constructor(private readonly opts: { maxFiles?: number; tailBytes?: number; now?: () => number } = {}) {}

  async scan(path: string): Promise<Inflight | null> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      this.files.delete(path);
      return null;
    }
    const now = (this.opts.now ?? Date.now)();
    let f = this.files.get(path);
    if (!f || size < f.offset) {
      const tail = this.opts.tailBytes ?? TAIL_BYTES;
      f = { offset: size > tail ? size - tail : 0, carry: Buffer.alloc(0), fold: emptyFold(), usedAt: now };
      // Starting mid-file: the first line is a fragment.
      if (f.offset > 0) f.carry = Buffer.from('\u0000');
      this.files.set(path, f);
      this.trim();
    }
    f.usedAt = now;
    if (size > f.offset) {
      const fh = await open(path, 'r');
      try {
        const len = size - f.offset;
        const buf = Buffer.alloc(len);
        let read = 0;
        while (read < len) {
          const r = await fh.read(buf, read, len - read, f.offset + read);
          if (!r.bytesRead) break;
          read += r.bytesRead;
        }
        f.offset += read;
        const all = Buffer.concat([f.carry, buf.subarray(0, read)]);
        const cut = all.lastIndexOf(0x0a);
        if (cut < 0) f.carry = all;
        else {
          f.carry = all.subarray(cut + 1);
          const lines = all.subarray(0, cut).toString('utf8').split('\n');
          if (lines[0]?.startsWith('\u0000')) lines.shift();
          for (const l of lines) foldLine(f.fold, l.replace(/\r$/, ''));
        }
      } finally {
        await fh.close();
      }
    }
    return inflightOf(f.fold);
  }

  /** Drop the state of files read least recently, beyond the cap. */
  private trim() {
    const max = this.opts.maxFiles ?? 64;
    if (this.files.size <= max) return;
    const order = [...this.files.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [k] of order.slice(0, this.files.size - max)) this.files.delete(k);
  }
}
