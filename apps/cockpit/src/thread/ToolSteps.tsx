/**
 * ------------------------------------------------------------------
 *  Title    |  Tool steps
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What an agent did, read like an IDE's timeline: one
 *           |  calm line per step (a verb, what it touched, how it
 *           |  went) that opens onto the thing itself: the file with
 *           |  its line numbers, the edit as a diff, the command and
 *           |  its output, the matches, the plan as a checklist.
 *  How      |  kindOf() maps a tool name (Claude Code's Read, Edit,
 *           |  Bash, Agent, mcp__server__tool, or the lab's read,
 *           |  edit, bash) to a kind; describe() gives its line and
 *           |  the body for that kind draws the rest. Anything else
 *           |  keeps the plain Input and Result view. Long agentic
 *           |  turns fold into one "Worked through N steps" group.
 *           |  A call that carries its own description (Bash's and
 *           |  Task's `description`, the plan item in progress) shows
 *           |  it as the title, with the raw command muted under it
 *           |  (contracts steps.ts, the same words for every engine).
 *           |  Each step is a card whose rule and icon say its family
 *           |  (a command, an MCP tool, a subagent, any other tool).
 *           |  A live step counts its seconds on one shared clock; a
 *           |  finished one says how long it took (duration_ms) and
 *           |  what came back in one short line (resultLine: lines
 *           |  read, results found, the first line printed), never the
 *           |  result itself. An opened step always shows its input
 *           |  and its result, or why there is none.
 *  Note     |  Paths are shown relative to the session's folder
 *           |  (ToolCwd), with the full path in the tooltip.
 * ------------------------------------------------------------------
 */

import type { ActivityState, Part, ToolKind } from '@nvx/contracts';
import { stepDescription, toolKind, webHits } from '@nvx/contracts/steps';
import { createContext, type ReactNode, type SyntheticEvent, useContext, useEffect, useState } from 'react';
import { imageMeta } from '../images/ImageGenBody';
import { runMeta } from '../interpreter/PythonBody';
import { shortResource } from '../lib/mappers';
import type { SubagentView } from '../lib/types';
import { type DiffLine, diffStats, lineDiff } from '../memory/linediff';
import { Icon, type IconName } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';
import { MD_COMPONENTS } from './Citations';
import '../styles/tools.css';

export type ToolCall = Extract<Part, { type: 'tool_call' }>;
export type ToolResult = Extract<Part, { type: 'tool_result' }>;
export type StepState = 'running' | 'waiting' | 'ok' | 'failed' | 'declined';

/** The folder a Claude Code session ran in, so paths read relative to it. */
export const ToolCwd = createContext<string | null>(null);

/* ---- Words ----------------------------------------------------------------- */

export type Kind = ToolKind;

/** What kind of step a tool is (contracts steps.ts, shared with Core). */
export function kindOf(tool: string): Kind {
  return toolKind(tool);
}

/** past, progressive, bare: "Read", "Reading", "read" */
const VERBS: Record<Exclude<Kind, 'other'>, [string, string, string]> = {
  read: ['Read', 'Reading', 'read'],
  write: ['Wrote', 'Writing', 'write'],
  edit: ['Edited', 'Editing', 'edit'],
  multiedit: ['Edited', 'Editing', 'edit'],
  notebook: ['Edited', 'Editing', 'edit'],
  delete: ['Deleted', 'Deleting', 'delete'],
  patch: ['Patched', 'Patching', 'patch'],
  shell: ['Ran', 'Running', 'run'],
  grep: ['Searched for', 'Searching for', 'search for'],
  glob: ['Searched for', 'Searching for', 'search for'],
  list: ['Listed', 'Listing', 'list'],
  fetch: ['Fetched', 'Fetching', 'fetch'],
  search: ['Searched the web for', 'Searching the web for', 'search the web for'],
  agent: ['Asked a subagent', 'Asking a subagent', 'ask a subagent'],
  todo: ['Updated the plan', 'Updating the plan', 'update the plan'],
  skill: ['Used', 'Using', 'use'],
  toolsearch: ['Looked up tools', 'Looking up tools', 'look up tools'],
  monitor: ['Watched', 'Watching', 'watch'],
  mcp: ['Used', 'Using', 'use'],
  python: ['Ran Python', 'Running Python', 'run Python'],
  image: ['Made an image', 'Making an image', 'make an image'],
};

