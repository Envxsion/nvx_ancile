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
 *           |  A live step counts its seconds; an opened step always
 *           |  shows its input and its result, or why there is none.
 *  Note     |  Paths are shown relative to the session's folder
 *           |  (ToolCwd), with the full path in the tooltip.
 * ------------------------------------------------------------------
 */

import {
  type ActivityState,
  type Part,
  stepCommand,
  stepDescription,
  type ToolKind,
  toolKind,
  type WebHit,
  webHits,
} from '@nvx/contracts';
import {
  createContext,
  type ReactNode,
  type SyntheticEvent,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Streamdown } from 'streamdown';
import { useBackgroundShell } from '../activity/api';
import { AutoRanBadge } from '../auto/AutoCards';
import { OpenInEditor } from '../code/OpenInEditor';
import { ImageGenBody, imageMeta } from '../images/ImageGenBody';
import { PythonBody, runMeta } from '../interpreter/PythonBody';
import { langOfPath } from '../lib/highlight';
import { shortResource } from '../lib/mappers';
import type { StepClock } from '../lib/run';
import type { SubagentView } from '../lib/types';
import { DiffView } from '../memory/DiffView';
import { type DiffLine, diffStats, lineDiff } from '../memory/linediff';
import { useUi } from '../state/ui';
import { Icon, type IconName } from '../ui/Icon';
import { MD_COMPONENTS } from './Citations';
import { CodeBlock, CopyCode } from './Code';
import { REMARK_PLUGINS } from './mdPlugins';
import '../styles/tools.css';

export type ToolCall = Extract<Part, { type: 'tool_call' }>;
export type ToolResult = Extract<Part, { type: 'tool_result' }>;
export type StepState = 'running' | 'waiting' | 'ok' | 'failed' | 'declined';

/** The folder a Claude Code session ran in, so paths read relative to it. */
export const ToolCwd = createContext<string | null>(null);

/* ---- Words ----------------------------------------------------------------- */

type Kind = ToolKind;

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

const ICONS: Record<Kind, IconName> = {
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

type Args = Record<string, unknown>;
const argsOf = (call: ToolCall): Args =>
  call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? (call.args as Args) : {};
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

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

function resultText(r: ToolResult | undefined): string {
  if (!r) return '';
  const raw = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
  return stripReminders(raw ?? '');
}

const host = (url: string): string => {
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
function matchLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .filter((l) => !/^Found \d+ (files?|matches|lines?)/i.test(l))
    .filter((l) => !/^No (files|matches) found/i.test(l));
}

/** Edits from an Edit or MultiEdit call, as diff rows. */
function editRows(kind: Kind, a: Args): DiffLine[] {
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

const isBackgroundShell = (call: ToolCall) =>
  kindOf(call.tool) === 'shell' && (call.args as { run_in_background?: unknown })?.run_in_background === true;

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
    <Streamdown
      className={className ? `md ${className}` : 'md'}
      mode="static"
      controls={false}
      components={MD_COMPONENTS}
      remarkPlugins={REMARK_PLUGINS}
    >
      {text}
    </Streamdown>
  );
}