export const ICONS: Record<Kind, IconName> = {
  read: 'file',
  write: 'file',
  edit: 'edit',
  multiedit: 'edit',
  notebook: 'edit',
  delete: 'trash',
  patch: 'edit',
  shell: 'terminal',
  grep: 'search',
  glob: 'search',
  list: 'folder',
  fetch: 'globe',
  search: 'globe',
  agent: 'branch',
  todo: 'logs',
  skill: 'book',
  toolsearch: 'search',
  monitor: 'eye',
  mcp: 'link',
  python: 'play',
  image: 'image',
  other: 'zap',
};

/** The icon for a kind of step. */
export const stepIcon = (kind: Kind): IconName => ICONS[kind];

/**
 * The family a step's card says it belongs to, by its rule and icon: a
 * command (a shell, a watched process, a Python run), an MCP tool, a
 * subagent, or any other tool.
 */
export type StepFamily = 'command' | 'mcp' | 'agent' | 'tool';

export function familyOf(kind: Kind): StepFamily {
  switch (kind) {
    case 'shell':
    case 'monitor':
    case 'python':
      return 'command';
    case 'mcp':
      return 'mcp';
    case 'agent':
      return 'agent';
    default:
      return 'tool';
  }
}

/** The family in a word, for screen readers (the icon's label). */
export const FAMILY_WORD: Record<StepFamily, string> = {
  command: 'Command',
  mcp: 'MCP tool',
  agent: 'Subagent',
  tool: 'Tool',
};

export type Args = Record<string, unknown>;
export const argsOf = (call: ToolCall): Args =>
  call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? (call.args as Args) : {};
export const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** A path as a person reads it: relative to the session's folder, or short. */
export function displayPath(raw: string, cwd: string | null): string {
  let p = raw.replaceAll('\\', '/');
  // The lab reports real paths; show them relative to its folder.
  const lab = p.replace(/^.*\/labs\/[^/]+\//, '');
  if (lab !== p) return shortResource(lab.startsWith('/') ? `fs:${lab}` : `fs:/workspace/${lab}`);
  if (p.startsWith('/workspace')) return shortResource(`fs:${p}`);
  if (cwd) {
    const c = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
    if (p.toLowerCase() === c.toLowerCase()) return '.';
    if (p.toLowerCase().startsWith(`${c.toLowerCase()}/`)) return p.slice(c.length + 1);
  }
  const segs = p.split('/').filter(Boolean);
  if (segs.length > 4 && (p.startsWith('/') || /^[a-z]:/i.test(p))) p = `…/${segs.slice(-3).join('/')}`;
  return p;
}

/** Claude Code's notes to the model ride along in results; a person does not need them. */
export function stripReminders(text: string): string {
  return text.replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/g, '\n').replace(/\n+$/, '');
}

export function resultText(r: ToolResult | undefined): string {
  if (!r) return '';
  const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
  return stripReminders(raw ?? '');
}

export const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

function firstLine(text: string, max = 120): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

/** Match lines of a search result, without Claude Code's "Found 3 files" line. */
export function matchLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .filter((l) => !/^Found \d+ (files?|matches|lines?)/i.test(l))
    .filter((l) => !/^No (files|matches) found/i.test(l));
}

/** Edits from an Edit or MultiEdit call, as diff rows. */
export function editRows(kind: Kind, a: Args): DiffLine[] {
  if (kind === 'multiedit' && Array.isArray(a.edits)) {
    return a.edits.flatMap((e, i): DiffLine[] => {
      const o = (e ?? {}) as Args;
      const rows = lineDiff(String(o.old_string ?? ''), String(o.new_string ?? ''));
      return i ? [{ kind: 'fold', count: 0 }, ...rows] : rows;
    });
  }
  const before = s(a.old_string) ?? s(a.oldString) ?? '';
  const after = s(a.new_string) ?? s(a.newString) ?? s(a.new_source) ?? '';
  if (!before && !after) return [];
  return lineDiff(before, after);
}

interface Line {
  verb: string;
  target: string | null;
  /** The full value behind a shortened target (a path), for the tooltip. */
  full?: string | null;
  /** The target reads as code (a path, a command, a pattern). */
  mono: boolean;
  where?: string | null;
  meta?: string | null;
  badge?: string | null;
}

export function describe(
  call: ToolCall,
  result: ToolResult | undefined,
  state: StepState,
  cwd: string | null,
): Line {
  const kind = kindOf(call.tool);
  const a = argsOf(call);
  const v = kind === 'other' ? null : VERBS[kind];
  const verb = v
    ? state === 'ok'
      ? v[0]
      : state === 'declined'
        ? `Didn't ${v[2]}`
        : state === 'failed'
          ? `Couldn't ${v[2]}`
          : v[1]
    : call.tool;
  const text = state === 'ok' ? resultText(result) : '';
  const rawPath = s(a.file_path) ?? s(a.notebook_path) ?? s(a.path) ?? s(a.filePath);
  const path = rawPath ? displayPath(rawPath, cwd) : null;
  switch (kind) {
    case 'read': {
      const from = typeof a.offset === 'number' ? a.offset : null;
      const n = typeof a.limit === 'number' ? a.limit : null;
      const meta = from !== null && n !== null ? `lines ${from}–${from + n - 1}` : null;
      return { verb, target: path ?? 'the workspace', full: rawPath, mono: !!path, meta };
    }
    case 'write': {
      const content = s(a.content);
      return {
        verb,
        target: path ?? 'the workspace',
        full: rawPath,
        mono: !!path,
        meta: content ? `+${content.replace(/\n$/, '').split('\n').length}` : null,
      };
    }
    case 'edit':
    case 'multiedit':
    case 'notebook': {
      const st = diffStats(editRows(kind, a));
      return {
        verb,
        target: path ?? 'the workspace',
        full: rawPath,
        mono: !!path,
        meta: st.added || st.removed ? `+${st.added} −${st.removed}` : null,
      };
    }
    case 'python': {
      const code = s(a.code);
      return {
        verb,
        target: code ? firstLine(code, 80) : 'some code',
        full: code,
        mono: !!code,
        meta: runMeta(result),
      };
    }
    case 'image': {
      const prompt = s(a.prompt);
      return {
        verb,
        target: prompt ? firstLine(prompt, 80) : 'from a prompt',
        full: prompt,
        mono: false,
        meta: imageMeta(result),
      };
    }
    case 'delete':
    case 'patch':
    case 'list':
      return { verb, target: path ?? 'the workspace', full: rawPath, mono: !!path };
    case 'shell': {
      const cmd = s(a.command) ?? s(a.cmd);
      const exit = state === 'failed' ? /^Exit code (\d+)/.exec(resultText(result))?.[1] : null;
      return {
        verb,
        target: cmd ? firstLine(cmd) : 'a command',
        full: cmd,
        mono: !!cmd,
        meta: exit ? `exit ${exit}` : null,
      };
    }
    case 'grep':
    case 'glob': {
      const pattern = s(a.pattern) ?? s(a.query);
      const n = text ? matchLines(text).length : null;
      const files = kind === 'glob' || a.output_mode === undefined || a.output_mode === 'files_with_matches';
      return {
        verb,
        target: pattern ? `'${pattern}'` : 'files',
        mono: !!pattern,
        where: path,
        full: rawPath,
        meta:
          n === null
            ? null
            : n === 0
              ? 'none found'
              : plural(n, files ? 'file' : 'match', files ? 'files' : 'matches'),
      };
    }
    case 'fetch': {
      const url = s(a.url);
      return { verb, target: url ? host(url) : 'a page', full: url, mono: false };
    }
    case 'search': {
      const q = s(a.query);
      return { verb, target: q ? `'${q}'` : 'something', mono: false };
    }
    case 'agent': {
      const d = s(a.description) ?? s(a.subagent_type);
      return { verb, target: d, mono: false, badge: s(a.subagent_type) };
    }
    case 'todo': {
      const todos = Array.isArray(a.todos) ? (a.todos as Args[]) : [];
      const done = todos.filter((t) => t?.status === 'completed').length;
      return {
        verb,
        target: null,
        mono: false,
        meta: todos.length ? `${done} of ${todos.length} done` : null,
      };
    }
    case 'skill': {
      const name = s(a.skill) ?? s(a.command) ?? s(a.name);
      return { verb, target: name ? `the ${name} skill` : 'a skill', mono: false };
    }
    case 'toolsearch':
      return { verb, target: s(a.query), mono: false };
    case 'monitor':
      return { verb, target: s(a.description) ?? s(a.command) ?? 'a process', mono: false };
    case 'mcp': {
      const [, server, ...rest] = call.tool.split('__');
      return { verb, target: rest.join('__') || call.tool, mono: true, badge: server ?? null };
    }
    default: {
      const on = path ?? s(a.url) ?? s(a.command) ?? s(a.pattern);
      return { verb: on ? `${call.tool} on` : call.tool, target: on, mono: !!on };
    }
  }
}