/** Long prose folded to a few lines, with the rest one click away. */
function Clamped({ text }: { text: string }) {
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

function Sub({ label, children, open }: { label: string; children: ReactNode; open?: boolean }) {
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

/** Claude Code's Read output ("     1→text") as code and the numbers beside it. */
export function stripGutter(text: string): { code: string; numbers: number[] | null } {
  const lines = text.replace(/\n$/, '').split('\n');
  const re = /^\s*(\d+)(?:→|\t)(.*)$/;
  const hits = lines.map((l) => re.exec(l));
  const filled = lines.filter((l) => l.trim()).length;
  const matched = hits.filter(Boolean).length;
  if (!matched || matched < filled * 0.8) return { code: text, numbers: null };
  const numbers: number[] = [];
  const code: string[] = [];
  let prev = 0;
  hits.forEach((m, i) => {
    if (m) {
      prev = Number(m[1]);
      numbers.push(prev);
      code.push(m[2] ?? '');
    } else {
      numbers.push(prev);
      code.push(lines[i] ?? '');
    }
  });
  return { code: code.join('\n'), numbers };
}

function Failure({ result }: { result: ToolResult }) {
  const text = resultText(result) || result.declined_reason || '';
  if (!text) return null;
  return (
    <div className="tstep__fail">
      <ResultText text={text} />
    </div>
  );
}

/** The file a Read, Edit or Write step is about. */
const stepPath = (a: Args): string | null =>
  s(a.file_path) ?? s(a.path) ?? s(a.filePath) ?? s(a.notebook_path);

function ReadBody({ a, result }: { a: Args; result: ToolResult | undefined }) {
  const cwd = useContext(ToolCwd);
  const text = resultText(result);
  const { code, numbers } = useMemo(() => stripGutter(text), [text]);
  if (!result) return null;
  if (!result.ok) return <Failure result={result} />;
  if (!text.trim()) return <p className="tstep__note">The file is empty.</p>;
  const path = s(a.file_path) ?? s(a.path) ?? s(a.filePath);
  return (
    <>
      <CodeBlock code={code} lang={langOfPath(path)} numbers={numbers ?? true} />
      <OpenInEditor path={path} cwd={cwd} />
    </>
  );
}

function EditBody({ kind, a, result }: { kind: Kind; a: Args; result: ToolResult | undefined }) {
  const rows = useMemo(() => editRows(kind, a), [kind, a]);
  const cwd = useContext(ToolCwd);
  return (
    <>
      {a.replace_all === true ? <p className="tstep__note">Every occurrence</p> : null}
      {rows.length ? (
        <DiffView rows={rows} label="What changed" numbered={false} />
      ) : (
        <p className="tstep__note">No changes recorded.</p>
      )}
      {result && !result.ok ? <Failure result={result} /> : null}
      <OpenInEditor path={stepPath(a)} cwd={cwd} tool={kind} args={a} />
    </>
  );
}

const WRITE_LINES = 40;

function WriteBody({ a, result }: { a: Args; result: ToolResult | undefined }) {
  const [all, setAll] = useState(false);
  const cwd = useContext(ToolCwd);
  const content = (s(a.content) ?? '').replace(/\n$/, '');
  const lines = content ? content.split('\n') : [];
  const rows: DiffLine[] = (all ? lines : lines.slice(0, WRITE_LINES)).map((text, i) => ({
    kind: 'add',
    text,
    b: i + 1,
  }));
  return (
    <>
      {rows.length ? (
        <DiffView rows={rows} label="What was written" numbered={false} />
      ) : (
        <p className="tstep__note">An empty file.</p>
      )}
      {lines.length > WRITE_LINES ? (
        <button type="button" className="link-btn tool-step__more" onClick={() => setAll((x) => !x)}>
          {all ? 'Show less' : `Show all ${lines.length.toLocaleString('en-GB')} lines`}
        </button>
      ) : null}
      {result && !result.ok ? <Failure result={result} /> : null}
      <OpenInEditor path={stepPath(a)} cwd={cwd} tool="write" args={a} />
    </>
  );
}

function ShellBody({
  tool,
  a,
  result,
  waiting = false,
}: {
  tool: string;
  a: Args;
  result: ToolResult | undefined;
  waiting?: boolean;
}) {
  const cmd = s(a.command) ?? s(a.cmd) ?? '';
  const ps = tool.toLowerCase() === 'powershell';
  let out = resultText(result);
  const exit = /^Exit code (\d+)\n?/.exec(out);
  if (exit) out = out.slice(exit[0].length);
  return (
    <div className="term" data-failed={(result && !result.ok) || undefined}>
      <div className="term__head">
        <span className="term__shell">{ps ? 'PowerShell' : 'Shell'}</span>
        {s(a.description) ? <span className="term__desc">{s(a.description)}</span> : null}
        {exit ? <span className="term__exit">Exit code {exit[1]}</span> : null}
        {a.run_in_background === true ? <span className="term__exit">In the background</span> : null}
        <CopyCode text={cmd} label="Copy command" />
      </div>
      <pre className="term__cmd">
        <span className="term__prompt" aria-hidden="true">
          {ps ? '>' : '$'}
        </span>
        {cmd}
      </pre>
      {result ? (
        out.trim() ? (
          <ResultText text={out} variant="terminal" />
        ) : (
          <p className="term__quiet">No output</p>
        )
      ) : (
        <p className="term__quiet">{waiting ? 'Waiting for your decision' : 'No output yet'}</p>
      )}
    </div>
  );
}

const MATCH_ROWS = 20;

function MatchesBody({ result, cwd }: { result: ToolResult | undefined; cwd: string | null }) {
  const [all, setAll] = useState(false);
  if (!result) return null;
  if (!result.ok) return <Failure result={result} />;
  const lines = matchLines(resultText(result));
  if (!lines.length) return <p className="tstep__note">Nothing matched.</p>;
  const shown = all ? lines : lines.slice(0, MATCH_ROWS);
  return (
    <>
      <ul className="matches">
        {shown.map((l, i) => {
          const m = /^(.+?):(\d+)[:-](.*)$/.exec(l);
          const key = `${i}-${l.slice(0, 24)}`;
          if (m)
            return (
              <li key={key} data-kind="line">
                <span className="matches__file" title={m[1]}>
                  {displayPath(m[1] as string, cwd)}
                </span>
                <span className="matches__no" data-num>
                  {m[2]}
                </span>
                <span className="matches__text">{(m[3] as string).trim()}</span>
              </li>
            );
          const isPath = /[\\/]/.test(l) && !/\s{2,}/.test(l);
          return (
            <li key={key} data-kind={isPath ? 'file' : 'text'}>
              {isPath ? <Icon name="file" size={12} /> : null}
              <span className={isPath ? 'matches__file' : 'matches__text'} title={isPath ? l : undefined}>
                {isPath ? displayPath(l.trim(), cwd) : l}
              </span>
            </li>
          );
        })}
      </ul>
      {lines.length > MATCH_ROWS ? (
        <button type="button" className="link-btn tool-step__more" onClick={() => setAll((x) => !x)}>
          {all ? 'Show less' : `Show all ${lines.length.toLocaleString('en-GB')}`}
        </button>
      ) : null}
    </>
  );
}

function safeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function LinkChip({ url, title }: { url: string; title?: string | null }) {
  const href = safeUrl(url);
  if (!href) return null;
  const u = new URL(href);
  return (
    <a className="link-chip" href={href} target="_blank" rel="noopener noreferrer" title={href}>
      <Icon name="globe" size={11} />
      <span className="link-chip__text">
        {title || `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`}
      </span>
      <Icon name="ext" size={10} />
    </a>
  );
}

/** The words of a search result once its header and its list of links are taken out. */
function searchProse(text: string): string {
  const t = text.trim();
  if (/^[[{]/.test(t))
    try {
      JSON.parse(t);
      return '';
    } catch {
      /* not JSON: read it as text */
    }
  return t
    .replace(/^Web search results for query:.*$/m, '')
    .replace(/^Links:\s*\[.*\]\s*$/m, '')
    .split('\n')
    .filter((l) => !/^\{"(title|type)":/.test(l.trim()))
    .join('\n')
    .trim();
}

function SearchHits({ hits }: { hits: WebHit[] }) {
  return (
    <ul className="web-hits" aria-label="Search results">
      {hits.map((h) => {
        const href = safeUrl(h.url);
        if (!href) return null;
        return (
          <li key={h.url}>
            <a href={href} target="_blank" rel="noopener noreferrer" title={href}>
              {h.title ?? host(href)}
            </a>
            <span className="web-hits__host">{host(href)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function WebBody({ kind, a, result }: { kind: Kind; a: Args; result: ToolResult | undefined }) {
  const [raw, setRaw] = useState(false);
  const text = resultText(result);
  const url = s(a.url);
  const query = s(a.query);
  const hits = kind === 'search' && result?.ok ? webHits(result.result) : [];
  const prose = kind === 'search' ? searchProse(text) : text;
  return (
    <>
      {query ? (
        <p className="tstep__note">
          Query: <span data-mono>{query}</span>
        </p>
      ) : null}
      {url ? (
        <div className="link-chips">
          <LinkChip url={url} />
        </div>
      ) : null}
      {s(a.prompt) ? <p className="tstep__note">Asked: {s(a.prompt)}</p> : null}
      {result && !result.ok ? (
        <Failure result={result} />
      ) : result && raw ? (
        <ResultText text={text || '(empty)'} />
      ) : (
        <>
          {hits.length ? <SearchHits hits={hits} /> : null}
          {result && kind === 'search' && !hits.length && !prose ? (
            <p className="tstep__note">No results came back.</p>
          ) : null}
          {prose ? (
            <Sub label="What came back">
              <Clamped text={prose} />
            </Sub>
          ) : null}
        </>
      )}
      {result?.ok && kind === 'search' ? (
        <button type="button" className="link-btn tool-step__more" onClick={() => setRaw((x) => !x)}>
          {raw ? 'Show the list' : 'Show raw'}
        </button>
      ) : null}
    </>
  );
}

const TODO_WORDS: Record<string, string> = {
  completed: 'Done',
  in_progress: 'In progress',
  pending: 'To do',
};

function TodoBody({ a }: { a: Args }) {
  const todos = Array.isArray(a.todos) ? (a.todos as Args[]) : [];
  if (!todos.length) return <p className="tstep__note">The plan is empty.</p>;
  return (
    <ul className="todo" aria-label="Plan">
      {todos.map((t, i) => {
        const status = s(t?.status) ?? 'pending';
        const text = s(t?.content) ?? s(t?.activeForm) ?? '';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the plan is positional
          <li key={i} data-status={status}>
            <span className="todo__box" aria-hidden="true">
              {status === 'completed' ? <Icon name="check" size={11} /> : null}
            </span>
            <span className="sr-only">{TODO_WORDS[status] ?? status}: </span>
            <span className="todo__text">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function AgentBody({
  a,
  result,
  subagent,
}: {
  a: Args;
  result: ToolResult | undefined;
  subagent?: SubagentView | undefined;
}) {
  const prompt = s(a.prompt);
  const report = resultText(result);
  return (
    <>
      {prompt ? (
        <Sub label="What it was asked">
          <Clamped text={prompt} />
        </Sub>
      ) : null}
      {result && !result.ok ? (
        <Failure result={result} />
      ) : report ? (
        <div className="tstep__report">
          <div className="tool-step__k">What it reported</div>
          <Clamped text={report} />
        </div>
      ) : null}
      {subagent ? <SubagentConversation s={subagent} /> : null}
    </>
  );
}

function pretty(v: unknown): { text: string; json: boolean } {
  if (typeof v === 'string') {
    const t = stripReminders(v);
    try {
      const parsed: unknown = JSON.parse(t);
      if (parsed && typeof parsed === 'object') return { text: JSON.stringify(parsed, null, 2), json: true };
    } catch {
      /* not JSON */
    }
    return { text: t, json: false };
  }
  return { text: JSON.stringify(v, null, 2) ?? '', json: true };
}

function McpBody({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  const args = JSON.stringify(call.args ?? {}, null, 2);
  const r = result ? pretty(result.result) : null;
  return (
    <>
      {args !== '{}' ? <CodeBlock code={args} lang="json" title="Input" clamp={16} /> : null}
      {r && result ? (
        result.ok ? (
          r.json ? (
            <CodeBlock code={r.text} lang="json" title="Result" />
          ) : (
            <>
              <div className="tool-step__k">Result</div>
              <ResultText text={r.text} />
            </>
          )
        ) : (
          <Failure result={result} />
        )
      ) : null}
    </>
  );
}

function GenericBody({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  return (
    <>
      <div className="tool-step__k">Input</div>
      <pre data-num>{JSON.stringify(call.args, null, 2)}</pre>
      {result ? (
        <>
          <div className="tool-step__k">{result.ok ? 'Result' : 'What happened'}</div>
          <ResultText text={resultText(result)} />
        </>
      ) : null}
    </>
  );
}

/**
 * The lab's own lower-case tools keep the plain Input and Result view their
 * results were written for, except the ones read the same way everywhere
 * (a shell, an edit, a search, a web page).
 */
function plainView(tool: string, kind: Kind): boolean {
  const lab = tool === tool.toLowerCase() && kind !== 'mcp';
  return lab && !['shell', 'edit', 'grep', 'glob', 'search', 'fetch'].includes(kind);
}

function Body({
  call,
  result,
  subagent,
  cwd,
  waiting,
}: {
  call: ToolCall;
  result: ToolResult | undefined;
  subagent?: SubagentView | undefined;
  cwd: string | null;
  waiting: boolean;
}) {
  const kind = kindOf(call.tool);
  const a = argsOf(call);
  // The lab's own tools keep the plain view their results were written for.
  if (kind === 'python') return <PythonBody call={call} result={result} />;
  if (kind === 'image') return <ImageGenBody call={call} result={result} />;
  if (plainView(call.tool, kind)) return <GenericBody call={call} result={result} />;
  switch (kind) {
    case 'read':
      return <ReadBody a={a} result={result} />;
    case 'edit':
    case 'multiedit':
    case 'notebook':
      return <EditBody kind={kind} a={a} result={result} />;
    case 'write':
      return <WriteBody a={a} result={result} />;
    case 'shell':
      return <ShellBody tool={call.tool} a={a} result={result} waiting={waiting} />;
    case 'grep':
    case 'glob':
    case 'list':
      return <MatchesBody result={result} cwd={cwd} />;
    case 'fetch':
    case 'search':
      return <WebBody kind={kind} a={a} result={result} />;
    case 'todo':
      return <TodoBody a={a} />;
    case 'agent':
      return <AgentBody a={a} result={result} subagent={subagent} />;
    case 'mcp':
      return <McpBody call={call} result={result} />;
    default:
      return (
        <>
          <GenericBody call={call} result={result} />
          {subagent ? <SubagentConversation s={subagent} /> : null}
        </>
      );
  }
}

const STATUS_ICON: Record<StepState, IconName> = {
  ok: 'check',
  waiting: 'shield',
  running: 'dot',
  failed: 'warn',
  declined: 'warn',
};

const STATUS_WORD: Record<StepState, string> = {
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

/** The time now, moving once a second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** A live step's seconds: counting while it runs, its duration once it is done. */
function StepTimer({ clock, running }: { clock: StepClock; running: boolean }) {
  const now = useNow(running && !clock.end);
  const start = Date.parse(clock.start);
  const end = clock.end ? Date.parse(clock.end) : now;
  if (!Number.isFinite(start)) return null;
  return (
    <span className="tool-step__time" data-num title={running ? 'Running for' : 'Took'}>
      {elapsed(end - start)}
    </span>
  );
}

/** Steps whose body shows nothing of the input until the result is in: they show it meanwhile. */
const INPUT_WHILE_PENDING = new Set<Kind>([
  'read',
  'grep',
  'glob',
  'list',
  'skill',
  'toolsearch',
  'monitor',
  'delete',
  'patch',
]);

/** What an opened step without a result says, with its input where the body would not show it. */
function Pending({
  call,
  kind,
  state,
  live,
}: {
  call: ToolCall;
  kind: Kind;
  state: StepState;
  live: boolean;
}) {
  const args = JSON.stringify(call.args ?? {}, null, 2);
  const word =
    state === 'waiting'
      ? 'Waiting for your decision.'
      : live
        ? 'No result yet.'
        : 'No result was recorded for this step.';
  return (
    <>
      {INPUT_WHILE_PENDING.has(kind) && !plainView(call.tool, kind) && args !== '{}' ? (
        <CodeBlock code={args} lang="json" title="Input" clamp={16} />
      ) : null}
      {kind === 'shell' ? null : <p className="tstep__note tstep__pending">{word}</p>}
    </>
  );
}

interface ToolStepProps {
  call: ToolCall;
  result: ToolResult | undefined;
  waiting: boolean;
  /** The approval this step waits on: its "Waiting for your decision" opens exactly that one. */
  approvalId?: string | null;
  subagent?: SubagentView | undefined;
  /** Settings → Reading: tool steps start as one line. */
  folded: boolean;
  /** When the step started and ended, while its answer is being written. */
  clock?: StepClock | undefined;
  /** The answer is still being written. */
  live?: boolean;
}

export function ToolStep(props: ToolStepProps) {
  return isBackgroundShell(props.call) && props.result?.ok ? (
    <BackgroundShellStep {...props} />
  ) : (
    <ToolStepView {...props} shell={undefined} />
  );
}

/** A background shell's step, with its state from Activity. */
function BackgroundShellStep(props: ToolStepProps) {
  const shell = useBackgroundShell(props.call.call_id, true);
  return <ToolStepView {...props} shell={shell} />;
}

function ToolStepView({
  call,
  result,
  waiting,
  folded,
  subagent,
  clock,
  live = false,
  shell,
  approvalId = null,
}: ToolStepProps & { shell: ActivityState | 'gone' | null | undefined }) {
  const cwd = useContext(ToolCwd);
  const background = shell !== undefined;
  const state = background
    ? backgroundShellState(stepState(result, waiting), shell)
    : stepState(result, waiting);
  const line = describe(call, result, state, cwd);
  const kind = kindOf(call.tool);
  // The call's own words ("Reading the data models") lead; what it ran sits under them.
  const own = stepDescription(call.tool, call.args);
  const under = own ? (stepCommand(call.tool, call.args) ?? oneLiner(line)) : null;
  const detail =
    background && state === 'running'
      ? 'Running in the background'
      : state === 'waiting'
        ? 'Waiting for your decision'
        : state === 'declined'
          ? result?.declined_reason || null
          : state === 'failed' && kind !== 'shell'
            ? firstLine(resultText(result), 90) || null
            : null;
  // A Python run is read for its output and figures: it stays open whatever the setting.
  const openByDefault = !folded || state === 'waiting' || kind === 'python' || kind === 'image';
  const [shown, onToggle] = useOpened(openByDefault);
  return (
    <details
      className="tool-step"
      data-state={state}
      data-kind={kind}
      data-described={own ? true : undefined}
      open={openByDefault || undefined}
      onToggle={onToggle}
    >
      <summary title={line.full ?? under ?? undefined}>
        <Icon name={ICONS[kind]} size={13} className="tool-step__icon" />
        <span className="tool-step__text">
          {own ? (
            <span className="tool-step__label">
              <span className="tool-step__title">{own}</span>
              {line.badge ? <span className="tool-step__badge">{line.badge}</span> : null}
            </span>
          ) : (
            <span className="tool-step__label">
              <span className="tool-step__verb">{line.verb}</span>{' '}
              {line.badge ? <span className="tool-step__badge">{line.badge}</span> : null}{' '}
              {line.target ? (
                <span className="tool-step__target" data-mono={line.mono || undefined}>
                  {line.target}
                </span>
              ) : null}{' '}
              {line.where ? (
                <span className="tool-step__where">
                  in <span data-mono>{line.where}</span>
                </span>
              ) : null}
            </span>
          )}
          {under ? (
            <span className="tool-step__cmd" data-mono={kind === 'shell' || kind === 'monitor' || undefined}>
              {under}
            </span>
          ) : null}
        </span>
        {state === 'waiting' && approvalId ? (
          <span className="tool-step__detail">
            <button
              type="button"
              className="link-btn tool-step__ask"
              onClick={(e) => {
                // Open the decision, not the step.
                e.preventDefault();
                e.stopPropagation();
                useUi.getState().setApproval(true, approvalId);
              }}
            >
              Waiting for your decision
            </button>
          </span>
        ) : detail ? (
          <span className="tool-step__detail">{detail}</span>
        ) : null}
        {line.meta ? (
          <span className="tool-step__meta" data-num>
            {line.meta}
          </span>
        ) : null}
        {clock ? <StepTimer clock={clock} running={!result && live} /> : null}
        <AutoRanBadge callId={call.call_id} />
        <span className="tool-step__status" title={STATUS_WORD[state]}>
          <Icon name={STATUS_ICON[state]} size={12} />
          <span className="sr-only">{STATUS_WORD[state]}</span>
        </span>
      </summary>
      <div className="tool-step__body">
        {shown ? (
          <>
            <Body call={call} result={result} subagent={subagent} cwd={cwd} waiting={state === 'waiting'} />
            {result ? null : <Pending call={call} kind={kind} state={state} live={live} />}
          </>
        ) : null}
      </div>
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