/** One line of text for a step: "Read src/app.ts". */
export function oneLiner(l: Line): string {
  return [l.verb, l.target, l.where ? `in ${l.where}` : null].filter(Boolean).join(' ');
}

export function stepState(result: ToolResult | undefined, waiting: boolean): StepState {
  if (!result) return waiting ? 'waiting' : 'running';
  if (result.declined_reason !== undefined) return 'declined';
  return result.ok ? 'ok' : 'failed';
}

/** A shell started in the background: its launch is not its end. Activity says how it is doing. */
export function backgroundShellState(base: StepState, shell: ActivityState | 'gone' | null): StepState {
  if (base !== 'ok') return base;
  if (shell === 'finished' || shell === 'stopped' || shell === 'gone') return 'ok';
  if (shell === 'failed') return 'failed';
  return 'running';
}

export const isBackgroundShell = (call: ToolCall) =>
  kindOf(call.tool) === 'shell' && (call.args as { run_in_background?: unknown })?.run_in_background === true;

/* ---- What came back, in one line ------------------------------------------- */

/** How much of a result's text is read for its one line: only its head, however long it is. */
const HEAD_CHARS = 4000;
const LINE_CHARS = 90;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  // CSI (colours, cursor moves) and OSC (titles, links) sequences.
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`,
  'g',
);
/** Box drawing and block elements (U+2500 to U+259F) and braille spinners (U+2800 to U+28FF):
 *  frames a terminal draws, not words. */
const FRAME = /[─-▟⠀-⣿]+/g;
/** A rule drawn with text: three or more of the same ASCII dash, equals, underscore, star,
 *  tilde or hash, or two or more typographic dashes (words never run two em dashes together). */
const RULE = /([-=_*~#])\1{2,}|[‐-―−]{2,}/g;

/**
 * One line of command output as plain words: colour codes, control
 * characters, box drawing and text rules out, runs of space as one, and
 * what is left of a frame (a table's bars) off the ends.
 */
export function plainLine(line: string): string {
  let out = '';
  for (const ch of line.replace(ANSI, '')) out += ch < ' ' || ch === '\u007f' ? ' ' : ch;
  return out
    .replace(FRAME, ' ')
    .replace(RULE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s|]+|[\s|]+$/g, '')
    .trim();
}

/** The first line with words in it, plain and short. `prose` drops markdown's marks. */
export function oneLine(text: string, prose = false): string | null {
  for (const raw of text.slice(0, HEAD_CHARS).split('\n')) {
    let line = plainLine(raw);
    if (prose)
      line = line
        .replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
        .replace(/(\*\*|__|`)/g, '')
        .trim();
    if (!line || /^```/.test(line)) continue;
    return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line;
  }
  return null;
}

/** Lines in a text, without splitting it. */
function lineCount(text: string): number {
  const t = text.replace(/\n+$/, '');
  if (!t) return 0;
  let n = 1;
  for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) n++;
  return n;
}

const isTextBlock = (b: unknown): b is { type: 'text'; text: string } =>
  !!b && typeof b === 'object' && (b as Args).type === 'text' && typeof (b as Args).text === 'string';

/**
 * A structured result in a line: an MCP tool's text blocks read as their
 * text, a list as its count, an object as its first two plain fields
 * ("number: 42 · url: https://…"), text as its first line.
 */
export function valueLine(v: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (typeof v === 'string') {
    const t = stripReminders(v).trim();
    if (!t) return null;
    if (/^[[{]/.test(t) && t.length <= 200_000)
      try {
        return valueLine(JSON.parse(t), depth + 1);
      } catch {
        /* not JSON: read it as text */
      }
    return oneLine(t);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length && v.every(isTextBlock)) return valueLine(v.map((b) => b.text).join('\n'), depth + 1);
    return v.length ? plural(v.length, 'item') : 'Nothing came back';
  }
  if (v && typeof v === 'object') {
    const o = v as Args;
    if (isTextBlock(o)) return valueLine(o.text, depth + 1);
    if (Array.isArray(o.content) && o.content.length && o.content.every(isTextBlock))
      return valueLine(o.content, depth + 1);
    const keys = Object.keys(o);
    if (!keys.length) return null;
    const plain = keys.filter((k) => ['string', 'number', 'boolean'].includes(typeof o[k])).slice(0, 2);
    if (!plain.length) return plural(keys.length, 'field');
    return oneLine(plain.map((k) => `${k}: ${String(o[k]).slice(0, 48)}`).join(' · '));
  }
  return null;
}

/** A shell's output without Claude Code's "Exit code N" line in front. */
const shellOutput = (text: string) => text.replace(/^Exit code \d+\n?/, '');

/**
 * What came back from a finished step, in one short, safe line: lines read,
 * entries listed, results found, the first line a command printed, an MCP
 * tool's first fields. Never the result itself. Null where the step's own
 * line already says it (an edit's +/−, matches found, the plan's progress)
 * or where nothing short would help.
 */
export function resultLine(call: ToolCall, result: ToolResult | undefined, state: StepState): string | null {
  if (!result || result.declined_reason !== undefined) return null;
  const kind = kindOf(call.tool);
  if (state === 'failed') {
    const text = resultText(result);
    return oneLine(kind === 'shell' ? shellOutput(text) : text);
  }
  if (state !== 'ok') return null;
  const a = argsOf(call);
  const raw = result.result;
  switch (kind) {
    case 'read': {
      if (typeof raw !== 'string') return null;
      const n = lineCount(stripReminders(raw));
      if (!n) return 'Empty file';
      // "lines 10–29" on the line already says how much was read.
      return typeof a.offset === 'number' && typeof a.limit === 'number' ? null : plural(n, 'line');
    }
    case 'list': {
      if (Array.isArray(raw)) return raw.length ? plural(raw.length, 'entry', 'entries') : 'Empty';
      const n = typeof raw === 'string' ? matchLines(stripReminders(raw)).length : null;
      return n === null ? valueLine(raw) : n ? plural(n, 'entry', 'entries') : 'Empty';
    }
    case 'shell':
      return oneLine(shellOutput(resultText(result))) ?? 'No output';
    case 'search': {
      const n = webHits(raw).length;
      return n ? plural(n, 'result') : null;
    }
    case 'fetch':
    case 'agent':
      return oneLine(resultText(result), true);
    case 'delete':
    case 'patch':
    case 'monitor':
      return oneLine(resultText(result));
    case 'mcp':
    case 'other':
      return valueLine(raw);
    default:
      return null;
  }
}

/* ---- Pieces ---------------------------------------------------------------- */

/** Long results (a whole file, a long log) start short, with the rest one click away. */
export const RESULT_LINES = 24;
const RESULT_CHARS = 2400;

export function ResultText({ text, variant }: { text: string; variant?: 'terminal' }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > RESULT_LINES || text.length > RESULT_CHARS;
  const cls = variant === 'terminal' ? 'tstep__out' : undefined;
  if (!long || all) return <pre className={cls}>{text}</pre>;
  const head = lines.slice(0, RESULT_LINES).join('\n').slice(0, RESULT_CHARS);
  return (
    <>
      <pre className={cls} data-clipped>
        {head}
      </pre>
      <button type="button" className="link-btn tool-step__more" onClick={() => setAll(true)}>
        Show all {lines.length.toLocaleString('en-GB')} lines
      </button>
    </>
  );
}

/** Markdown for tool output and subagent reports: same look as an answer. */
export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <Markdown
      className={className ? `md ${className}` : 'md'}
      mode="static"
      controls={false}
      components={MD_COMPONENTS}
      plugins="remark"
    >
      {text}
    </Markdown>
  );
}

/** Long prose folded to a few lines, with the rest one click away. */
export function Clamped({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.split('\n').length > 14 || text.length > 1400;
  return (
    <div className="tstep__clamp" data-clipped={(long && !all) || undefined}>
      <Prose text={text} />
      {long ? (
        <button type="button" className="link-btn tool-step__more" onClick={() => setAll((x) => !x)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A folded section draws its body only once it has been opened: a long
 * thread holds thousands of folded tool results, and highlighting them all
 * up front is most of what made it slow. Returns whether to draw the body
 * and the details' onToggle.
 */
export function useOpened(open: boolean): [boolean, (e: SyntheticEvent<HTMLDetailsElement>) => void] {
  const [seen, setSeen] = useState(open);
  return [seen || open, (e) => e.currentTarget.open && setSeen(true)];
}

export function Sub({ label, children, open }: { label: string; children: ReactNode; open?: boolean }) {
  const [shown, onToggle] = useOpened(!!open);
  return (
    <details className="tstep__sub" open={open || undefined} onToggle={onToggle}>
      <summary>
        <Icon name="chevronRight" size={11} />
        {label}
      </summary>
      <div className="tstep__subbody">{shown ? children : null}</div>
    </details>
  );
}

/** A Claude Code subagent's own conversation, folded away. */
export function SubagentConversation({ s: sub }: { s: SubagentView }) {
  const [shown, onToggle] = useOpened(false);
  if (!sub.turns.length) return null;
  return (
    <details className="subagent" onToggle={onToggle}>
      <summary>
        <Icon name="chevronRight" size={11} />
        Subagent conversation
        {sub.title ? <span className="subagent__title">{sub.title}</span> : null}
        <span className="subagent__count" data-num>
          {plural(sub.turns.length, 'turn')}
        </span>
      </summary>
      <ol className="subagent__turns">
        {(shown ? sub.turns : []).map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: turns are positional
          <li key={i} data-role={t.role}>
            <span className="subagent__who">{t.role === 'user' ? 'Asked' : 'Answered'}</span>
            {t.role === 'user' ? <p>{t.text}</p> : <Prose text={t.text} />}
          </li>
        ))}
      </ol>
    </details>
  );
}

export const STATUS_ICON: Record<StepState, IconName> = {
  ok: 'check',
  waiting: 'shield',
  running: 'dot',
  failed: 'warn',
  declined: 'warn',
};

export const STATUS_WORD: Record<StepState, string> = {
  ok: 'Done',
  waiting: 'Waiting for your decision',
  running: 'Running',
  failed: 'Failed',
  declined: 'Declined',
};

/** Seconds as a person reads them: "3s", "1m 27s", "1h 4m". */
export function elapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A finished step's time: "<0.1s", "0.4s", "3.2s", then "12s", "1m 27s". */
export function took(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 100) return '<0.1s';
  const tenths = Math.round(ms / 100);
  return tenths < 100 ? `${(tenths / 10).toFixed(1)}s` : elapsed(Math.round(ms / 1000) * 1000);
}

/* One clock for every live timer on screen: a single interval, however many
   steps are running, stopped when nothing is watching. Only the timers' own
   text re-renders on a tick, never the steps around them. */
const watchers = new Set<(now: number) => void>();
let tick: ReturnType<typeof setInterval> | null = null;

function watchClock(fn: (now: number) => void): () => void {
  watchers.add(fn);
  tick ??= setInterval(() => {
    const now = Date.now();
    for (const w of watchers) w(now);
  }, 1000);
  return () => {
    watchers.delete(fn);
    if (watchers.size || !tick) return;
    clearInterval(tick);
    tick = null;
  };
}

/** The time now, moving once a second while `active`, on the shared clock. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return watchClock(setNow);
  }, [active]);
  return now;
}

/** Seconds since a server time, ticking. Null when the time is not one. */
export function Since({ start, className, label }: { start: string; className?: string; label?: string }) {
  const now = useNow(true);
  const t = Date.parse(start);
  if (!Number.isFinite(t)) return null;
  return (
    <span className={className} data-num>
      {label ? <span className="sr-only">{label} </span> : null}
      {elapsed(now - t)}
    </span>
  );
}

/**
 * What a step card shows while the card code (ToolStepCards.tsx) loads: the same
 * closed row, with the step's own words, so a folded step does not move.
 */
export function ToolStepPlaceholder({
  call,
  result,
  waiting,
}: {
  call: ToolCall;
  result: ToolResult | undefined;
  waiting: boolean;
}) {
  const cwd = useContext(ToolCwd);
  const state = stepState(result, waiting);
  const line = describe(call, result, state, cwd);
  const kind = kindOf(call.tool);
  const own = stepDescription(call.tool, call.args);
  return (
    <details
      className="tool-step"
      data-call-id={call.call_id}
      data-state={state}
      data-kind={kind}
      data-family={familyOf(kind)}
      data-described={own ? true : undefined}
      aria-busy="true"
    >
      <summary>
        <Icon name={ICONS[kind]} size={13} className="tool-step__icon" label={FAMILY_WORD[familyOf(kind)]} />
        <span className="tool-step__text">
          <span className="tool-step__label">
            {own ? (
              <span className="tool-step__title">{own}</span>
            ) : (
              <>
                <span className="tool-step__verb">{line.verb}</span>{' '}
                {line.target ? (
                  <span className="tool-step__target" data-mono={line.mono || undefined}>
                    {line.target}
                  </span>
                ) : null}
              </>
            )}
          </span>
        </span>
        <span className="tool-step__status" title={STATUS_WORD[state]}>
          <Icon name={STATUS_ICON[state]} size={12} />
          <span className="sr-only">{STATUS_WORD[state]}</span>
        </span>
      </summary>
    </details>
  );
}

/** Steps in one run before they fold into "Worked through N steps". */
export const GROUP_AFTER = 4;

export function ToolGroup({
  steps,
  open,
  children,
}: {
  steps: { call: ToolCall; result: ToolResult | undefined }[];
  /** Open from the start (a step in it waits on you). */
  open: boolean;
  children: ReactNode;
}) {
  const cwd = useContext(ToolCwd);
  const live = steps.some((st) => !st.result);
  const failed = steps.filter((st) => st.result && !st.result.ok).length;
  const agents = steps.every((st) => kindOf(st.call.tool) === 'agent');
  const last = steps[steps.length - 1];
  const lastLine = last
    ? (stepDescription(last.call.tool, last.call.args) ??
      oneLiner(describe(last.call, last.result, stepState(last.result, false), cwd)))
    : '';
  const n = steps.length;
  const title = agents
    ? `${live ? 'Asking' : 'Asked'} ${n} subagents`
    : `${live ? 'Working through' : 'Worked through'} ${n} steps`;
  const [shown, onToggle] = useOpened(open);
  return (
    <details
      className="tool-group"
      data-live={live || undefined}
      open={open || undefined}
      onToggle={onToggle}
    >
      <summary>
        <Icon name="chevronRight" size={12} className="tool-group__chev" />
        <span className="tool-group__title">{title}</span>
        {failed ? (
          <span className="tool-group__failed" data-num>
            {failed} failed
          </span>
        ) : null}
        <span className="tool-group__last">{lastLine}</span>
      </summary>
      <div className="tool-group__steps">{shown ? children : null}</div>
    </details>
  );
}
